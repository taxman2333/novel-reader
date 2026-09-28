import * as ui from './harness.mjs';

// 与 src/styles.css 中 .reader-shell[data-theme="..."] 的 --reader-bg 一一对应。
const THEME_BG = {
  white: '#f7f8f6',
  warm: '#f1ede4',
  green: '#e7eee3',
  night: '#2d302f',
};

// 与 electron/preload.mjs 暴露的方法一一对应，用于检测 mock 漂移。
const EXPECTED_API_KEYS = [
  'chooseBook',
  'inspectBook',
  'loadLibrary',
  'readBook',
  'removeBook',
  'saveLibrary',
  'saveLibraryOnExit',
];

const SCROLL_TARGET = 4000;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

// 正文段落。章节标题带 .reader-chapter，字号比正文大 30% 且居中（见 src/styles.css），
// 所以「正文字号」这类断言必须显式排除它——夹具的首段恰好就是章节标题。
const BODY_PARAGRAPH = "#reader-content p:not(.reader-chapter)";

// 从书架进入第一本书的阅读页。所有阅读器相关的断言都从这里出发。
async function openFirstBook(win) {
  await ui.waitFor(win, "return Boolean(document.querySelector('.book-main'));", { label: '书架出现可打开的书籍' });
  await ui.click(win, '.book-main');
  await ui.waitFor(win, "return Boolean(document.querySelector('.reader-shell'));", { label: '进入阅读页' });
  await ui.disableSmoothScroll(win);
  await ui.waitFor(win, "return document.querySelectorAll('#reader-content p').length > 0;", { label: '正文渲染完成' });
  // 恢复位置之后窗口可能还会重建一次，必须等滚动落定再手动滚动，否则两者会互相覆盖。
  await ui.waitForStableScroll(win);
}

