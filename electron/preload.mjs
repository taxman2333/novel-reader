import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('novelApi', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (data) => ipcRenderer.invoke('library:save', data),
  // 用 sendSync 而不是 send：beforeunload 里发出的消息必须确定性地先于窗口关闭到达主进程，
  // 否则主进程可能在收到最后一次快照之前就开始退出流程。
  // 主进程侧会立刻回值，不等磁盘写完。
  saveLibraryOnExit: (data) => ipcRenderer.sendSync('library:save-on-exit', data),
  removeBook: (bookId) => ipcRenderer.invoke('library:remove', bookId),
  chooseBook: () => ipcRenderer.invoke('book:choose'),
  readBook: (filePath) => ipcRenderer.invoke('book:read', filePath),
  inspectBook: (book) => ipcRenderer.invoke('book:inspect', book),
});
