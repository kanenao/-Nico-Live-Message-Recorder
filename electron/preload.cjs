const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nicoAPI", {
  getVersion: () => ipcRenderer.invoke("app:version"),
  getChangelog: () => ipcRenderer.invoke("app:changelog"),
  openGitHubReleases: () => ipcRenderer.invoke("app:open-releases"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  getMonitorState: () => ipcRenderer.invoke("monitor:get-state"),
  getOllamaStatus: () => ipcRenderer.invoke("ollama:get-status"),
  saveMonitorSettings: (settings) => ipcRenderer.invoke("monitor:save-settings", settings),
  notifyMonitorRecordingResult: (result) => ipcRenderer.invoke("monitor:notify-recording-result", result),
  addMonitorTarget: (target) => ipcRenderer.invoke("monitor:add-target", target),
  removeMonitorTarget: (userId) => ipcRenderer.invoke("monitor:remove-target", userId),
  startMonitor: () => ipcRenderer.invoke("monitor:start"),
  stopMonitor: () => ipcRenderer.invoke("monitor:stop"),
  retryMonitorTarget: (target) => ipcRenderer.invoke("monitor:retry-target", target),
  openLogin: () => ipcRenderer.invoke("auth:open-login"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  openWatch: (liveId) => ipcRenderer.invoke("live:open-watch", liveId),
  openLivePreview: (liveId) => ipcRenderer.invoke("preview:open", liveId),
  closeLivePreview: () => ipcRenderer.invoke("preview:close"),
  connectLive: (liveId) => ipcRenderer.invoke("live:connect", liveId),
  disconnectLive: () => ipcRenderer.invoke("live:disconnect"),
  getVideoToolStatus: () => ipcRenderer.invoke("video:tools-status"),
  getCaptureLibrary: () => ipcRenderer.invoke("library:list"),
  getBroadcastArticles: () => ipcRenderer.invoke("articles:list"),
  generateBroadcastArticle: (filePath) => ipcRenderer.invoke("articles:generate-from-comment", filePath),
  generateManualBroadcastArticle: (input) => ipcRenderer.invoke("articles:generate-manual", input),
  selectArticleVideo: () => ipcRenderer.invoke("articles:select-video"),
  openLibraryItem: (filePath) => ipcRenderer.invoke("library:open-item", filePath),
  showLibraryItem: (filePath) => ipcRenderer.invoke("library:show-item", filePath),
  deleteLibraryVideo: (filePath) => ipcRenderer.invoke("library:delete-video", filePath),
  startVideo: (liveId, quality, options) => ipcRenderer.invoke("video:start", liveId, quality, options),
  startCapture: (liveId, quality, options) => ipcRenderer.invoke("capture:start", liveId, quality, options),
  stopVideo: () => ipcRenderer.invoke("video:stop"),
  openDataFolder: () => ipcRenderer.invoke("data:open-folder"),
  exportCsv: () => ipcRenderer.invoke("comments:export-csv"),
  exportAss: () => ipcRenderer.invoke("comments:export-ass"),
  startCompose: (options) => ipcRenderer.invoke("compose:start", options),
  writeComposeChunk: (chunk) => ipcRenderer.invoke("compose:chunk", chunk),
  finishCompose: () => ipcRenderer.invoke("compose:finish"),
  cancelCompose: () => ipcRenderer.invoke("compose:cancel"),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("app:event", handler);
    return () => ipcRenderer.removeListener("app:event", handler);
  }
});