async function panelRect(win, selector) {
  return ui.evaluate(win, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { left: Math.round(rect.left), right: Math.round(rect.right) };
  `);
}

// 面板的滑入/滑出是靠 transform 过渡完成的，点完按钮后位置不会立刻落定。
// 轮询到目标位置再断言，否则断言会在动画中途取值而随机失败。
async function waitForPanelRect(win, selector, predicate, label) {
  let last = null;
  try {
    await ui.waitUntil(async () => {
      last = await panelRect(win, selector);
      return Boolean(last) && predicate(last);
    }, { label });
  } catch (error) {
    throw new Error(`${error.message}，实际测得 ${last ? JSON.stringify(last) : 'null'}`);
  }
  return last;
}

const SPECS = [
  {
    name: 'api-surface',
    seed: 'empty',
    async run({ win }) {
      const { keys, missing } = await ui.evaluate(win, `
        const api = window.novelApi || {};
        const expected = ${JSON.stringify(EXPECTED_API_KEYS)};
        return {
          keys: Object.keys(api),
          missing: expected.filter((name) => typeof api[name] !== 'function'),
        };
      `);
      if (missing.length) throw new Error(`novelApi 缺少方法：${missing.join(', ')}`);
      // contextBridge 暴露的对象在部分 Electron 版本下不可枚举。
      // 只有在能枚举时才做双向比对，避免因枚举性差异产生误报。
      if (keys.length) {
        const extra = keys.filter((key) => !EXPECTED_API_KEYS.includes(key));
        const absent = EXPECTED_API_KEYS.filter((key) => !keys.includes(key));
        if (extra.length || absent.length) {
          throw new Error(`novelApi 与 electron/preload.mjs 不一致：多出 [${extra.join(', ')}]，缺少 [${absent.join(', ')}]`);
        }
      }
      return `${EXPECTED_API_KEYS.length} 个方法齐全，可枚举键 ${keys.length} 个`;
    },
  },

  {
    name: 'shelf-empty',
    seed: 'empty',
    async run({ win, mock }) {
      const exists = await ui.evaluate(win, "return Boolean(document.querySelector('#empty-import'));");
      assertTrue(exists, '空书架应渲染出 #empty-import 按钮');
      await ui.click(win, '#empty-import');
      // 这里曾经漏绑事件处理器，按钮点了没反应。
      await ui.waitUntil(() => mock.state.calls.chooseBook === 1, { label: '点击「选择 TXT 文件」应调用 chooseBook' });
      return '空状态引导按钮已正确绑定导入事件';
    },
  },

  {
    name: 'import',
    seed: 'empty',
    async run({ win, mock }) {
      mock.queueChoose();
      await ui.click(win, '#import-book');
      await ui.waitFor(win, "return Boolean(document.querySelector('.reader-shell'));", { label: '导入后应自动进入阅读页' });
      // 段落数取自 data-paragraph-count（整本），而不是 DOM 里的 <p> 数量：
      // 窗口化渲染之后 DOM 里只有视口附近的那几百段。
      const paragraphs = await ui.evaluate(win, `
        const content = document.querySelector('#reader-content');
        return { total: Number(content.dataset.paragraphCount), dom: content.querySelectorAll('p').length };
      `);
      assertTrue(paragraphs.total > 100, `导入后正文应有内容，实际段落数 ${paragraphs.total}`);
      assertTrue(paragraphs.dom > 0, '导入后应立刻渲染出正文');

      await ui.click(win, '#back-to-shelf');
      await ui.waitFor(win, "return Boolean(document.querySelector('.shelf-shell'));", { label: '返回书架' });
      const shelf = await ui.evaluate(win, `
        return {
          rows: document.querySelectorAll('.book-row').length,
          title: document.querySelector('.book-details strong')?.textContent ?? null,
        };
      `);
      assertEqual(shelf.rows, 1, '书架应有 1 条记录');
      assertEqual(shelf.title, '测试小说', '书架应显示书名');
      return `导入后正文 ${paragraphs.total} 段（DOM 中 ${paragraphs.dom} 段），书架 1 条记录`;
    },
  },

  {
    name: 'toolbar-fixed',
    seed: 'book',
    async run({ win }) {
      await openFirstBook(win);
      const scrolled = await ui.scrollReaderTo(win, SCROLL_TARGET);
      assertTrue(scrolled >= SCROLL_TARGET, `正文应能滚动到 ${SCROLL_TARGET}，实际 ${scrolled}——若滚动未生效，下面的工具栏断言会因为错误的原因通过`);
      await ui.delay(150);

      const geometry = await ui.evaluate(win, `
        const toolbar = document.querySelector('.reader-toolbar');
        const scroll = document.querySelector('#reader-scroll');
        const rect = toolbar.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          scrollTop: Math.round(scroll.scrollTop),
          viewport: window.innerHeight,
        };
      `);
      // 先确认滚动真的发生了，否则「工具栏在顶部」是空转通过。
      assertTrue(geometry.scrollTop >= SCROLL_TARGET, `滚动应已生效，实际 scrollTop=${geometry.scrollTop}`);
      assertEqual(geometry.top, 0, '滚动后工具栏 top 应为 0（不随正文滚走）');
      assertTrue(geometry.bottom <= geometry.viewport, `工具栏应完整位于视口内，实际 bottom=${geometry.bottom} viewport=${geometry.viewport}`);
      return `scrollTop=${geometry.scrollTop} 时工具栏 top=${geometry.top}`;
    },
  },

  {
    name: 'theme-switch',
    seed: 'book',
    async run({ win }) {
      await openFirstBook(win);
      await ui.click(win, '#open-settings');
      const seen = {};
      for (const theme of Object.keys(THEME_BG)) {
        await ui.click(win, `[data-theme-choice="${theme}"]`);
        await ui.waitFor(win, `return document.querySelector('.reader-shell')?.dataset.theme === ${JSON.stringify(theme)};`, { label: `切换到主题 ${theme}` });
        const actual = await ui.evaluate(win, `
          const shell = document.querySelector('.reader-shell');
          return {
            shellTheme: shell.dataset.theme,
            docTheme: document.documentElement.dataset.theme,
            bg: getComputedStyle(shell).getPropertyValue('--reader-bg').trim(),
            active: document.querySelector('[data-theme-choice="${theme}"]').classList.contains('is-active'),
          };
        `);
        assertEqual(actual.shellTheme, theme, `主题 ${theme}：阅读区 data-theme 未同步`);
        assertEqual(actual.docTheme, theme, `主题 ${theme}：应用背景 data-theme 未同步`);
        assertEqual(actual.bg, THEME_BG[theme], `主题 ${theme}：--reader-bg 取值不符`);
        assertTrue(actual.active, `主题 ${theme}：色块未处于选中态`);
        seen[theme] = actual.bg;
      }
      const distinct = new Set(Object.values(seen)).size;
      assertEqual(distinct, 4, `四套主题的背景色应有 4 种不同取值，实际 ${distinct} 种`);
      return `四种主题背景：${Object.values(seen).join(' / ')}`;
    },
  },

  {
    name: 'settings-persist',
    seed: 'book',
    async run({ win, mock }) {
      await openFirstBook(win);
      await ui.click(win, '#open-settings');
      await ui.setRange(win, '#fontSize-setting', 26);
      await ui.waitFor(win, `
        const p = document.querySelector('${BODY_PARAGRAPH}');
        return p ? getComputedStyle(p).fontSize === '26px' : false;
      `, { label: '字号应即时生效为 26px' });

      // 关键：必须检查保存载荷。只看「返回书架再打开」是不够的——
      // 渲染进程的 library 变量一直在内存里，即使 saveLibrary 完全失效也会通过。
      await ui.waitUntil(
        () => mock.lastSave()?.books?.[0]?.settings?.fontSize === 26,
        { label: '保存载荷中应写入 books[0].settings.fontSize = 26' },
      );

      // 冷启动：重新加载窗口后设置必须还在。这正是当初那个 Bug 的真实形态——
      // persistLibrary() 如果重建书籍对象，activeBook 会与 library.books[i] 脱钩，
      // 保存出去的载荷里 settings 仍是 null。
      await ui.reload(win);
      await ui.waitFor(win, ui.firstPaintCondition, { label: '重启后回到书架' });
      await openFirstBook(win);

      const after = await ui.evaluate(win, `
        const p = document.querySelector('${BODY_PARAGRAPH}');
        return {
          fontSize: p ? getComputedStyle(p).fontSize : null,
          slider: document.querySelector('#fontSize-setting')?.value ?? null,
        };
      `);
      assertEqual(after.fontSize, '26px', '冷启动后重新打开，字号应仍为 26px');
      assertEqual(after.slider, '26', '设置面板滑块应反映已保存的字号');
      return '保存载荷写入正确，冷启动后设置仍在';
    },
  },

  {
    name: 'progress-persist',
    seed: 'book',
    async run({ win, mock }) {
      await openFirstBook(win);
      const scrolled = await ui.scrollReaderTo(win, SCROLL_TARGET);
      assertTrue(scrolled >= SCROLL_TARGET, `正文应能滚动到 ${SCROLL_TARGET}，实际 ${scrolled}`);

      // 等防抖保存真正落盘，而不是「任意一次 ratio > 0 的保存」：
      // 打开书籍本身也会 persistLibrary，只看 ratio 会抓到更早的那次。
      await ui.waitUntil(
        () => (mock.lastSave()?.books?.[0]?.progress?.paragraphIndex ?? 0) > 0,
        { label: '滚动停止后应防抖保存阅读进度' },
      );
      const saved = mock.lastSave().books[0].progress;
      assertTrue(saved.paragraphIndex > 0, `保存的段落索引应大于 0，实际 ${saved.paragraphIndex}`);

      await ui.click(win, '#back-to-shelf');
      await ui.waitFor(win, "return Boolean(document.querySelector('.shelf-shell'));", { label: '返回书架' });
      await openFirstBook(win);

      // 比较语义位置而非像素：恢复位置是把目标段落对齐到视口顶部，
      // 恢复后的 scrollTop 天然不等于保存前的 scrollTop。
      let restored = null;
      try {
        await ui.waitUntil(async () => {
          restored = await ui.topParagraphIndex(win);
          return restored.index === saved.paragraphIndex;
        }, { label: `恢复后视口顶部应为第 ${saved.paragraphIndex} 段` });
      } catch (error) {
        throw new Error(`${error.message}，实际顶部为第 ${restored?.index} 段（正文共 ${restored?.total} 段）`);
      }

      return `保存于第 ${saved.paragraphIndex} 段（${Math.round(saved.ratio * 100)}%），恢复后顶部为第 ${restored.index} 段`;
    },
  },

  {
    // 窗口化渲染只在书比窗口大时才看得见，所以这条用 4000 段的夹具：
    // 其余几条的 200 段夹具整本都塞得进窗口，跑不出窗口边界，
    // 拿它们断言「DOM 里段落数有上限」会无条件通过，等于没测。
    name: 'windowing',
    seed: 'book',
    text: 'large',
    async run({ win }) {
      await openFirstBook(win);

      // 整本段数与当前 DOM 段数、底部垫片高度。三样一起取，避免中途状态漂移。
      const state = `
        const content = document.querySelector('#reader-content');
        const spacer = content.querySelector('[data-spacer="bottom"]');
        return {
          total: Number(content.dataset.paragraphCount),
          dom: content.querySelectorAll('p').length,
          spacer: Math.round(spacer.getBoundingClientRect().height),
        };
      `;

      // ── 首屏：屏幕外的段落没有进 DOM，高度由垫片撑着 ────────────────
      const initial = await ui.evaluate(win, state);
      // 夹具每 20 段插一个章节标题：4000 段正文 + 200 段标题。
      assertEqual(initial.total, 4200, '夹具应为 4200 段（4000 正文 + 200 章节标题）');
      assertTrue(initial.dom > 0, '首屏应有正文');
      assertTrue(initial.dom < 700, `DOM 里的段落数应有上限，实际 ${initial.dom} 段`);
      assertTrue(initial.spacer > 100000, `未渲染部分应由底部垫片撑出高度，实际 ${initial.spacer}px`);

      // ── 跳到很远的一章：目标段落本来不在 DOM 里，位置由偏移表算出 ──
      await ui.click(win, '#open-toc');
      await ui.waitFor(win, "return Boolean(document.querySelector('#toc-panel.is-open'));", { label: '目录面板应打开' });
      const target = 150;
      const title = await ui.evaluate(win, `
        return document.querySelector('#toc-list [data-chapter-index="${target}"]').textContent.trim();
      `);
      await ui.click(win, `#toc-list [data-chapter-index="${target}"]`);
      let top = null;
      try {
        await ui.waitUntil(async () => {
          top = await ui.topParagraphIndex(win);
          return top.text === title;
        }, { label: `跳转后视口顶部应为「${title}」` });
      } catch (error) {
        throw new Error(`${error.message}，实际顶部为「${top?.text}」`);
      }
      const jumped = await ui.evaluate(win, state);
      assertTrue(jumped.dom < 700, `跳转后 DOM 里的段落数仍应有上限，实际 ${jumped.dom} 段`);

      // ── 改字号：重排窗口而不是全篇，且落点不漂 ──────────────────────
      await ui.click(win, '#open-settings');
      await ui.setRange(win, '#fontSize-setting', 26);
      await ui.waitFor(win, `
        const p = document.querySelector('${BODY_PARAGRAPH}');
        return p ? getComputedStyle(p).fontSize === '26px' : false;
      `, { label: '字号应即时生效为 26px' });
      // 字号一改，段高估算和整个窗口都要重来；视口顶部那一段必须还在原处，
      // 否则「改完设置就找不到读到哪了」——这正是窗口化最容易引入的回归。
      const afterResize = await ui.topParagraphIndex(win);
      assertEqual(afterResize.index, top.index, `改字号后落点不应漂移（第 ${top.index} 段 → 第 ${afterResize.index} 段）`);

      return `4200 段：首屏 DOM ${initial.dom} 段、底部垫片 ${initial.spacer}px；跳到第 ${target} 章落到第 ${top.index} 段（DOM ${jumped.dom} 段）；改字号后仍停在第 ${afterResize.index} 段`;
    },
  },

  {
    // 自绘滚动条。原生滚动条在长书上是失效的：滑块按比例只有零点几像素，
    // 浏览器只能按最小长度画一小截，拖动 1px 就跨十屏、点空白轨道还会朝按下方向
    // 一直翻页。所以这里换成自己画的，下面断言它真的可用。
    name: 'scrollbar',
    seed: 'book',
    text: 'large',
    async run({ win }) {
      await openFirstBook(win);

      // 自绘滚动条收的是普通页面事件，可以像真人一样按下—移动—松开。
      // （原生滚动条做不到：合成的鼠标事件驱动不了它，这也是这条问题一开始
      // 只能靠「把文档高度量出来」定位、无法在测试里复现的原因。）
      const dragThumb = (ratio) => ui.evaluate(win, `
        const track = document.querySelector('#reader-scrollbar');
        const thumb = document.querySelector('#reader-scrollbar-thumb');
        const trackRect = track.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        const span = trackRect.height - thumbRect.height;
        const grab = 6;
        const at = (y) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: Math.round(trackRect.left + 7), clientY: Math.round(y) });
        const targetY = trackRect.top + span * ${ratio} + grab;
        thumb.dispatchEvent(new PointerEvent('pointerdown', at(thumbRect.top + grab)));
        window.dispatchEvent(new PointerEvent('pointermove', at(targetY)));
        window.dispatchEvent(new PointerEvent('pointerup', at(targetY)));
        const scroll = document.querySelector('#reader-scroll');
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        return max ? scroll.scrollTop / max : 1;
      `);

      const state = `
        const scroll = document.querySelector('#reader-scroll');
        const track = document.querySelector('#reader-scrollbar');
        const thumb = document.querySelector('#reader-scrollbar-thumb');
        const trackRect = track.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        return {
          nativeWidth: scroll.offsetWidth - scroll.clientWidth,
          trackHidden: track.hidden,
          trackHeight: Math.round(trackRect.height),
          thumbHeight: Math.round(thumbRect.height),
          thumbMiddle: trackRect.height ? (thumbRect.top - trackRect.top + thumbRect.height / 2) / trackRect.height : 0,
          viewport: scroll.clientHeight,
          scrollTop: Math.round(scroll.scrollTop),
          max: Math.round(max),
          ratio: max ? scroll.scrollTop / max : 0,
        };
      `;

      // ── 原生滚动条已隐藏，自绘的那条滑块可抓 ────────────────────────
      const initial = await ui.evaluate(win, state);
      assertEqual(initial.nativeWidth, 0, '原生滚动条不应再占宽度');
      assertTrue(!initial.trackHidden, '长书上自绘滚动条应显示出来');
      assertTrue(initial.thumbHeight >= 24, `滑块长度应有下限、必须抓得住，实际 ${initial.thumbHeight}px`);
      assertTrue(initial.max > 100000, `夹具应撑出足够长的滚动高度，实际 ${initial.max}px`);

      // ── 滚轮落在轨道上：正文照常滚动，右侧不留死区 ──────────────────
      const wheeled = await ui.evaluate(win, `
        const scroll = document.querySelector('#reader-scroll');
        const track = document.querySelector('#reader-scrollbar');
        const before = scroll.scrollTop;
        track.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, deltaMode: 0, bubbles: true, cancelable: true }));
        return { before: Math.round(before), after: Math.round(scroll.scrollTop) };
      `);
      await ui.waitForStableScroll(win);
      assertTrue(wheeled.after - wheeled.before > 100,
        `滚轮落在轨道上应照常滚正文，实际只走了 ${wheeled.after - wheeled.before}px`);

      // ── 点空白轨道：翻一屏（一比一，正好一个视口高度）────────────────
      const paged = await ui.evaluate(win, `
        const scroll = document.querySelector('#reader-scroll');
        const track = document.querySelector('#reader-scrollbar');
        const rect = track.getBoundingClientRect();
        const at = (y) => ({ bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', button: 0, buttons: 1, clientX: Math.round(rect.left + 7), clientY: Math.round(y) });
        const before = scroll.scrollTop;
        track.dispatchEvent(new PointerEvent('pointerdown', at(rect.bottom - 20)));
        return { before: Math.round(before), after: Math.round(scroll.scrollTop), viewport: scroll.clientHeight };
      `);
      await ui.waitForStableScroll(win);
      // 起点不是 0：恢复位置是把目标段落顶到视口顶部，第 0 段的文档位置含正文上方的
      // 内边距，因此比的是这一步走了多少，不是绝对位置。
      const stepped = paged.after - paged.before;
      assertTrue(Math.abs(stepped - paged.viewport) < 10,
        `点轨道下方应向下翻一屏（${paged.viewport}px），实际走了 ${stepped}px`);

      // ── 拖到轨道中间：按全书比例定位 ────────────────────────────────
      await dragThumb(0.5);
      await ui.waitForStableScroll(win);
      const middle = await ui.evaluate(win, state);
      assertTrue(Math.abs(middle.ratio - 0.5) < 0.02,
        `拖到轨道中间应落在全书约一半，实际 ${(middle.ratio * 100).toFixed(1)}%`);
      const top = await ui.topParagraphIndex(win);
      assertTrue(top.index > 1900 && top.index < 2300,
        `拖到一半应落在 4200 段的中间附近，实际第 ${top.index} 段`);
      assertTrue(Math.abs(middle.thumbMiddle - 0.5) < 0.05,
        `滑块应画在全书的中间位置，实际在 ${(middle.thumbMiddle * 100).toFixed(1)}% 处`);

      // ── 再拖一小段：只能挪一小段，不能一拖就到底（这正是原来的问题）──
      await dragThumb(0.6);
      await ui.waitForStableScroll(win);
      const nudged = await ui.evaluate(win, state);
      assertTrue(nudged.ratio > 0.55 && nudged.ratio < 0.65,
        `拖 10% 轨道应只前进约 10%，实际落到 ${(nudged.ratio * 100).toFixed(1)}%`);

      return `原生滚动条已隐藏；滑块 ${initial.thumbHeight}px / 轨道 ${initial.trackHeight}px，`
        + `点轨道翻屏 ${stepped}px，拖到中间落到第 ${top.index} 段（${(middle.ratio * 100).toFixed(1)}%），`
        + `再拖 10% 到 ${(nudged.ratio * 100).toFixed(1)}%`;
    },
  },

  {
    // 整本装得下一屏：没有可滚动的内容，滚动条不该出现（原生滚动条此时也不出现）。
    name: 'scrollbar-short-book',
    seed: 'book',
    text: 'tiny',
    async run({ win }) {
      await openFirstBook(win);
      const state = await ui.evaluate(win, `
        const scroll = document.querySelector('#reader-scroll');
        const track = document.querySelector('#reader-scrollbar');
        const thumb = document.querySelector('#reader-scrollbar-thumb');
        return {
          max: Math.round(scroll.scrollHeight - scroll.clientHeight),
          hidden: track.hidden,
          thumbHeight: Math.round(thumb.getBoundingClientRect().height),
        };
      `);
      assertTrue(state.max <= 0, `夹具应装得下一屏，实际还能滚 ${state.max}px`);
      assertTrue(state.hidden, '没有可滚动内容时整条滚动条都应隐藏');
      assertEqual(state.thumbHeight, 0, '滚动条隐藏时滑块不应占位');
      return `短书（可滚动 ${state.max}px）：滚动条已隐藏，滑块高度 ${state.thumbHeight}px`;
    },
  },

  {
    name: 'toc-jump',
    seed: 'book',
    async run({ win }) {
      await openFirstBook(win);

      // ── 按钮与面板的几何/文案（关闭态） ──────────────────────────────
      const toolbar = await ui.evaluate(win, `
        const bar = document.querySelector('.reader-toolbar');
        const back = document.querySelector('#back-to-shelf');
        const toc = document.querySelector('#open-toc');
        const title = document.querySelector('.reader-title');
        const center = (el) => {
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), mid: Math.round((r.left + r.right) / 2) };
        };
        return {
          children: [...bar.children].map((el) => el.className),
          barMid: center(bar).mid,
          back: center(back),
          toc: center(toc),
          titleMid: center(title).mid,
          text: toc.textContent.trim(),
          // 文案溢出检测：两字的按钮套在固定 36px 的 .icon-button 上会溢出。
          overflow: toc.scrollWidth - toc.clientWidth,
          viewport: window.innerWidth,
        };
      `);
      assertEqual(
        JSON.stringify(toolbar.children),
        JSON.stringify(['toolbar-left', 'reader-title', 'toolbar-actions']),
        '工具栏三栏结构应为「左导航 / 书名 / 右操作」',
      );
      assertEqual(toolbar.text, '目录', '目录按钮文案应为「目录」');
      assertTrue(
        toolbar.toc.left >= toolbar.back.right,
        `目录按钮应在返回键右侧，实际返回键 right=${toolbar.back.right}、目录按钮 left=${toolbar.toc.left}`,
      );
      assertTrue(
        toolbar.toc.left < toolbar.viewport / 2,
        `目录按钮应位于工具栏左半部分，实际 left=${toolbar.toc.left}，视口宽 ${toolbar.viewport}`,
      );
      assertTrue(toolbar.overflow <= 1, `目录按钮文案不应溢出，实际溢出 ${toolbar.overflow}px`);
      assertTrue(
        Math.abs(toolbar.titleMid - toolbar.barMid) < 2,
        `书名仍应居中，实际书名中心 ${toolbar.titleMid}、工具栏中心 ${toolbar.barMid}`,
      );

      // 关闭态的目录面板必须整体在视口左侧之外，而不是右侧。
      await waitForPanelRect(win, '#toc-panel', (rect) => rect.right <= 0, '关闭时目录面板应完全位于视口左侧之外');

      // ── 打开目录 ────────────────────────────────────────────────────
      await ui.click(win, '#open-toc');
      await ui.waitFor(win, "return Boolean(document.querySelector('#toc-panel.is-open'));", { label: '目录面板应打开' });
      const openRect = await waitForPanelRect(win, '#toc-panel', (rect) => rect.left === 0, '打开时目录面板应左边缘贴齐视口');

      const list = await ui.evaluate(win, `
        const items = [...document.querySelectorAll('#toc-list [data-chapter-index]')];
        const item = items[0];
        return {
          count: items.length,
          titles: items.map((el) => el.textContent.trim()),
          fontSize: item ? getComputedStyle(item).fontSize : null,
        };
      `);
      // 夹具每 20 段插入一个标题，200 段共 10 章。
      assertEqual(list.count, 10, `应识别出 10 个章节，实际 ${list.count}`);
      assertTrue(
        list.titles.every((title) => /^第\d+章 /.test(title)),
        `章节标题应形如「第N章 …」，实际：${list.titles.slice(0, 3).join(' / ')}`,
      );
      assertEqual(list.fontSize, '15px', '章节条目字号应为 15px');

      // ── 跳转 ────────────────────────────────────────────────────────
      // 用标题文本而不是算出来的段落索引做期望值：
      // 后者依赖夹具的构造细节，读起来与真实意图脱节。
      const target = 5;
      const expected = list.titles[target];
      await ui.click(win, `#toc-list [data-chapter-index="${target}"]`);
      await ui.waitFor(win, "return !document.querySelector('#toc-panel').classList.contains('is-open');", { label: '跳转后目录面板应关闭' });

      let top = null;
      try {
        await ui.waitUntil(async () => {
          top = await ui.topParagraphIndex(win);
          return top.text === expected;
        }, { label: `跳转后视口顶部应为「${expected}」` });
      } catch (error) {
        throw new Error(`${error.message}，实际顶部为「${top?.text}」`);
      }

      // ── 章节标题的排版 ──────────────────────────────────────────────
      // 跳过来之后视口顶部那一段就是标题本体，正好在这里量它的实际样式。
      // 夹具里正文段落一律以「段落0001」开头，标题一律是「第N章 …」，
      // 因此用文本就能把两类分开，逐段核对类名有没有加对。
      const typography = await ui.evaluate(win, `
        const items = [...document.querySelectorAll('#reader-content p')];
        const landed = items.find((el) => Number(el.dataset.paragraphIndex) === ${top.index});
        const body = items.find((el) => !el.classList.contains('reader-chapter'));
        const content = document.querySelector('#reader-content');
        const style = getComputedStyle(landed);
        const bodyStyle = getComputedStyle(body);
        // 段落是块级元素，它自己的 rect 恒占满版心——文字到底居没居中，
        // 只能用 Range 量文字本身的盒子。
        const range = document.createRange();
        range.selectNodeContents(landed);
        const textRect = range.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const mismatched = items.filter(
          (el) => /^第\\d+章 /.test(el.textContent) !== el.classList.contains('reader-chapter'),
        );
        return {
          isChapter: landed.classList.contains('reader-chapter'),
          className: landed.className,
          fontSize: parseFloat(style.fontSize),
          bodyFontSize: parseFloat(bodyStyle.fontSize),
          align: style.textAlign,
          indent: style.textIndent,
          bodyIndent: bodyStyle.textIndent,
          textMid: Math.round((textRect.left + textRect.right) / 2),
          contentMid: Math.round((contentRect.left + contentRect.right) / 2),
          mismatched: mismatched.length,
          sample: mismatched.length ? mismatched[0].textContent.slice(0, 20) : null,
        };
      `);
      assertTrue(typography.isChapter, `落地段落应是章节标题，实际 class="${typography.className}"`);
      assertTrue(
        Math.abs(typography.fontSize / typography.bodyFontSize - 1.3) < 0.01,
        `标题字号应比正文大 30%，实际标题 ${typography.fontSize}px / 正文 ${typography.bodyFontSize}px`,
      );
      assertEqual(typography.align, 'center', '章节标题应居中');
      assertEqual(typography.indent, '0px', '章节标题不应有段首缩进（会把居中后的那一行推右）');
      assertEqual(typography.bodyIndent, '36px', '正文段首缩进仍应是 2em = 36px');
      assertTrue(
        Math.abs(typography.textMid - typography.contentMid) <= 2,
        `标题文字应与版心同轴，实际文字中心 ${typography.textMid}、版心中心 ${typography.contentMid}`,
      );
      assertEqual(
        typography.mismatched,
        0,
        `窗口内每段「第N章 …」都应带章节样式，实际有 ${typography.mismatched} 段没有（如「${typography.sample}」）`,
      );

      // ── 阅读设置面板不应被牵连 ──────────────────────────────────────
      // .side-panel--left 只加在目录面板上，这条断言把「改错了对象」钉死。
      // 右侧面板同样有滑入过渡，比较放在页面内做才能每轮取到新值。
      await ui.click(win, '#open-settings');
      await ui.waitFor(win, `
        const el = document.querySelector('#settings-panel');
        if (!el || !el.classList.contains('is-open')) return false;
        return Math.round(el.getBoundingClientRect().right) === window.innerWidth;
      `, { label: '阅读设置面板应仍从右侧滑出（right 应等于视口宽度）' });

      return `${list.count} 章（${list.fontSize}）；目录面板左滑（left=${openRect.left}）；点击「${expected}」后顶部为该章标题`
        + `；标题 ${typography.fontSize}px / 正文 ${typography.bodyFontSize}px、居中且无缩进`;
    },
  },

  {
    // 回归用例：跳转章节后，目录里高亮的必须是跳过去的那一章。
    // 这里用 uneven 夹具是关键——段落等长时「比例 × 段落数」的估算恰好准确，
    // 用默认夹具跑这条断言会无条件通过，等于没测。
    name: 'toc-active',
    seed: 'book',
    text: 'uneven',
    async run({ win }) {
      await openFirstBook(win);
      await ui.click(win, '#open-toc');
      await ui.waitFor(win, "return Boolean(document.querySelector('#toc-panel.is-open'));", { label: '目录面板应打开' });

      const target = 5;
      const title = await ui.evaluate(win, `
        return document.querySelector('#toc-list [data-chapter-index="${target}"]').textContent.trim();
      `);
      await ui.click(win, `#toc-list [data-chapter-index="${target}"]`);
      // 跳转会关掉面板；等滚动与高亮都落定后再重新打开目录。
      await ui.waitFor(win, "return !document.querySelector('#toc-panel').classList.contains('is-open');", { label: '跳转后目录面板应关闭' });
      await ui.waitForStableScroll(win);
      await ui.click(win, '#open-toc');
      await ui.waitFor(win, "return Boolean(document.querySelector('#toc-panel.is-open'));", { label: '再次打开目录' });

      const state = await ui.evaluate(win, `
        const scroll = document.querySelector('#reader-scroll');
        const items = [...document.querySelectorAll('#reader-content p')];
        const top = scroll.getBoundingClientRect().top;
        const found = items.find((el) => el.getBoundingClientRect().bottom > top + 2);
        const active = document.querySelector('#toc-list .is-active');
        return {
          highlighted: active ? Number(active.dataset.chapterIndex) : null,
          topParagraph: found ? Number(found.dataset.paragraphIndex) : -1,
          topText: found ? found.textContent.slice(0, 16) : null,
        };
      `);
      assertEqual(
        state.highlighted,
        target,
        `跳转到「${title}」后，目录应高亮第 ${target} 章；实际高亮第 ${state.highlighted} 章`
        + `（视口顶部是第 ${state.topParagraph} 段「${state.topText}…」）`,
      );

      // 滚动路径与跳转走的是两段代码：滚动时的重算被收敛进 rAF（每帧最多测一次几何）。
      // 这里把另一章的标题滚到顶部，确认高亮会跟着走——否则 rAF 那步坏掉也不会被发现。
      const target2 = 7;
      const found = await ui.evaluate(win, `
        const title = document.querySelector('#toc-list [data-chapter-index="${target2}"]').textContent.trim();
        const paragraph = [...document.querySelectorAll('#reader-content p')].find((el) => el.textContent.trim() === title);
        const scroll = document.querySelector('#reader-scroll');
        scroll.style.scrollBehavior = 'auto';
        if (paragraph) paragraph.scrollIntoView({ block: 'start', behavior: 'instant' });
        return Boolean(paragraph);
      `);
      assertTrue(found, `应能在正文中找到第 ${target2} 章的标题段落`);
      let active = null;
      try {
        await ui.waitUntil(async () => {
          active = await ui.evaluate(win, `
            const el = document.querySelector('#toc-list .is-active');
            return el ? Number(el.dataset.chapterIndex) : null;
          `);
          return active === target2;
        }, { label: `滚动到第 ${target2} 章后目录高亮应跟随` });
      } catch (error) {
        throw new Error(`${error.message}，实际高亮第 ${active} 章`);
      }

      return `跳转第 ${target} 章后高亮正确（顶部为第 ${state.topParagraph} 段）；滚动到第 ${target2} 章后高亮跟随`;
    },
  },

  {
    name: 'toc-fallback',
    seed: 'book',
    text: 'plain',
    async run({ win }) {
      await openFirstBook(win);
      // 无空行 TXT：改动前会被解析成一个段落，整本渲染成一整块文字。
      // 数的是 data-paragraph-count（整本），不是 DOM 里的 <p> 数量。
      const paragraphs = await ui.evaluate(win, "return Number(document.querySelector('#reader-content').dataset.paragraphCount);");
      assertEqual(paragraphs, 200, `无空行文本应按行切分为 200 段，实际 ${paragraphs}`);

      await ui.click(win, '#open-toc');
      await ui.waitFor(win, "return Boolean(document.querySelector('#toc-panel.is-open'));", { label: '目录面板应打开' });

      const panel = await ui.evaluate(win, `
        return {
          hasList: Boolean(document.querySelector('#toc-list')),
          hasSlider: Boolean(document.querySelector('#toc-percent')),
          message: document.querySelector('.toc-empty p')?.textContent ?? null,
        };
      `);
      assertTrue(!panel.hasList, '识别不出章节时不应渲染章节列表');
      assertTrue(panel.hasSlider, '识别不出章节时应降级为按进度跳转的滑块');
      assertTrue(Boolean(panel.message), '应说明未识别到章节的原因');

      const before = await ui.evaluate(win, "return Math.round(document.querySelector('#reader-scroll').scrollTop);");
      await ui.setRange(win, '#toc-percent', 60);
      const after = await ui.evaluate(win, `
        const scroll = document.querySelector('#reader-scroll');
        return {
          scrollTop: Math.round(scroll.scrollTop),
          max: Math.round(scroll.scrollHeight - scroll.clientHeight),
        };
      `);
      assertTrue(after.scrollTop > before, `拖动进度滑块后阅读位置应改变，实际 ${before} → ${after.scrollTop}`);
      const ratio = after.scrollTop / after.max;
      assertTrue(Math.abs(ratio - 0.6) < 0.05, `滑块 60% 应对应约 60% 的滚动位置，实际 ${(ratio * 100).toFixed(1)}%`);
      return `无空行文本切分为 ${paragraphs} 段；未识别到章节时降级为进度滑块（60% → ${after.scrollTop}px）`;
    },
  },
];

export async function runSpecs(ctx) {
  const results = [];
  for (const spec of SPECS) {
    const started = Date.now();
    let error = null;
    let detail = null;
    try {
      ctx.mock.reset(spec.seed === 'book' ? ctx.mock.seededLibrary() : ctx.mock.emptyLibrary(), spec.text);
      await ui.reload(ctx.win);
      await ui.waitFor(ctx.win, ui.firstPaintCondition, { label: '首屏渲染', timeout: 15000 });

      const unsupported = await ui.evaluate(ctx.win, "return Boolean(document.querySelector('.unsupported'));");
      if (unsupported) {
        throw new Error('页面显示「请在桌面应用中打开」，说明 mock preload 未加载，window.novelApi 为 undefined');
      }

      detail = await spec.run(ctx);
    } catch (err) {
      error = err;
    }
    const result = { name: spec.name, passed: !error, error, detail, ms: Date.now() - started };
    if (error) result.snapshot = await ui.snapshot(ctx.win);
    results.push(result);
  }
  return results;
}
