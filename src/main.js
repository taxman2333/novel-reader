import './styles.css';
import { DEFAULT_SETTINGS, THEMES, createBookRecord, normalizeLibrary, normalizeSettings, resolveBookSettings } from './store.js';
import { createParagraphWindow, detectChapters, escapeHtml, findRestoreIndex, getProgressFromScroll, parseParagraphs } from './reader.js';
import { createReaderScrollbar } from './reader-scrollbar.js';

const api = window.novelApi;
const app = document.querySelector('#app');
let library = normalizeLibrary(null);
let activeBook = null;
let activeContent = null;
let paragraphs = [];
let chapters = [];
let activeChapter = -1;
let activeChapterItem = null;
let chapterRefreshFrame = 0;
let scrollSaveTimer = null;
let toastTimer = null;
// 当前阅读页的段落窗口。见 src/reader.js 的 createParagraphWindow()。
let paragraphWindow = null;
// 当前阅读页右侧的自绘滚动条。见 src/reader-scrollbar.js。
let readerScrollbar = null;
// 设置类改动合并到下一帧、落盘防抖。见 scheduleReaderSettingsApply()。
let settingsFrame = 0;
let persistTimer = null;
// 窗口尺寸变化会改变版心实际宽度，进而让全书的高度估算失效。见下面的 resize 监听。
let resizeFrame = 0;

async function initialize() {
  if (!api) {
    renderUnsupported();
    return;
  }
  library = normalizeLibrary(await api.loadLibrary());
  // 先渲染书架再检查文件可用性：检查要对每本书做一次 stat 的 IPC 往返，
  // 书架里书多时会把首帧一直推迟到全部检查完成之后。先出界面，再补上失效标记。
  renderShelf();
  await checkBookAvailability();
  // 检查期间用户可能已经点进某本书，此时不能把他拉回书架。
  if (!activeBook) renderShelf();
}

async function checkBookAvailability() {
  const checks = await Promise.all(library.books.map((book) => api.inspectBook(book)));
  library.books = library.books.map((book, index) => ({ ...book, unavailable: Boolean(checks[index]?.unavailable) }));
}

function renderShelf() {
  paragraphWindow = null;
  readerScrollbar = null;
  applyTheme(library.settings.theme);
  app.innerHTML = `
    <main class="shelf-shell">
      <header class="shelf-header">
        <div>
          <p class="brand-mark" aria-hidden="true">阅</p>
          <h1>书页之间</h1>
          <p class="shelf-subtitle">你的本地 TXT 书架</p>
        </div>
        <button class="primary-button" id="import-book" type="button">
          <span aria-hidden="true">＋</span> 导入小说
        </button>
      </header>
      <section class="shelf-section" aria-labelledby="shelf-title">
        <div class="section-heading">
          <h2 id="shelf-title">最近阅读</h2>
          <span>${library.books.length} 本</span>
        </div>
        <div class="book-list" id="book-list">
          ${library.books.length ? renderBookList() : renderEmptyShelf()}
        </div>
      </section>
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `;
  document.querySelector('#import-book').addEventListener('click', importBook);
  document.querySelector('#empty-import')?.addEventListener('click', importBook);
  document.querySelectorAll('[data-action="open"]').forEach((button) => button.addEventListener('click', () => openBook(button.dataset.id)));
  document.querySelectorAll('[data-action="locate"]').forEach((button) => button.addEventListener('click', () => relocateBook(button.dataset.id)));
  document.querySelectorAll('[data-action="remove"]').forEach((button) => button.addEventListener('click', () => removeBook(button.dataset.id)));
}

