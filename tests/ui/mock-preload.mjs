import { contextBridge, ipcRenderer } from 'electron';

// 测试专用的 novelApi 替身。
//
// 形状必须与 electron/preload.mjs 完全一致——渲染层分辨不出区别，因此
// src/main.js / src/reader.js / src/styles.css 的全部真实逻辑都会被保留。
//
// ⚠️ 修改 electron/preload.mjs 时必须同步此处，否则 specs 里的 api-surface
//    断言会失败。那是刻意的：mock 漂移意味着测试通过但真实应用已经坏掉。
//
// 所有数据都转发到主进程的 mock:* 通道。状态刻意不放在这个文件里：
// preload 模块的内存会在每个窗口实例化时重置，放在这里会导致 reload 之后
// 读到硬编码初始值而不是上一次保存的值，产生假失败。

contextBridge.exposeInMainWorld('novelApi', {
  loadLibrary: () => ipcRenderer.invoke('mock:library-load'),
  saveLibrary: (data) => ipcRenderer.invoke('mock:library-save', data),
  saveLibraryOnExit: (data) => ipcRenderer.send('mock:library-save-on-exit', data),
  removeBook: (bookId) => ipcRenderer.invoke('mock:library-remove', bookId),
  chooseBook: () => ipcRenderer.invoke('mock:book-choose'),
  readBook: (filePath) => ipcRenderer.invoke('mock:book-read', filePath),
  inspectBook: (book) => ipcRenderer.invoke('mock:book-inspect', book),
});
