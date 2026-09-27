import './styles.css';
import { DEFAULT_SETTINGS, THEMES, createBookRecord, normalizeLibrary, normalizeSettings, resolveBookSettings } from './store.js';
import { findRestoreIndex, getProgressFromScroll, parseParagraphs, restoreScroll } from './reader.js';

const api = window.novelApi;
const app = document.querySelector('#app');
let library = normalizeLibrary(null);
let activeBook = null;
let activeContent = null;
let paragraphs = [];
let scrollSaveTimer = null;
let toastTimer = null;

async function initialize() {
  if (!api) {
    renderUnsupported();
    return;
  }
  library = normalizeLibrary(await api.loadLibrary());
  await checkBookAvailability();
  renderShelf();
}

async function checkBookAvailability() {
  const checks = await Promise.all(library.books.map((book) => api.inspectBook(book)));
  library.books = library.books.map((book, index) => ({ ...book, unavailable: Boolean(checks[index]?.unavailable) }));
}

function renderShelf() {
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
    paragraphs = parseParagraphs(file.text);
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
  const settings = resolveBookSettings(library.settings, activeBook.settings);
  app.innerHTML = `
    <main class="reader-shell" data-theme="${settings.theme}">
      <header class="reader-toolbar">
        <button class="icon-button toolbar-button" id="back-to-shelf" title="返回书架" aria-label="返回书架">←</button>
        <div class="reader-title">
          <strong>${escapeHtml(activeBook.name)}</strong>
          <span id="reading-percent">${Math.round((activeBook.progress?.ratio || 0) * 100)}%</span>
        </div>
        <button class="icon-button toolbar-button" id="open-settings" title="阅读设置" aria-label="阅读设置">Aa</button>
      </header>
      ${contentChanged ? '<p class="file-change-notice">原文件内容有变化，已按上次位置尽量恢复。</p>' : ''}
      <section class="reader-scroll" id="reader-scroll" tabindex="0">
        <article class="reader-content" id="reader-content">
          ${renderParagraphs()}
        </article>
      </section>
      <div class="reading-progress" aria-hidden="true"><span id="reading-progress-bar"></span></div>
      ${renderSettingsPanel(settings)}
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `;
  bindReaderEvents();
  applyReaderSettings(settings);
  const scroll = document.querySelector('#reader-scroll');
  restoreScroll(scroll, paragraphs, activeBook.progress);
  updateProgressUi(activeBook.progress?.ratio || 0);
}

function renderParagraphs() {
  return paragraphs.map(({ text, index }) => `<p data-paragraph-index="${index}">${escapeHtml(text)}</p>`).join('');
}

function renderSettingsPanel(settings) {
  return `
    <div class="settings-scrim" id="settings-scrim" hidden></div>
    <aside class="settings-panel" id="settings-panel" aria-labelledby="settings-title" aria-hidden="true">
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
    renderShelf();
  });
  document.querySelector('#open-settings').addEventListener('click', () => toggleSettings(true));
  document.querySelector('#close-settings').addEventListener('click', () => toggleSettings(false));
  document.querySelector('#settings-scrim').addEventListener('click', () => toggleSettings(false));
  const scroll = document.querySelector('#reader-scroll');
  scroll.addEventListener('scroll', () => {
    const progress = getProgressFromScroll(scroll, paragraphs);
    updateProgressUi(progress.ratio);
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

async function updateSetting(name, value) {
  const current = resolveBookSettings(library.settings, activeBook.settings);
  activeBook.settings = normalizeSettings({ ...current, [name]: value });
  applyReaderSettings(activeBook.settings);
  if (name === 'theme') {
    document.querySelectorAll('[data-theme-choice]').forEach((button) => button.classList.toggle('is-active', button.dataset.themeChoice === value));
  }
  if (name === 'fontFamily') {
    document.querySelectorAll('[data-font]').forEach((button) => button.classList.toggle('is-active', button.dataset.font === value));
  }
  const output = document.querySelector(`#${name}-output`);
  if (output) output.textContent = `${value}${name === 'fontSize' || name === 'contentWidth' ? 'px' : name === 'paragraphSpacing' ? 'em' : ''}`;
  await persistLibrary();
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
  applyTheme(settings.theme);
}

async function saveCurrentProgress(progress = null) {
  if (!activeBook) return;
  const scroll = document.querySelector('#reader-scroll');
  if (!progress && scroll) progress = getProgressFromScroll(scroll, paragraphs);
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

function toggleSettings(open) {
  const panel = document.querySelector('#settings-panel');
  const scrim = document.querySelector('#settings-scrim');
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  scrim.hidden = !open;
}

function renderLoading(name) {
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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

window.addEventListener('beforeunload', () => {
  if (activeBook) {
    const scroll = document.querySelector('#reader-scroll');
    if (scroll) activeBook.progress = getProgressFromScroll(scroll, paragraphs);
    api.saveLibraryOnExit(library);
  }
});

initialize();