function renderBookList() {
  return [...library.books]
    .sort((a, b) => new Date(b.lastOpenedAt || 0) - new Date(a.lastOpenedAt || 0))
    .map((book, index) => {
      const progress = Math.round((book.progress?.ratio || 0) * 100);
      const initial = book.name.trim().slice(0, 1) || '书';
      return `
        <article class="book-row ${book.unavailable ? 'is-unavailable' : ''}">
          <button class="book-main" data-action="open" data-id="${escapeAttribute(book.id)}" ${book.unavailable ? 'disabled' : ''}>
            <span class="book-spine tone-${index % 4}" aria-hidden="true">${escapeHtml(initial)}</span>
            <span class="book-details">
              <strong>${escapeHtml(book.name)}</strong>
              <small>${book.unavailable ? '原文件不可用' : `上次阅读 ${formatDate(book.lastOpenedAt)}`}</small>
              <span class="progress-track"><span style="width:${progress}%"></span></span>
              <em>${progress}%</em>
            </span>
          </button>
          <div class="book-actions">
            ${book.unavailable ? `<button class="text-button" data-action="locate" data-id="${escapeAttribute(book.id)}">重新定位</button>` : ''}
            <button class="icon-button" title="从书架移除" aria-label="从书架移除 ${escapeAttribute(book.name)}" data-action="remove" data-id="${escapeAttribute(book.id)}">×</button>
          </div>
        </article>
      `;
    }).join('');
}

function renderEmptyShelf() {
  return `
    <div class="empty-shelf">
      <span class="empty-glyph" aria-hidden="true">文</span>
      <h3>书架还是空的</h3>
      <p>选择电脑上的 TXT 文件。小说保留在原位置，应用只记录路径和阅读进度。</p>
      <button class="secondary-button" id="empty-import" type="button">选择 TXT 文件</button>
    </div>
  `;
}

async function importBook() {
  try {
    const file = await api.chooseBook();
    if (!file) return;
    const existing = library.books.find((book) => book.path === file.path);
    if (existing) {
      await openBook(existing.id);
      return;
    }
    const record = createBookRecord(file, file.text);
    library.books.push(record);
    await persistLibrary();
    renderShelf();
    await openBook(record.id, file);
  } catch (error) {
    showError(error);
  }
}

async function openBook(bookId, loadedFile = null) {
  const book = library.books.find((item) => item.id === bookId);
  if (!book) return;
  try {
    renderLoading(book.name);
    const file = loadedFile || await api.readBook(book.path);
    activeBook = book;
    activeContent = file;
    // readTxtFile 返回的 text 已经过 electron/book-service.js 的 normalizeText。
    paragraphs = parseParagraphs(file.text, { normalized: true });
    chapters = detectChapters(paragraphs);
    activeChapter = -1;
    activeChapterItem = null;
    const changed = book.fingerprint && book.fingerprint !== file.fingerprint;
    book.unavailable = false;
    book.lastOpenedAt = new Date().toISOString();
    book.size = file.size;
    book.modifiedAt = file.modifiedAt;
    book.fingerprint = file.fingerprint;
    book.encoding = file.encoding;
    renderReader(changed);
    await persistLibrary();
  } catch (error) {
    book.unavailable = true;
    await persistLibrary();
    renderShelf();
    showError(error, '无法打开文件。请确认文件仍在原位置，或重新定位。');
  }
}

