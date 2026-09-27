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

// 从书架进入第一本书的阅读页。所有阅读器相关的断言都从这里出发。
async function openFirstBook(win) {
  await ui.waitFor(win, "return Boolean(document.querySelector('.book-main'));", { label: '书架出现可打开的书籍' });
  await ui.click(win, '.book-main');
  await ui.waitFor(win, "return Boolean(document.querySelector('.reader-shell'));", { label: '进入阅读页' });
  await ui.disableSmoothScroll(win);
  await ui.waitFor(win, "return document.querySelectorAll('#reader-content p').length > 0;", { label: '正文渲染完成' });
  // restoreScroll() 的滚动在 rAF 里，必须等它落定再手动滚动，否则两者会互相覆盖。
  await ui.waitForStableScroll(win);
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
      const paragraphs = await ui.evaluate(win, "return document.querySelectorAll('#reader-content p').length;");
      assertTrue(paragraphs > 100, `导入后正文应有内容，实际段落数 ${paragraphs}`);

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
      return `导入后正文 ${paragraphs} 段，书架 1 条记录`;
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
        const p = document.querySelector('#reader-content p');
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
        const p = document.querySelector('#reader-content p');
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

      // 比较语义位置而非像素：restoreScroll() 用 scrollIntoView 对齐段落顶部，
      // 恢复后的 scrollTop 天然不等于保存前的 scrollTop。
      let restored = null;
      try {
        await ui.waitUntil(async () => {
          restored = await ui.topParagraphIndex(win);
          return restored.index === saved.paragraphIndex;
        }, { label: `恢复后视口顶部应为第 ${saved.paragraphIndex} 段` });
      } catch (error) {
        throw new Error(`${error.message}，实际顶部为第 ${restored?.index} 段（正文共 ${restored?.count} 段）`);
      }

      return `保存于第 ${saved.paragraphIndex} 段（${Math.round(saved.ratio * 100)}%），恢复后顶部为第 ${restored.index} 段`;
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
      ctx.mock.reset(spec.seed === 'book' ? ctx.mock.seededLibrary() : ctx.mock.emptyLibrary());
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
