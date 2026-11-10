const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nicoAPI", {
  getVersion: () => ipcRenderer.invoke("app:version"),
  openLogin: () => ipcRenderer.invoke("auth:open-login"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  openWatch: (liveId) => ipcRenderer.invoke("live:open-watch", liveId),
  connectLive: (liveId) => ipcRenderer.invoke("live:connect", liveId),
  disconnectLive: () => ipcRenderer.invoke("live:disconnect"),
  listVideoSources: () => ipcRenderer.invoke("video:list-sources"),
  selectVideoSource: (sourceId) => ipcRenderer.invoke("video:select-source", sourceId),
  cancelCaptureSource: () => ipcRenderer.invoke("video:cancel-source"),
  startVideo: (liveId) => ipcRenderer.invoke("video:start", liveId),
  writeVideoChunk: (chunk) => ipcRenderer.invoke("video:chunk", chunk),
  stopVideo: () => ipcRenderer.invoke("video:stop"),
  openDataFolder: () => ipcRenderer.invoke("data:open-folder"),
  exportCsv: () => ipcRenderer.invoke("comments:export-csv"),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("app:event", handler);
    return () => ipcRenderer.removeListener("app:event", handler);
  }
});