function renderReader(contentChanged = false) {
  // 整个外壳会被重建，旧窗口持有的元素随即脱离文档，必须先丢掉它，
  // 否则下面 applyReaderSettings() 会对着脱离文档的元素重排一次。
  paragraphWindow = null;
  readerScrollbar = null;
  const settings = resolveBookSettings(library.settings, activeBook.settings);
  app.innerHTML = `
    <main class="reader-shell" data-theme="${settings.theme}">
      <header class="reader-toolbar">
        <div class="toolbar-left">
          <button class="icon-button toolbar-button" id="back-to-shelf" title="返回书架" aria-label="返回书架">←</button>
          <button class="icon-button toolbar-button toolbar-label-button" id="open-toc" title="目录" aria-label="目录">目录</button>
        </div>
        <div class="reader-title">
          <strong>${escapeHtml(activeBook.name)}</strong>
          <span id="reading-percent">${Math.round((activeBook.progress?.ratio || 0) * 100)}%</span>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button toolbar-button" id="open-settings" title="阅读设置" aria-label="阅读设置">Aa</button>
        </div>
      </header>
      ${contentChanged ? '<p class="file-change-notice">原文件内容有变化，已按上次位置尽量恢复。</p>' : ''}
      <div class="reader-viewport">
        <section class="reader-scroll" id="reader-scroll" tabindex="0">
          <article class="reader-content" id="reader-content" data-paragraph-count="${paragraphs.length}"></article>
        </section>
        <div class="reader-scrollbar" id="reader-scrollbar" role="scrollbar" aria-label="阅读位置" aria-controls="reader-scroll" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <span class="reader-scrollbar-thumb" id="reader-scrollbar-thumb"></span>
        </div>
      </div>
      <div class="reading-progress" aria-hidden="true"><span id="reading-progress-bar"></span></div>
      ${renderTocPanel()}
      ${renderSettingsPanel(settings)}
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `;
  bindReaderEvents();
  // 先写样式变量再建窗口：段落高度估算读的就是当前字号与版心宽度。
  applyReaderSettings(settings);
  paragraphWindow = createParagraphWindow({
    scroll: document.querySelector('#reader-scroll'),
    content: document.querySelector('#reader-content'),
    paragraphs,
  });
  paragraphWindow.setLayout(readerLayout(settings));
  // 恢复阅读位置：把目标段落对齐到视口顶部。窗口会围着它重建，
  // 因此屏幕外的段落不需要存在于 DOM 里，也不再有 scrollIntoView。
  paragraphWindow.scrollToIndex(findRestoreIndex(paragraphs, activeBook.progress));
  // 滚动条要在位置恢复之后再建：它的长度和位置都是按 scrollTop/scrollHeight 现算的。
  readerScrollbar = createReaderScrollbar({
    scroll: document.querySelector('#reader-scroll'),
    track: document.querySelector('#reader-scrollbar'),
    thumb: document.querySelector('#reader-scrollbar-thumb'),
    // 拖动与翻屏会一次跨过几百段，落在窗口之外；立刻重建一次，
    // 免得中间那一帧露出还没换上内容的空白区（与目录面板的进度滑条同一处理）。
    onJump: () => paragraphWindow?.syncViewport(),
  });
  readerScrollbar.sync();
  updateProgressUi(activeBook.progress?.ratio || 0);
}

// 段落高度估算只关心这几个参数；版心宽度由窗口从 DOM 实测（窗口窄的时候
// min(var(--content-width), calc(100% - 56px)) 取到的不是设置值）。
function readerLayout(settings) {
  return {
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    paragraphSpacing: settings.paragraphSpacing,
    indent: settings.indent,
  };
}

function renderTocPanel() {
  return `
    <div class="panel-scrim" id="toc-scrim" hidden></div>
    <aside class="side-panel side-panel--left" id="toc-panel" aria-labelledby="toc-title" aria-hidden="true">
      <div class="panel-header">
        <h2 id="toc-title">目录</h2>
        <button class="icon-button" id="close-toc" aria-label="关闭目录">×</button>
      </div>
      ${chapters.length ? renderChapterList() : renderTocFallback()}
    </aside>
  `;
}

function renderChapterList() {
  return `
    <p class="toc-count">共 ${chapters.length} 章</p>
    <ol class="toc-list" id="toc-list">
      ${chapters.map((chapter) => `
        <li><button class="toc-item" data-chapter-index="${chapter.index}" title="${escapeAttribute(chapter.title)}">${escapeHtml(chapter.title)}</button></li>
      `).join('')}
    </ol>
  `;
}

