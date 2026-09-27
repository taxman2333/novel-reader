import { app, ipcMain } from 'electron';
import { createTestWindow } from './harness.mjs';
import { runSpecs } from './specs.mjs';

// ───────────────────────────────────────────────────────────────────────────
// 测试专用的 Electron 主进程入口。
//
// 通过 `electron tests/ui/entry.mjs` 启动，绕过 package.json 的 main 字段，
// 因此生产代码 electron/main.js 一行都不用改。
//
// 假数据刻意保存在这里（主进程），而不是 preload 模块里：preload 的内存会在
// 每个窗口实例化时重置，放在那里会让 reload 之后读到初始值而非上次保存的值。
// 状态放在主进程，「重启应用后设置还在吗」才能被真实验证。
// ───────────────────────────────────────────────────────────────────────────

// 必须在 app ready 之前追加。src/styles.css 有 prefers-reduced-motion 规则，
// 它会关掉 scroll-behavior: smooth —— 平滑滚动会让 scrollTop 的读取恒为旧值。
app.commandLine.appendSwitch('force-prefers-reduced-motion');

const WATCHDOG_MS = 60000;

// 刻意使用不可能存在的伪路径：配合 mock 的 readBook，全程不触碰真实文件系统，
// 也就不会读到任何用户小说。
const FIXTURE_PATH = 'mock://测试小说.txt';
const FIXTURE_NAME = '测试小说.txt';
const FIXTURE_SIZE = 65536;
const FIXTURE_MODIFIED = '2026-09-27T00:00:00.000Z';
const FIXTURE_FINGERPRINT = 'c0ffee1234567890abcdef01';

// 合成测试文本。约束：每段前 80 个字必须唯一。
// src/reader.js 的 findRestoreIndex() 优先按上下文匹配
// （paragraphs.findIndex(text => text.includes(progress.context.slice(0, 80)))），
// 段落开头若重复，恢复位置会命中错误段落，测试将以难以理解的方式失败。
const FIXTURE_TEXT = (() => {
  const paragraphs = [];
  for (let i = 1; i <= 200; i += 1) {
    const marker = String(i).padStart(4, '0');
    paragraphs.push(
      `段落${marker} 这是界面回归测试使用的合成文本，不包含任何真实小说内容。`
      + `第${marker}段继续填充文字，用于制造足够的滚动高度，使正文可以滚动超过四千像素。`,
    );
  }
  return paragraphs.join('\n\n');
})();

