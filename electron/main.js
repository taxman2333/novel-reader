import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from './library-store.js';
import { fileStillMatches, readTxtFile } from './book-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');

// 数据目录名固定为 local-novel-reader，与产品显示名「书页之间」刻意解耦。
// app.getPath('userData') 默认跟随 app.getName()，而 app.getName() 跟随 package.json
// 的 productName。一旦让两者联动，改名或引入 productName 都会把老用户的 library.json
// 留在旧目录，表现为「升级后书架凭空变空」。显式 setPath 让开发态与打包态共用同一个目录。
// 必须在 app ready 之前调用才生效，取 appData 而非硬编码路径是为了不引入本机个人路径。
const USER_DATA_DIR_NAME = 'local-novel-reader';
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR_NAME));

// 窗口与任务栏图标。用 __dirname 回溯到应用根：开发态是仓库根目录，打包后是 app.asar 内，
// 两种情况下 design/app-icon/final/icon.ico 都处在同一个相对位置，所以同一个表达式两边都成立。
// 图标同时被 package.json 的 build.files 白名单收录 —— 不加进去的话开发态正常、打包态找不到文件。
// 打包产物的 exe 图标另由 build.win.icon 在构建时嵌入，不走这里。
const APP_ICON = path.join(__dirname, '..', 'design', 'app-icon', 'final', 'icon.ico');

let mainWindow;
let store;

// 落盘串行化。
// store.save() 是「写 .tmp → 备份 .bak → rename」三步，两次 save 并发时后者的
// writeFile(.tmp) 可能夹在前者的 rename 之前，使 rename 搬走的是别人的内容、
// 而 .bak 里留下另一份，最终三个文件互不一致。串成一条链，任何时刻只有一个 save 在跑。
// 链上已经 catch，所以 saveChain 永远不会 reject；单次失败不会打断后续写入。
let saveChain = Promise.resolve();

function queueSave(data) {
  saveChain = saveChain.then(() => store.save(data)).catch((error) => {
    console.error('保存书架数据失败：', error);
  });
  return saveChain;
}

function createApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于书页之间',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于书页之间',
              message: '书页之间',
              detail: `本地 TXT 小说阅读器\n版本 ${app.getVersion()}`,
              buttons: ['好'],
              noLink: true,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    icon: APP_ICON,
    backgroundColor: '#f1ede4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function registerIpc() {
  ipcMain.handle('library:load', async () => store.load());
  ipcMain.handle('library:save', async (_event, data) => queueSave(data));
  ipcMain.on('library:save-on-exit', (event, data) => {
    queueSave(data);
    // 立刻回值：这里是窗口关闭路径，不能让渲染进程等磁盘。
    // 真正的落盘由下面的 will-quit 兜住。
    event.returnValue = true;
  });
  ipcMain.handle('library:remove', async (_event, bookId) => {
    const data = (await store.load()) || { version: 1, settings: {}, books: [] };
    data.books = data.books.filter((book) => book.id !== bookId);
    // 不走 store.save()：否则这次写入会和队列里待跑的保存并发，回到上面说的错位问题。
    await queueSave(data);
    return data;
  });
  ipcMain.handle('book:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 TXT 小说',
      properties: ['openFile'],
      filters: [{ name: 'TXT 文本', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readTxtFile(result.filePaths[0]);
  });
  ipcMain.handle('book:read', async (_event, filePath) => readTxtFile(filePath));
  ipcMain.handle('book:inspect', async (_event, book) => fileStillMatches(book));
}

app.whenReady().then(() => {
  store = createLibraryStore(app.getPath('userData'));
  registerIpc();
  createApplicationMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前把队列里的写入等完。
//
// 用 will-quit 而不是 before-quit：will-quit 在所有窗口都已关闭之后才触发，因此此刻
// 渲染进程的 beforeunload 一定已经把最后一份快照交出来了；before-quit 早于窗口关闭，
// 在那里等待会等到一份还不存在的写入。
//
// 这正是旧实现的缺陷所在：原来只是 `void store.save(data)` 起个头就放行退出，
// 进程可能死在 writeFile(.tmp) 与 rename 之间，用户数据目录里留下一份 .tmp 残骸
// （2026-09-28 实测确认：.bak 的 mtime 停留在上一次保存，说明 copyFile 根本没执行到）。
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  const pending = saveChain;
  saveChain = Promise.resolve();
  pending.then(() => app.quit());
});