// 章节识别失败时的降级：不阻断阅读，至少提供按进度定位的手段。
function renderTocFallback() {
  const percent = Math.round((activeBook.progress?.ratio || 0) * 100);
  return `
    <div class="toc-empty">
      <p>这本书没有识别到「第X章」形式的章节标题。</p>
      <p class="toc-hint">可以按阅读进度大致定位，也可以直接关闭本面板继续阅读。</p>
    </div>
    <label class="setting-group range-row"><span class="setting-label">按进度跳转<output id="toc-percent-output">${percent}%</output></span><input id="toc-percent" type="range" min="0" max="100" step="1" value="${percent}"></label>
  `;
}

function renderSettingsPanel(settings) {
  return `
    <div class="panel-scrim" id="settings-scrim" hidden></div>
    <aside class="side-panel" id="settings-panel" aria-labelledby="settings-title" aria-hidden="true">
      <div class="panel-header">
        <h2 id="settings-title">阅读设置</h2>
        <button class="icon-button" id="close-settings" aria-label="关闭阅读设置">×</button>
      </div>
      <div class="setting-group theme-group">
        <span class="setting-label">背景</span>
        <div class="theme-options">
          ${Object.entries(THEMES).map(([key, label]) => `<button class="theme-swatch ${settings.theme === key ? 'is-active' : ''}" data-theme-choice="${key}" title="${label}" aria-label="${label}"><span class="swatch-${key}"></span><small>${label.replace('日间', '').replace('夜间', '')}</small></button>`).join('')}
        </div>
      </div>
      ${rangeSetting('fontSize', '字号', settings.fontSize, 14, 32, 1, 'px')}
      ${rangeSetting('lineHeight', '行距', settings.lineHeight, 1.4, 2.6, 0.1, '')}
      ${rangeSetting('paragraphSpacing', '段距', settings.paragraphSpacing, 0, 2, 0.1, 'em')}
      ${rangeSetting('contentWidth', '版心宽度', settings.contentWidth, 560, 920, 20, 'px')}
      <div class="setting-group setting-inline">
        <span class="setting-label">字体</span>
        <div class="segmented-control">
          <button data-font="serif" class="${settings.fontFamily === 'serif' ? 'is-active' : ''}">宋体</button>
          <button data-font="sans" class="${settings.fontFamily === 'sans' ? 'is-active' : ''}">黑体</button>
        </div>
      </div>
      <label class="setting-group switch-row"><span>段首缩进</span><input type="checkbox" id="indent-setting" ${settings.indent ? 'checked' : ''}><i></i></label>
      <button class="reset-button" id="reset-settings">恢复默认设置</button>
    </aside>
  `;
}