function createMock() {
  const state = {
    library: null,
    saves: [],
    chooseQueue: [],
    // 见 reset() 的说明：只有「已经读取过当前这份数据」的页面才允许写回。
    armed: false,
    calls: { loadLibrary: 0, saveLibrary: 0, saveOnExit: 0, droppedSaveOnExit: 0, removeBook: 0, chooseBook: 0, readBook: 0, inspectBook: 0 },
  };

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const readResult = () => ({
    path: FIXTURE_PATH,
    name: FIXTURE_NAME,
    size: FIXTURE_SIZE,
    modifiedAt: FIXTURE_MODIFIED,
    text: FIXTURE_TEXT,
    encoding: 'utf-8',
    fingerprint: FIXTURE_FINGERPRINT,
  });

  const emptyLibrary = () => ({ version: 1, settings: {}, books: [] });

  const seededLibrary = () => ({
    version: 1,
    settings: {},
    books: [{
      id: FIXTURE_PATH,
      path: FIXTURE_PATH,
      name: '测试小说',
      fileName: FIXTURE_NAME,
      size: FIXTURE_SIZE,
      modifiedAt: FIXTURE_MODIFIED,
      fingerprint: FIXTURE_FINGERPRINT,
      encoding: 'utf-8',
      importedAt: FIXTURE_MODIFIED,
      lastOpenedAt: FIXTURE_MODIFIED,
      unavailable: false,
      progress: { paragraphIndex: 0, charOffset: 0, ratio: 0, context: '', updatedAt: FIXTURE_MODIFIED },
      settings: null,
    }],
  });

  function reset(library) {
    state.library = clone(library || emptyLibrary());
    state.saves = [];
    state.chooseQueue = [];
    // 用例之间靠 reload 隔离，但 reload 会让上一个用例的页面触发 beforeunload，
    // 而 src/main.js 在那里调用 saveLibraryOnExit(library)，把整份旧数据写回来。
    // 如果 reset 之后的这份数据被它覆盖，下一个用例就会带着上一个用例的阅读进度
    // 和主题启动——恢复位置不再是 0，期望值也来自上一个用例，失败现场极难理解。
    // 因此 reset 后进入「未武装」状态：退出时的保存会被丢弃，直到新页面真正
    // 读取过当前这份数据（loadLibrary）为止。
    state.armed = false;
    for (const key of Object.keys(state.calls)) state.calls[key] = 0;
  }

  function register() {
    ipcMain.handle('mock:library-load', () => {
      state.calls.loadLibrary += 1;
      // 新页面读到了当前这份数据，此后它的保存才算数。
      state.armed = true;
      return clone(state.library);
    });
    ipcMain.handle('mock:library-save', (_event, data) => {
      state.calls.saveLibrary += 1;
      state.library = clone(data);
      state.saves.push(clone(data));
      return true;
    });
    ipcMain.on('mock:library-save-on-exit', (_event, data) => {
      state.calls.saveOnExit += 1;
      if (!state.armed) {
        // 上一个用例的页面在 reload 途中退出时发来的保存，丢弃。
        state.calls.droppedSaveOnExit += 1;
        return;
      }
      state.library = clone(data);
      state.saves.push(clone(data));
    });
    ipcMain.handle('mock:library-remove', (_event, bookId) => {
      state.calls.removeBook += 1;
      state.library.books = state.library.books.filter((book) => book.id !== bookId);
      return clone(state.library);
    });
    ipcMain.handle('mock:book-choose', () => {
      state.calls.chooseBook += 1;
      if (!state.chooseQueue.length) return null;
      return clone(state.chooseQueue.shift());
    });
    ipcMain.handle('mock:book-read', () => {
      state.calls.readBook += 1;
      return readResult();
    });
    ipcMain.handle('mock:book-inspect', (_event, book) => {
      state.calls.inspectBook += 1;
      return { path: book.path, size: book.size, modifiedAt: book.modifiedAt, matches: true, changed: false, unavailable: false };
    });
  }

  return {
    state,
    reset,
    register,
    emptyLibrary,
    seededLibrary,
    queueChoose: () => state.chooseQueue.push(readResult()),
    lastSave: () => state.saves[state.saves.length - 1] || null,
  };
}

async function main() {
  // 只有一个窗口，且测试过程中不会关闭它。这里兜住 window-all-closed，
  // 避免任何意外关闭触发 Electron 默认的退出行为而中断测试。
  app.on('window-all-closed', () => {});

  await app.whenReady();

  const mock = createMock();
  mock.register();

  const win = await createTestWindow();
  const results = await runSpecs({ win, mock });

  const failed = results.filter((result) => !result.passed);
  console.log('\n=== 界面回归测试 ===\n');
  for (const result of results) {
    const mark = result.passed ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${result.name}  (${result.ms}ms)`);
    if (result.detail) console.log(`      ${result.detail}`);
    if (!result.passed) {
      console.log(`      ${result.error.message}`);
      console.log(`      快照: ${JSON.stringify(result.snapshot)}`);
    }
  }
  console.log(`\n${results.length} 项：${results.length - failed.length} 通过，${failed.length} 失败`);

  app.exit(failed.length ? 1 : 0);
}

setTimeout(() => {
  console.error(`\n测试超过 ${WATCHDOG_MS}ms 未结束，判定为卡死。`);
  app.exit(2);
}, WATCHDOG_MS);

main().catch((error) => {
  console.error('测试进程异常终止：', error);
  app.exit(2);
});
