import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '..', '..');
const distEntry = path.join(projectRoot, 'dist', 'index.html');

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 创建测试窗口。所有断言都跑在真实构建产物上，而不是 Vite 开发服务器：
// 结果确定，不需要与 Vite 的启动时序竞争，并且顺带验证了生产构建能正常启动。
//
// 窗口刻意做成「可见但移出屏幕」，而不是 show: false：
// 隐藏窗口下 Chromium 会节流 requestAnimationFrame，而 src/reader.js 的
// restoreScroll() 正是靠 rAF 做延迟滚动。实测中它被推迟约 500ms 才执行，
// 会在测试已经手动滚动之后突然把位置覆盖回恢复点，导致进度断言以极难
// 理解的方式失败。移出屏幕后窗口仍被视为可见，rAF 恢复正常节奏，
// 用户也不会看到测试窗口。
export async function createTestWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    x: -4000,
    y: -4000,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏/后台窗口默认还会节流定时器。不加这一条，阅读进度的 500ms 防抖
      // 不会按时触发，进度保存断言会变成随机失败。
      backgroundThrottling: false,
    },
  });
  await win.loadFile(distEntry);
  await waitFor(win, firstPaintCondition, { label: '首屏渲染', timeout: 15000 });
  win.showInactive();
  await delay(200);

  const height = await evaluate(win, 'return document.documentElement.clientHeight;');
  if (height <= 0) {
    throw new Error('测试窗口没有产生布局（clientHeight 为 0），该环境无法进行几何断言。');
  }
  return win;
}

export const firstPaintCondition = "return Boolean(document.querySelector('.shelf-shell') || document.querySelector('.unsupported'));";

// 等滚动位置稳定下来再做后续操作。
// restoreScroll() 的滚动发生在 rAF 里，进入阅读页后立刻手动滚动会与它竞争。
export async function waitForStableScroll(win, { samples = 3, interval = 60, timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const current = await evaluate(win, `
      const scroll = document.querySelector('#reader-scroll');
      return scroll ? Math.round(scroll.scrollTop) : null;
    `);
    if (current !== null && current === previous) {
      stable += 1;
      if (stable >= samples) return current;
    } else {
      stable = 0;
    }
    previous = current;
    await delay(interval);
  }
  return previous;
}

export async function reload(win) {
  const done = new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  win.webContents.reload();
  await done;
}

// 页面脚本里必须显式 return。包成 async IIFE 以便在页面内使用 await。
export async function evaluate(win, code) {
  return win.webContents.executeJavaScript(`(async () => {\n${code}\n})()`, true);
}

export async function waitFor(win, code, { label = '条件', timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(win, code);
      lastError = null;
      if (last) return last;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  const why = lastError
    ? `，最后一次求值报错：${lastError.message}`
    : `，最后一次求值结果：${JSON.stringify(last)}`;
  throw new Error(`等待超时（${timeout}ms）：${label}${why}`);
}

// 等待主进程侧的条件（例如 mock 是否收到了某次保存）。页面内的 waitFor 做不到这件事。
export async function waitUntil(predicate, { label = '条件', timeout = 5000, interval = 30 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`);
}

export async function click(win, selector) {
  const ok = await evaluate(win, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  `);
  if (!ok) throw new Error(`找不到可点击元素：${selector}`);
}

export async function setRange(win, selector, value) {
  const ok = await evaluate(win, `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  if (!ok) throw new Error(`找不到 range 控件：${selector}`);
}

// scroll-behavior: smooth 会让 scrollTop 的读取立刻返回旧值，是这类测试最容易踩的坑。
// 这里显式关掉平滑滚动，与产品在 prefers-reduced-motion 下的行为一致，不是绕过测试。
export async function disableSmoothScroll(win) {
  await evaluate(win, `
    const scroll = document.querySelector('#reader-scroll');
    if (scroll) scroll.style.scrollBehavior = 'auto';
    return true;
  `);
}

export async function scrollReaderTo(win, top) {
  return evaluate(win, `
    const scroll = document.querySelector('#reader-scroll');
    if (!scroll) return -1;
    scroll.style.scrollBehavior = 'auto';
    scroll.scrollTop = ${JSON.stringify(top)};
    scroll.dispatchEvent(new Event('scroll'));
    return scroll.scrollTop;
  `);
}

// 视口顶部所在的段落索引。恢复位置后用它和保存值比对：
// restoreScroll() 用 scrollIntoView({block:'start'}) 对齐，恢复后的 scrollTop
// 天然不等于保存前的 scrollTop，所以只能比较语义位置，不能比较像素。
export async function topParagraphIndex(win) {
  return evaluate(win, `
    const scroll = document.querySelector('#reader-scroll');
    if (!scroll) return { index: -1, count: 0 };
    const top = scroll.getBoundingClientRect().top;
    const items = [...document.querySelectorAll('#reader-content p')];
    const found = items.find((el) => el.getBoundingClientRect().bottom > top + 2);
    return { index: found ? Number(found.dataset.paragraphIndex) : -1, count: items.length };
  `);
}

// 断言失败时用来定位现场的 DOM 快照，避免只报一行 assert 让人无从下手。
export async function snapshot(win) {
  try {
    return await evaluate(win, `
      const q = (selector) => document.querySelector(selector);
      const scroll = q('#reader-scroll');
      const toolbar = q('.reader-toolbar');
      const shell = q('.reader-shell');
      return {
        hasShelf: Boolean(q('.shelf-shell')),
        hasReader: Boolean(shell),
        hasUnsupported: Boolean(q('.unsupported')),
        theme: shell ? shell.dataset.theme : null,
        docTheme: document.documentElement.dataset.theme ?? null,
        toolbarTop: toolbar ? Math.round(toolbar.getBoundingClientRect().top) : null,
        scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
        scrollHeight: scroll ? scroll.scrollHeight : null,
        paragraphCount: document.querySelectorAll('#reader-content p').length,
        apiKeys: Object.keys(window.novelApi || {}),
      };
    `);
  } catch (error) {
    return { snapshotError: String(error?.message || error) };
  }
}