function rangeSetting(name, label, value, min, max, step, unit) {
  return `<label class="setting-group range-row"><span class="setting-label">${label}<output id="${name}-output">${value}${unit}</output></span><input id="${name}-setting" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}

function bindReaderEvents() {
  document.querySelector('#back-to-shelf').addEventListener('click', async () => {
    await saveCurrentProgress();
    activeBook = null;
    activeContent = null;
    paragraphs = [];
    paragraphWindow = null;
    readerScrollbar = null;
    chapters = [];
    activeChapter = -1;
    activeChapterItem = null;
    renderShelf();
  });
  document.querySelector('#open-settings').addEventListener('click', () => togglePanel('settings', true));
  document.querySelector('#close-settings').addEventListener('click', () => togglePanel('settings', false));
  document.querySelector('#settings-scrim').addEventListener('click', () => togglePanel('settings', false));
  document.querySelector('#open-toc').addEventListener('click', () => {
    togglePanel('toc', true);
    refreshActiveChapter(true);
  });
  document.querySelector('#close-toc').addEventListener('click', () => togglePanel('toc', false));
  document.querySelector('#toc-scrim').addEventListener('click', () => togglePanel('toc', false));
  document.querySelectorAll('#toc-list [data-chapter-index]').forEach((button) => {
    button.addEventListener('click', () => jumpToChapter(Number(button.dataset.chapterIndex)));
  });
  const percentInput = document.querySelector('#toc-percent');
  if (percentInput) {
    percentInput.addEventListener('input', () => {
      const scroll = document.querySelector('#reader-scroll');
      const ratio = Number(percentInput.value) / 100;
      scroll.scrollTop = ratio * Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      // 滚动事件要等下一个任务才到，而拖动时每一帧都可能在新的位置重建窗口。
      // 这里立刻同步一次，避免中间那一帧露出还没换上内容的空白区。
      paragraphWindow?.syncViewport();
      readerScrollbar?.sync();
      document.querySelector('#toc-percent-output').textContent = `${percentInput.value}%`;
    });
  }
  const scroll = document.querySelector('#reader-scroll');
  scroll.addEventListener('scroll', () => {
    // 先重建窗口：窗口变化会微调 scrollTop 把落点钉住，之后算出来的进度才是最终值。
    paragraphWindow?.syncViewport();
    // 滚动条同理，放在窗口重建之后：要跟上被钉住的那个位置。
    readerScrollbar?.sync();
    const progress = currentProgress();
    updateProgressUi(progress.ratio);
    scheduleActiveChapterRefresh();
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => saveCurrentProgress(progress), 500);
  }, { passive: true });
  for (const name of ['fontSize', 'lineHeight', 'paragraphSpacing', 'contentWidth']) {
    document.querySelector(`#${name}-setting`).addEventListener('input', (event) => updateSetting(name, Number(event.target.value)));
  }
  document.querySelector('#indent-setting').addEventListener('change', (event) => updateSetting('indent', event.target.checked));
  document.querySelectorAll('[data-font]').forEach((button) => button.addEventListener('click', () => updateSetting('fontFamily', button.dataset.font)));
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => updateSetting('theme', button.dataset.themeChoice)));
  document.querySelector('#reset-settings').addEventListener('click', () => {
    activeBook.settings = { ...DEFAULT_SETTINGS };
    renderReader();
    persistLibrary();
  });
}

function updateSetting(name, value) {
  const current = resolveBookSettings(library.settings, activeBook.settings);
  activeBook.settings = normalizeSettings({ ...current, [name]: value });
  scheduleReaderSettingsApply();
  // 面板上的按钮态与数值显示必须跟手，且都只动一两个节点，保持同步更新。
  if (name === 'theme') {
    document.querySelectorAll('[data-theme-choice]').forEach((button) => button.classList.toggle('is-active', button.dataset.themeChoice === value));
  }
  if (name === 'fontFamily') {
    document.querySelectorAll('[data-font]').forEach((button) => button.classList.toggle('is-active', button.dataset.font === value));
  }
  const output = document.querySelector(`#${name}-output`);
  if (output) output.textContent = `${value}${name === 'fontSize' || name === 'contentWidth' ? 'px' : name === 'paragraphSpacing' ? 'em' : ''}`;
  schedulePersistLibrary();
}

// 拖动滑条时 input 事件一帧内可以触发多次，而这里的每一个自定义属性都被全部段落继承、
// 又参与段落的 `font` 简写，改一次就是一次整篇重排（实测 13 万段约 980 ms）。
// 合并到下一帧，一帧只重排一次。
//
// 落地时读的是 activeBook.settings 的当前值而不是入队时的快照：快速拖动时最后落地的
// 一定是最新值，不会出现「松手后停在中间某个位置」。
function scheduleReaderSettingsApply() {
  if (settingsFrame) return;
  settingsFrame = requestAnimationFrame(() => {
    settingsFrame = 0;
    if (activeBook) applyReaderSettings(activeBook.settings);
  });
}

