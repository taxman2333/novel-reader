import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('novelApi', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (data) => ipcRenderer.invoke('library:save', data),
  saveLibraryOnExit: (data) => ipcRenderer.send('library:save-on-exit', data),
  removeBook: (bookId) => ipcRenderer.invoke('library:remove', bookId),
  chooseBook: () => ipcRenderer.invoke('book:choose'),
  readBook: (filePath) => ipcRenderer.invoke('book:read', filePath),
  inspectBook: (book) => ipcRenderer.invoke('book:inspect', book),
});
