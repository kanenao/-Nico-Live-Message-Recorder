const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nicoAPI", {
  getVersion: () => ipcRenderer.invoke("app:version"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  getMonitorState: () => ipcRenderer.invoke("monitor:get-state"),
  saveMonitorSettings: (settings) => ipcRenderer.invoke("monitor:save-settings", settings),
  addMonitorTarget: (target) => ipcRenderer.invoke("monitor:add-target", target),
  removeMonitorTarget: (userId) => ipcRenderer.invoke("monitor:remove-target", userId),
  startMonitor: () => ipcRenderer.invoke("monitor:start"),
  stopMonitor: () => ipcRenderer.invoke("monitor:stop"),
  openLogin: () => ipcRenderer.invoke("auth:open-login"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  openWatch: (liveId) => ipcRenderer.invoke("live:open-watch", liveId),
  connectLive: (liveId) => ipcRenderer.invoke("live:connect", liveId),
  disconnectLive: () => ipcRenderer.invoke("live:disconnect"),
  getVideoToolStatus: () => ipcRenderer.invoke("video:tools-status"),
  startVideo: (liveId, quality) => ipcRenderer.invoke("video:start", liveId, quality),
  stopVideo: () => ipcRenderer.invoke("video:stop"),
  openDataFolder: () => ipcRenderer.invoke("data:open-folder"),
  exportCsv: () => ipcRenderer.invoke("comments:export-csv"),
  exportAss: () => ipcRenderer.invoke("comments:export-ass"),
  startCompose: () => ipcRenderer.invoke("compose:start"),
  writeComposeChunk: (chunk) => ipcRenderer.invoke("compose:chunk", chunk),
  finishCompose: () => ipcRenderer.invoke("compose:finish"),
  cancelCompose: () => ipcRenderer.invoke("compose:cancel"),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("app:event", handler);
    return () => ipcRenderer.removeListener("app:event", handler);
  }
});