function applyReaderSettings(settings) {
  const root = document.querySelector('.reader-shell');
  if (!root) return;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--reader-line-height', settings.lineHeight);
  root.style.setProperty('--paragraph-gap', `${settings.paragraphSpacing}em`);
  root.style.setProperty('--content-width', `${settings.contentWidth}px`);
  root.dataset.font = settings.fontFamily;
  root.dataset.indent = settings.indent ? 'true' : 'false';
  // applyTheme 写的是 documentElement，与 .reader-shell 上的自定义属性无关。
  // 改字号时主题并没有变，没有必要每帧重复写一次。
  if (document.documentElement.dataset.theme !== (settings.theme || 'warm')) applyTheme(settings.theme);
  // 字号/行距/段距/版心宽度都会改变段落高度：重估全书 → 只重排窗口内那几百段。
  paragraphWindow?.setLayout(readerLayout(settings));
  // 全书高度变了，滑块的换算比例也跟着变（宽度变化不触发 scroll 事件）。
  readerScrollbar?.sync();
}

// 当前阅读进度。段落索引查偏移表，因此不受段落长短不均的影响。
function currentProgress() {
  const scroll = document.querySelector('#reader-scroll');
  if (!scroll) return null;
  return getProgressFromScroll(scroll, paragraphs, paragraphWindow?.offsets() || null);
}

async function saveCurrentProgress(progress = null) {
  if (!activeBook) return;
  if (!progress) progress = currentProgress();
  if (progress) activeBook.progress = progress;
  await persistLibrary();
}

function updateProgressUi(ratio) {
  const value = Math.round(ratio * 100);
  const label = document.querySelector('#reading-percent');
  const bar = document.querySelector('#reading-progress-bar');
  if (label) label.textContent = `${value}%`;
  if (bar) bar.style.width = `${value}%`;
}

async function relocateBook(bookId) {
  const book = library.books.find((item) => item.id === bookId);
  if (!book) return;
  try {
    const file = await api.chooseBook();
    if (!file) return;
    const looksDifferent = file.fingerprint !== book.fingerprint;
    if (looksDifferent && !window.confirm('所选文件与原小说内容不同。仍要用它替换这条书架记录吗？')) return;
    book.path = file.path;
    book.id = file.path;
    book.fileName = file.name;
    book.size = file.size;
    book.modifiedAt = file.modifiedAt;
    book.fingerprint = file.fingerprint;
    book.encoding = file.encoding;
    book.unavailable = false;
    await persistLibrary();
    renderShelf();
    showToast('文件位置已更新');
  } catch (error) {
    showError(error);
  }
}

async function removeBook(bookId) {
  const book = library.books.find((item) => item.id === bookId);
  if (!book || !window.confirm(`从书架移除《${book.name}》？电脑上的 TXT 文件不会被删除。`)) return;
  library.books = library.books.filter((item) => item.id !== bookId);
  await api.removeBook(bookId);
  renderShelf();
  showToast('已从书架移除');
}

async function persistLibrary() {
  // Do not call normalizeLibrary() here: it rebuilds every book object, which
  // detaches activeBook from library.books. Later writes to activeBook.settings
  // and activeBook.progress would then be saved from a stale object and lost.
  // Data is normalized once on load, and settings are normalized where written.
  await api.saveLibrary(library);
}

// 只给「连续改值」的设置路径用（拖滑条、切主题）：这类改动一次落盘 1~2 ms，
// 但拖动期间一秒能触发几十次，没必要每次都写磁盘。
// 结构类改动（导入、移除、重新定位、打开书籍）必须继续立即落盘——它们改的是书架本身，
// 晚一拍就可能在异常退出时整条记录丢失。
// 退出时的最后一份数据由 beforeunload 直接交出去，不依赖这个定时器。
function schedulePersistLibrary() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistLibrary();
  }, 400);
}

// 目录与阅读设置共用同一个抽屉形态，同时只允许打开一个。
const PANEL_IDS = { settings: 'settings-panel', toc: 'toc-panel' };

function togglePanel(name, open) {
  for (const [key, id] of Object.entries(PANEL_IDS)) {
    const isOpen = open && key === name;
    const panel = document.querySelector(`#${id}`);
    const scrim = document.querySelector(`#${id.replace('-panel', '-scrim')}`);
    panel.classList.toggle('is-open', isOpen);
    panel.setAttribute('aria-hidden', String(!isOpen));
    scrim.hidden = !isOpen;
  }
}

// 视口顶部所属的章节序号。章节按 paragraphIndex 递增，取最后一个不超过当前段落的。
function currentChapterIndex(paragraphIndex) {
  let found = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].paragraphIndex > paragraphIndex) break;
    found = i;
  }
  return found;
}

// 滚动事件一帧内可以触发多次。窗口化之后定位只查偏移表、不再测量几何，
// 但章节高亮要沿 chapters 线性找一遍，仍然收敛到每帧最多一次。
function scheduleActiveChapterRefresh() {
  if (chapterRefreshFrame) return;
  chapterRefreshFrame = requestAnimationFrame(() => {
    chapterRefreshFrame = 0;
    refreshActiveChapter();
  });
}

// 高亮当前章节。只在章节变化时改 DOM。
function refreshActiveChapter(reveal = false) {
  if (!chapters.length || !paragraphWindow) return;
  const next = currentChapterIndex(paragraphWindow.topIndex());
  if (next !== activeChapter) {
    if (activeChapterItem) activeChapterItem.classList.remove('is-active');
    activeChapter = next;
    activeChapterItem = document.querySelector(`#toc-list [data-chapter-index="${next}"]`);
    if (activeChapterItem) activeChapterItem.classList.add('is-active');
  }
  // 只在面板打开时滚动列表，避免在阅读过程中无谓地动面板里的滚动位置。
  if (reveal && activeChapterItem) activeChapterItem.scrollIntoView({ block: 'nearest' });
}

function jumpToChapter(index) {
  const chapter = chapters[index];
  if (!chapter || !paragraphWindow) return;
  // 直接把目标段落顶到视口顶部：位置由偏移表算出，因此目标章节不需要
  // （通常也不会）已经在 DOM 里——跨几百章的跳转和翻一页是同一件事。
  paragraphWindow.scrollToIndex(chapter.paragraphIndex);
  togglePanel('toc', false);
}

function renderLoading(name) {
  paragraphWindow = null;
  readerScrollbar = null;
  app.innerHTML = `<main class="loading-view"><span></span><p>正在打开《${escapeHtml(name)}》</p></main>`;
}

function renderUnsupported() {
  app.innerHTML = '<main class="unsupported"><h1>请在桌面应用中打开</h1><p>浏览器预览无法访问本地小说文件。</p></main>';
}

function showError(error, fallback = '操作没有完成，请重试。') {
  console.error(error);
  showToast(error?.message || fallback, true);
}

function showToast(message, isError = false) {
  let toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'warm';
}

function formatDate(value) {
  if (!value) return '尚未阅读';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
}

// escapeHtml 来自 src/reader.js：窗口化渲染要在那里拼段落标记，两处必须是同一份实现。
const escapeAttribute = escapeHtml;

window.addEventListener('beforeunload', () => {
  if (activeBook) {
    const progress = currentProgress();
    if (progress) activeBook.progress = progress;
    api.saveLibraryOnExit(library);
  }
});

// 窗口尺寸变化会改变版心的实测宽度（min(设置宽度, 窗口宽 - 56px)），
// 全书的高度估算随之失效，必须重估并重排窗口。像拖动窗口边缘这种连续变化
// 收敛到每帧一次。
window.addEventListener('resize', () => {
  if (!paragraphWindow || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (paragraphWindow && activeBook) {
      paragraphWindow.setLayout(readerLayout(resolveBookSettings(library.settings, activeBook.settings)));
      // 轨道高度跟着窗口走，重排之后重新算一次滑块长度与位置。
      readerScrollbar?.sync();
    }
  });
});

initialize();
