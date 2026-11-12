const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const {
  findStreamlinkExecutable,
  findFfmpegExecutable,
  findBundledStreamlinkExecutable,
  findBundledFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs
} = require("./streamlink.cjs");
const { generateAssFromRecords } = require("./ass.cjs");
const {
  normalizeCompositionFormat,
  normalizeCompositionQuality,
  buildMp4TranscodeArgs
} = require("./composition-export.cjs");
const { fetchTimeshiftProgramPage, fetchTimeshiftArchive } = require("./timeshift-comments.cjs");
const { autoUpdater } = require("electron-updater");
const { normalizeNicoUserId, normalizeMonitorDate, fetchUserBroadcastStatus, fetchFollowingOnAirPrograms, fetchNicoUserName } = require("./monitor.cjs");
const {
  compareReleaseVersions,
  fetchLatestWindowsRelease,
  getActiveManagedRuntime,
  installWindowsPortableRelease
} = require("./streamlink-update.cjs");
const fs = require("node:fs");
const path = require("node:path");

// This is a local desktop media-processing app; allow the selected local video to play for composition.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.setName("Nico Live Message Recorder");

let mainWindow = null;
let loginWindow = null;
let livePreviewWindow = null;
let livePreviewId = "";
let provider = null;
let timeshiftCommentFetchActive = false;
let currentLiveId = "";
let commentWriter = null;
let commentFilePath = "";
let currentBroadcasterName = "";
let currentBroadcasterId = "";
let streamlinkLiveId = "";
let streamlinkBroadcasterName = "";
let streamlinkBroadcasterId = "";
const monitorUserNameCache = new Map();
let streamlinkProcess = null;
let streamlinkFinalizePromise = null;
let streamlinkRuntimeDirectory = "";
let streamlinkOutputPath = "";
let streamlinkFinalOutputPath = "";
let streamlinkFfmpegPath = "";
let streamlinkStopRequested = false;
let composeWriter = null;
let composeFilePath = "";
let composeFinalFilePath = "";
let composeOutputFormat = "webm";
let composeOutputQuality = "standard";
let composeFinalizePromise = null;
let shutdownPromise = null;
let shutdownComplete = false;
let updateCheckPromise = null;
let downloadedUpdateInfo = null;
let monitorTimer = null;
let monitorRunning = false;
let monitorChecking = false;
let monitorLastCheckAt = null;
const monitorTargetStatuses = new Map();

function dataRoot() {
  const root = path.join(app.getPath("videos"), "NicoLiveRecorder");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeLiveId(value) {
  const match = String(value || "").trim().match(/(?:lv)?(\d{5,})/i);
  if (!match) throw new Error("放送IDまたは視聴URLを入力してください。");
  return "lv" + match[1];
}

function stamp() {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:event", { channel, payload });
  }
}

function isExecutableInsideInstallDirectory(installDirectory) {
  if (!installDirectory) return false;
  const expandedDirectory = String(installDirectory).replace(/%([^%]+)%/g, (_, key) =>
    process.env[key] || "%" + key + "%"
  );
  const normalizedDirectory = path.resolve(expandedDirectory);
  const executablePath = path.resolve(process.execPath);
  const relativePath = path.relative(normalizedDirectory, executablePath);
  return Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(".." + path.sep) &&
    !path.isAbsolute(relativePath);
}

function readRegistryString(block, valueName) {
  const match = String(block || "").match(
    new RegExp("^\\s*" + valueName + "\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$", "im")
  );
  return match ? match[1].trim() : "";
}

function isNsisInstalled() {
  if (!app.isPackaged || process.platform !== "win32") return false;

  const markerKeys = [
    "HKCU\\Software\\kanenao\\NicoLiveMessageRecorder",
    "HKLM\\Software\\kanenao\\NicoLiveMessageRecorder"
  ];
  for (const registryKey of markerKeys) {
    try {
      const output = execFileSync("reg.exe", [
        "query", registryKey, "/v", "InstallLocation"
      ], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const location = readRegistryString(output, "InstallLocation");
      if (isExecutableInsideInstallDirectory(location)) return true;
    } catch (_) {
      // Existing installations may predate our stable marker; inspect NSIS uninstall entries below.
    }
  }

  // electron-builder's NSIS target records its uninstaller under the standard
  // Windows Uninstall registry tree. Older releases did not write our custom marker.
  const uninstallRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
  ];
  for (const root of uninstallRoots) {
    try {
      const output = execFileSync("reg.exe", ["query", root, "/s"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024
      });
      const entries = output.split(/(?=^HKEY_)/m);
      for (const entry of entries) {
        const displayName = readRegistryString(entry, "DisplayName");
        if (displayName !== "Nico Live Message Recorder") continue;

        const installLocation = readRegistryString(entry, "InstallLocation");
        if (isExecutableInsideInstallDirectory(installLocation)) return true;

        const uninstallCommand = readRegistryString(entry, "UninstallString");
        let uninstallExecutable = "";
        if (uninstallCommand.startsWith('"')) {
          const closingQuote = uninstallCommand.indexOf('"', 1);
          if (closingQuote > 1) uninstallExecutable = uninstallCommand.slice(1, closingQuote);
        } else {
          const commandMatch = uninstallCommand.match(/^(.+?\.exe)(?:\s|$)/i);
          if (commandMatch) uninstallExecutable = commandMatch[1];
        }
        if (uninstallExecutable &&
            isExecutableInsideInstallDirectory(path.dirname(uninstallExecutable))) {
          return true;
        }
      }
    } catch (_) {
      // Try the next registry view/root. Portable ZIP builds have no NSIS uninstall entry.
    }
  }
  return false;
}
function isAutoUpdateSupported() {
  return isNsisInstalled();
}

function sendUpdateState(state, details = {}) {
  send("update:state", { state, ...details });
}

function configureAutoUpdater() {
  if (!isAutoUpdateSupported()) return false;

  // The GitHub publisher writes beta.yml; only beta and newer stable releases are accepted.
  autoUpdater.channel = "beta";
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    sendUpdateState("checking");
  });

  autoUpdater.on("update-available", (info) => {
    sendUpdateState("available", {
      version: info && info.version ? info.version : "",
      releaseDate: info && info.releaseDate ? info.releaseDate : null
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    sendUpdateState("not-available", {
      version: info && info.version ? info.version : app.getVersion()
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateState("progress", {
      percent: Number(progress && progress.percent) || 0,
      bytesPerSecond: Number(progress && progress.bytesPerSecond) || 0,
      transferred: Number(progress && progress.transferred) || 0,
      total: Number(progress && progress.total) || 0
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedUpdateInfo = info || {};
    sendUpdateState("downloaded", {
      version: info && info.version ? info.version : ""
    });
  });

  autoUpdater.on("error", (error) => {
    sendUpdateState("error", {
      message: error && error.message ? error.message : String(error)
    });
  });

  return true;
}

function checkForUpdatesNow() {
  if (!isAutoUpdateSupported()) {
    const result = {
      supported: false,
      reason: "自動アップデートはWindowsのNSISインストーラー版で利用できます。ZIP版は手動更新してください。"
    };
    sendUpdateState("unsupported", { message: result.reason });
    return Promise.resolve(result);
  }
  if (updateCheckPromise) return updateCheckPromise;

  sendUpdateState("checking");
  updateCheckPromise = autoUpdater.checkForUpdates()
    .then((result) => ({
      supported: true,
      version: result && result.updateInfo ? result.updateInfo.version : null
    }))
    .catch((error) => {
      sendUpdateState("error", {
        message: error && error.message ? error.message : String(error)
      });
      throw error;
    })
    .finally(() => {
      updateCheckPromise = null;
    });
  return updateCheckPromise;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function normalizeEvent(type, item) {
  const data = item || {};
  const result = {
    type,
    liveId: currentLiveId,
    receivedAt: new Date().toISOString(),
    timestamp: toIso(data.timestamp),
    isHistory: Boolean(data.isHistory)
  };

  const keys = [
    "id", "content", "userId", "userName", "itemId", "itemName",
    "point", "message", "name", "link", "mail"
  ];
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) {
      result[key] = key === "mail" && Array.isArray(data[key])
        ? data[key].join(" ")
        : (typeof data[key] === "string" ? data[key] : String(data[key]));
    }
  }
  return result;
}

function sanitizeFolderSegment(value) {
  let name = String(value || "").normalize("NFKC");
  name = Array.from(name).map((character) => {
    return '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32
      ? "_" : character;
  }).join("");
  name = name.replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 56);
  if (!name || /^\.+$/.test(name)) name = "配信者名未取得";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "_" + name;
  return name;
}

function broadcasterFolderName(name, userId) {
  const label = sanitizeFolderSegment(name || (userId ? "ユーザー" : "配信者名未取得"));
  const id = /^\d{5,}$/.test(String(userId || "")) ? "_" + String(userId) : "";
  return (label + id).slice(0, 76);
}

function getCommentFormat() {
  const settings = readAppSettings();
  const value = settings.monitor && settings.monitor.commentFormat;
  return ["jsonl", "csv", "ass", "all"].includes(value) ? value : "jsonl";
}

function recordsToCsv(records) {
  const quote = (value) => '"' + String(value === undefined || value === null ? "" : value).replace(/"/g, '""') + '"';
  const rows = ["種別,日時,ユーザー名,ユーザーID,内容"];
  for (const row of records) {
    rows.push([
      row.type, row.timestamp, row.userName || row.name || "",
      row.userId || "", row.content || row.message || row.itemName || row.id || ""
    ].map(quote).join(","));
  }
  return "\uFEFF" + rows.join("\r\n");
}

async function exportCommentSidecars(sourcePath) {
  const format = getCommentFormat();
  const formats = format === "all" ? ["csv", "ass"] : (format === "jsonl" ? [] : [format]);
  if (!formats.length || !sourcePath || !fs.existsSync(sourcePath)) return [];

  const records = [];
  for (const line of fs.readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch (_) {}
  }
  const written = [];
  for (const outputFormat of formats) {
    const outputPath = sourcePath.replace(/\.jsonl$/i, "." + outputFormat);
    const output = outputFormat === "csv"
      ? recordsToCsv(records)
      : generateAssFromRecords(records);
    fs.writeFileSync(outputPath, output, "utf8");
    written.push(outputPath);
  }
  if (written.length) send("comments:exports", { paths: written });
  return written;
}

async function moveCommentLogToBroadcasterFolder(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return sourcePath;
  const folder = broadcasterFolderName(currentBroadcasterName, currentBroadcasterId);
  const destinationDirectory = path.join(dataRoot(), "comments", folder);
  if (path.resolve(path.dirname(sourcePath)) === path.resolve(destinationDirectory)) return sourcePath;
  fs.mkdirSync(destinationDirectory, { recursive: true });
  let destinationPath = path.join(destinationDirectory, path.basename(sourcePath));
  if (fs.existsSync(destinationPath)) {
    destinationPath = path.join(destinationDirectory,
      path.basename(sourcePath, ".jsonl") + "_" + stamp() + ".jsonl");
  }
  await fs.promises.rename(sourcePath, destinationPath);
  return destinationPath;
}

function openCommentWriter(liveId, displayName = "", broadcasterId = "") {
  currentBroadcasterName = String(displayName || "").trim();
  currentBroadcasterId = String(broadcasterId || "");
  const directory = path.join(dataRoot(), "comments",
    broadcasterFolderName(currentBroadcasterName, currentBroadcasterId));
  fs.mkdirSync(directory, { recursive: true });
  commentFilePath = path.join(directory, liveId + "_" + stamp() + ".jsonl");
  commentWriter = fs.createWriteStream(commentFilePath, { flags: "wx" });
  commentWriter.on("error", (error) => {
    send("app:error", "コメントファイルの保存に失敗しました: " + error.message);
  });
  appendMarker("sessionStart", {
    sessionStartedAt: new Date().toISOString(),
    broadcasterName: currentBroadcasterName,
    broadcasterId: currentBroadcasterId
  });
  send("comments:file", { path: commentFilePath });
}

function updateCurrentBroadcaster(metadata, liveId) {
  if (!metadata || (liveId && currentLiveId !== liveId)) return;
  const name = String(metadata.broadcasterName || metadata.providerName ||
    (metadata.provider && metadata.provider.name) || "").trim();
  const id = String(metadata.broadcasterId || metadata.providerId ||
    (metadata.provider && metadata.provider.id) || "").trim();
  if (name) {
    currentBroadcasterName = name.slice(0, 80);
    if (streamlinkLiveId && (!liveId || streamlinkLiveId === liveId)) {
      streamlinkBroadcasterName = currentBroadcasterName;
    }
  }
  if (id) {
    currentBroadcasterId = id;
    if (streamlinkLiveId && (!liveId || streamlinkLiveId === liveId)) {
      streamlinkBroadcasterId = id;
    }
  }
}

function appendEvent(type, item) {
  const record = normalizeEvent(type, item);
  if (commentWriter) commentWriter.write(JSON.stringify(record) + "\n");
  send("live:event", record);
}

function appendMarker(type, fields = {}) {
  if (!commentWriter) return;
  const timestamp = new Date().toISOString();
  const marker = { type, liveId: currentLiveId, timestamp, receivedAt: timestamp, ...fields };
  commentWriter.write(JSON.stringify(marker) + "\n");
}

function closeCommentWriter() {
  return new Promise((resolve) => {
    if (!commentWriter) {
      resolve();
      return;
    }
    const writer = commentWriter;
    const oldPath = commentFilePath;
    commentWriter = null;
    writer.end(async () => {
      try {
        commentFilePath = await moveCommentLogToBroadcasterFolder(oldPath);
        send("comments:file", { path: commentFilePath });
        await exportCommentSidecars(commentFilePath);
      } catch (error) {
        send("app:error", "コメントファイルの整理・形式変換に失敗しました: " + error.message);
      }
      resolve();
    });
  });
}

function makeWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0b1020",
    title: "Nico Live Message Recorder",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const contents = mainWindow.webContents;
  contents.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const flags = params.editFlags || {};
    const template = [];
    if (params.isEditable) {
      template.push({ label: "元に戻す", role: "undo", enabled: Boolean(flags.canUndo) });
      template.push({ label: "やり直す", role: "redo", enabled: Boolean(flags.canRedo) });
      template.push({ type: "separator" });
      template.push({ label: "切り取り", role: "cut", enabled: Boolean(flags.canCut) });
      template.push({ label: "コピー", role: "copy", enabled: Boolean(flags.canCopy) });
      template.push({ label: "貼り付け", role: "paste", enabled: Boolean(flags.canPaste) });
      template.push({ label: "削除", role: "delete", enabled: Boolean(flags.canDelete) });
      template.push({ type: "separator" });
      template.push({ label: "すべて選択", role: "selectAll", enabled: Boolean(flags.canSelectAll) });
    } else {
      if (flags.canCopy) template.push({ label: "コピー", role: "copy" });
      if (flags.canSelectAll) template.push({ label: "すべて選択", role: "selectAll" });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const modified = process.platform === "darwin" ? input.meta : input.control;
    if (!modified) return;
    const key = String(input.key || "").toLowerCase();
    const actions = { x: "cut", c: "copy", v: "paste", a: "selectAll", z: input.shift ? "redo" : "undo", y: "redo" };
    const action = actions[key];
    if (!action || typeof contents[action] !== "function") return;
    event.preventDefault();
    contents[action]();
  });

  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("updates:check", () => checkForUpdatesNow());

ipcMain.handle("updates:install", async () => {
  if (!isAutoUpdateSupported()) {
    throw new Error("自動アップデートはWindowsのインストーラー版で利用できます。");
  }
  if (!downloadedUpdateInfo) {
    throw new Error("インストールできる更新データがまだありません。");
  }

  // Preserve active recordings and close comment logs before handing control to NSIS.
  await shutdownGracefully();
  shutdownComplete = true;
  autoUpdater.quitAndInstall(false, true);
  return { installing: true };
});

ipcMain.handle("auth:open-login", async () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { opened: true };
  }

  loginWindow = new BrowserWindow({
    width: 520,
    height: 760,
    title: "ニコニコにログイン",
    autoHideMenuBar: true,
    webPreferences: {
      partition: "persist:nico-auth",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  loginWindow.on("closed", () => {
    loginWindow = null;
    send("auth:status", { checked: true });
  });
  await loginWindow.loadURL("https://account.nicovideo.jp/login");
  return { opened: true };
});

ipcMain.handle("auth:status", async () => {
  const authSession = session.fromPartition("persist:nico-auth");
  const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
  const loggedIn = cookies.some((cookie) => cookie.name === "user_session" && cookie.value);
  return { loggedIn };
});

ipcMain.handle("live:open-watch", async (_event, value) => {
  const liveId = safeLiveId(value);
  await shell.openExternal("https://live.nicovideo.jp/watch/" + liveId);
  return { liveId };
});

function sendLivePreviewState(state, details = {}) {
  send("preview:state", { state, liveId: livePreviewId, ...details });
}

async function openLivePreview(value) {
  const liveId = safeLiveId(value);
  const url = "https://live.nicovideo.jp/watch/" + liveId;

  if (livePreviewWindow && !livePreviewWindow.isDestroyed()) {
    if (livePreviewId !== liveId) {
      livePreviewId = liveId;
      sendLivePreviewState("opening");
      await livePreviewWindow.loadURL(url);
    }
    if (livePreviewWindow.isMinimized()) livePreviewWindow.restore();
    livePreviewWindow.show();
    livePreviewWindow.focus();
    sendLivePreviewState("opened");
    return { liveId, reused: true };
  }

  livePreviewId = liveId;
  livePreviewWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#080d18",
    title: "ニコ生 映像プレビュー - " + liveId,
    autoHideMenuBar: true,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      partition: "persist:nico-auth",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const preview = livePreviewWindow;
  preview.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) {
      shell.openExternal(targetUrl).catch((error) => console.error("Preview external link failed:", error));
    }
    return { action: "deny" };
  });
  preview.webContents.on("did-fail-load", (_event, errorCode, description, failedUrl, isMainFrame) => {
    if (isMainFrame && livePreviewWindow === preview) {
      sendLivePreviewState("error", {
        message: description || ("ページ読み込みエラー " + errorCode),
        url: failedUrl
      });
    }
  });
  preview.on("closed", () => {
    if (livePreviewWindow === preview) {
      livePreviewWindow = null;
      livePreviewId = "";
      send("preview:state", { state: "closed" });
    }
  });

  sendLivePreviewState("opening");
  try {
    await preview.loadURL(url);
    if (!preview.isDestroyed()) {
      preview.show();
      preview.focus();
      sendLivePreviewState("opened");
    }
    return { liveId, reused: false };
  } catch (error) {
    if (!preview.isDestroyed()) preview.close();
    sendLivePreviewState("error", { message: error.message || String(error) });
    throw error;
  }
}

function closeLivePreview() {
  if (!livePreviewWindow || livePreviewWindow.isDestroyed()) {
    livePreviewWindow = null;
    livePreviewId = "";
    send("preview:state", { state: "closed" });
    return { closed: true, alreadyClosed: true };
  }
  livePreviewWindow.close();
  return { closed: true };
}

ipcMain.handle("preview:open", (_event, value) => openLivePreview(value));
ipcMain.handle("preview:close", () => closeLivePreview());

async function prepareCommentSession(liveId, displayName = "", broadcasterId = "") {
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
    provider = null;
  }
  await closeCommentWriter();
  currentLiveId = liveId;
  openCommentWriter(liveId, displayName, broadcasterId);
  send("live:state", { state: "connecting" });
}

async function connectPreparedCommentSession(liveId) {
  try {
    const authSession = session.fromPartition("persist:nico-auth");
    const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
    const cookieHeader = cookies.map((cookie) => cookie.name + "=" + cookie.value).join("; ");

    const library = await import("nicomget");
    const NiconicoProvider = library.NiconicoProvider;
    if (!NiconicoProvider) throw new Error("コメント取得ライブラリを読み込めませんでした。");

    provider = new NiconicoProvider({
      liveId,
      cookies: cookieHeader || undefined,
      maxRetries: 10,
      retryIntervalMs: 5000,
      fetchBacklog: true,
      backlogEvents: ["chat", "gift", "emotion", "notification", "operatorComment"]
    });

    provider.on("comment", (data) => appendEvent("comment", data));
    provider.on("gift", (data) => appendEvent("gift", data));
    provider.on("emotion", (data) => appendEvent("emotion", data));
    provider.on("notification", (data) => appendEvent("notification", data));
    provider.on("operatorComment", (data) => appendEvent("operatorComment", data));
    provider.on("metadata", (metadata) => {
      updateCurrentBroadcaster(metadata, liveId);
      send("live:metadata", metadata);
    });
    provider.on("stateChange", (state) => send("live:state", { state }));
    provider.on("error", (error) => {
      send("app:error", error && error.message ? error.message : String(error));
    });

    const metadata = await provider.connect();
    updateCurrentBroadcaster(metadata, liveId);
    send("live:state", { state: "connected" });
    return { liveId, metadata, commentFile: commentFilePath };
  } catch (error) {
    if (provider) {
      try { provider.disconnect(); } catch (_) {}
      provider = null;
    }
    await closeCommentWriter();
    send("live:state", { state: "error" });
    throw new Error(error && error.message ? error.message : "コメント接続に失敗しました。");
  }
}

ipcMain.handle("live:connect", async (_event, value, options = {}) => {
  if (timeshiftCommentFetchActive) {
    throw new Error("過去配信のコメント取得中です。完了後にコメント接続を開始してください。");
  }
  const liveId = safeLiveId(value);
  await prepareCommentSession(liveId,
    options && options.displayName || "",
    options && options.broadcasterId || "");
  return connectPreparedCommentSession(liveId);
});
ipcMain.handle("live:disconnect", async () => {
  if (timeshiftCommentFetchActive) {
    throw new Error("過去配信のコメント取得中は切断できません。");
  }
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
    provider = null;
  }
  await closeCommentWriter();
  currentLiveId = "";
  send("live:state", { state: "disconnected" });
  return { disconnected: true };
});


function readAppSettings() {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeAppSettings(patch) {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  const current = readAppSettings();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}


const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  intervalSeconds: 60,
  autoRecord: true,
  autoStart: true,
  quality: "best",
  commentFormat: "jsonl",
  autoUpdateStreamlink: true,
  targets: []
});

function getMonitorSettings() {
  const stored = readAppSettings().monitor || {};
  const targets = Array.isArray(stored.targets) ? stored.targets : [];
  return {
    ...DEFAULT_MONITOR_SETTINGS,
    ...stored,
    intervalSeconds: [15, 30, 60, 120, 300].includes(Number(stored.intervalSeconds))
      ? Number(stored.intervalSeconds)
      : DEFAULT_MONITOR_SETTINGS.intervalSeconds,
    autoRecord: stored.autoRecord !== false,
    autoStart: stored.autoStart !== false,
    quality: stored.quality === "worst" ? "worst" : "best",
    commentFormat: ["jsonl", "csv", "ass", "all"].includes(stored.commentFormat) ? stored.commentFormat : "jsonl",
    autoUpdateStreamlink: stored.autoUpdateStreamlink !== false,
    targets: targets
      .filter((target) => target && /^\d{5,}$/.test(String(target.userId || "")))
      .map((target) => ({
        userId: String(target.userId),
        name: String(target.name || "").slice(0, 80),
        enabled: target.enabled !== false,
        lastProgramId: String(target.lastProgramId || "")
      }))
  };
}

function saveMonitorSettings(nextSettings) {
  const current = getMonitorSettings();
  const candidate = { ...current, ...(nextSettings || {}) };
  const intervalSeconds = Number(candidate.intervalSeconds);
  if (![15, 30, 60, 120, 300].includes(intervalSeconds)) {
    throw new Error("監視間隔は15秒・30秒・1分・2分・5分から選択してください。");
  }
  const normalized = {
    intervalSeconds,
    autoRecord: candidate.autoRecord !== false,
    autoStart: candidate.autoStart !== false,
    quality: candidate.quality === "worst" ? "worst" : "best",
    commentFormat: ["jsonl", "csv", "ass", "all"].includes(candidate.commentFormat) ? candidate.commentFormat : "jsonl",
    autoUpdateStreamlink: candidate.autoUpdateStreamlink !== false,
    targets: current.targets
  };
  writeAppSettings({ monitor: normalized });
  if (monitorRunning) restartMonitorTimer();

  if (!normalized.autoUpdateStreamlink) {
    sendStreamlinkUpdateState("disabled", {
      message: "Streamlinkの自動更新は設定で無効です。"
    });
  } else if (!current.autoUpdateStreamlink && process.platform === "win32") {
    // Re-enabling automatic updates starts a check immediately instead of waiting
    // for the next six-hour timer tick.
    setTimeout(() => {
      checkStreamlinkUpdateNow({ autoInstall: true, silent: true });
    }, 1000);
  }
  return getMonitorState();
}

function getMonitorState() {
  return {
    running: monitorRunning,
    checking: monitorChecking,
    lastCheckAt: monitorLastCheckAt,
    settings: getMonitorSettings(),
    statuses: Object.fromEntries(monitorTargetStatuses.entries())
  };
}

function sendMonitorState(state, details = {}) {
  send("monitor:state", { running: monitorRunning, state, ...details });
}

async function getNicoCookieHeader() {
  const authSession = session.fromPartition("persist:nico-auth");
  const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
  if (!cookies.some((cookie) => cookie.name === "user_session" && cookie.value)) return "";

  const byName = new Map();
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue;
    const current = byName.get(cookie.name);
    if (!current || (cookie.domain || "").startsWith(".")) {
      byName.set(cookie.name, cookie);
    }
  }
  return Array.from(byName.values())
    .map((cookie) => cookie.name + "=" + cookie.value)
    .join("; ");
}

async function resolveMonitorUserName(target, followedProgram, latestProgram) {
  const directName = String(
    (followedProgram && followedProgram.providerName) ||
    (latestProgram && latestProgram.providerName) || ""
  ).trim();
  const savedName = String(target.name || "").trim();
  let resolvedName = directName || (/^ユーザー \d+$/.test(savedName) ? "" : savedName);

  if (!resolvedName) {
    const cached = monitorUserNameCache.get(target.userId);
    if (cached && cached.name) {
      resolvedName = cached.name;
    } else if (!cached || Date.now() - cached.checkedAt > 6 * 60 * 60 * 1000) {
      try {
        resolvedName = await fetchNicoUserName(target.userId);
        monitorUserNameCache.set(target.userId, { name: resolvedName, checkedAt: Date.now() });
      } catch (error) {
        monitorUserNameCache.set(target.userId, { name: "", checkedAt: Date.now() });
        console.warn("Could not resolve Nico broadcaster name:", target.userId, error);
      }
    }
  }

  if (!resolvedName) resolvedName = "ユーザー " + target.userId;
  if (resolvedName && resolvedName !== target.name && !/^ユーザー \d+$/.test(resolvedName)) {
    const updated = getMonitorSettings();
    const match = updated.targets.find((item) => item.userId === target.userId);
    if (match) {
      match.name = resolvedName.slice(0, 80);
      writeAppSettings({ monitor: updated });
    }
  }
  return resolvedName.slice(0, 80);
}

async function checkMonitoredUsers() {
  if (!monitorRunning || monitorChecking) return;
  monitorChecking = true;
  monitorLastCheckAt = new Date().toISOString();
  sendMonitorState("checking", { checkedAt: monitorLastCheckAt });

  try {
    const config = getMonitorSettings();
    const enabledTargets = config.targets.filter((item) => item.enabled);
    const targetIds = new Set(enabledTargets.map((item) => item.userId));
    const followedLiveByUser = new Map();

    // 参考アプリと同様に、ログイン中のフォロー中番組一覧を先に確認する。
    // 手動登録されたユーザーだけに絞り、対象外の配信を自動録画しない。
    try {
      const cookieHeader = await getNicoCookieHeader();
      if (cookieHeader) {
        const followedPrograms = await fetchFollowingOnAirPrograms(cookieHeader);
        for (const program of followedPrograms) {
          if (program.providerId && targetIds.has(program.providerId) &&
              !followedLiveByUser.has(program.providerId)) {
            followedLiveByUser.set(program.providerId, program);
          }
        }
      }
    } catch (error) {
      // フォロー中番組APIが使えない場合でも、公開放送履歴で監視を継続する。
      console.warn("Followed-program API unavailable; falling back to public history:", error);
    }

    for (const target of enabledTargets) {
      if (!monitorRunning) break;
      try {
        const followedProgram = followedLiveByUser.get(target.userId);
        const result = followedProgram ? null : await fetchUserBroadcastStatus(target.userId);
        const live = followedProgram
          ? {
              liveId: followedProgram.liveId,
              title: followedProgram.title,
              status: "ON_AIR",
              isFollowerOnly: followedProgram.isFollowerOnly,
              beginTime: followedProgram.beginAt
            }
          : result.live;
        const displayName = await resolveMonitorUserName(target, followedProgram, result && result.latest);
        const checkedAt = result ? result.checkedAt : new Date().toISOString();
        const latest = result ? result.latest : null;
        const source = followedProgram ? "フォロー中番組API" : "公開放送履歴API";
        const startedAt = live ? normalizeMonitorDate(live.beginTime || live.startedAt) : "";
        const endedAt = live ? normalizeMonitorDate(live.endTime || live.endedAt) : "";
        const status = {
          userId: target.userId,
          name: displayName,
          isLive: Boolean(live),
          liveId: live ? live.liveId : "",
          title: live ? live.title : (latest ? latest.title : ""),
          programStatus: live ? live.status : (latest ? latest.status : ""),
          startedAt,
          endedAt,
          watchPageUrl: live
            ? (followedProgram && followedProgram.watchPageUrl
              ? followedProgram.watchPageUrl
              : "https://live.nicovideo.jp/watch/" + live.liveId)
            : "",
          detectionSource: live ? source : "",
          isFollowerOnly: Boolean(live && live.isFollowerOnly),
          checkedAt,
          error: ""
        };
        monitorTargetStatuses.set(target.userId, status);
        send("monitor:target-status", status);

        if (live && target.lastProgramId !== live.liveId) {
          const updated = getMonitorSettings();
          const match = updated.targets.find((item) => item.userId === target.userId);
          if (match) {
            match.lastProgramId = live.liveId;
            writeAppSettings({ monitor: updated });
          }
          send("monitor:live-detected", {
            userId: target.userId,
            name: displayName,
            displayName,
            broadcasterId: target.userId,
            liveId: live.liveId,
            title: live.title,
            startedAt,
            watchPageUrl: status.watchPageUrl,
            source,
            isFollowerOnly: Boolean(live.isFollowerOnly),
            detectedAt: checkedAt
          });
        }
      } catch (error) {
        const status = {
          userId: target.userId,
          name: target.name,
          isLive: false,
          liveId: "",
          title: "",
          checkedAt: new Date().toISOString(),
          error: error && error.message ? error.message : String(error)
        };
        monitorTargetStatuses.set(target.userId, status);
        send("monitor:target-status", status);
        send("monitor:error", status);
      }
    }
  } finally {
    monitorChecking = false;
    if (monitorRunning) {
      monitorLastCheckAt = new Date().toISOString();
      sendMonitorState("idle", { checkedAt: monitorLastCheckAt });
    }
  }
}
function restartMonitorTimer() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  if (!monitorRunning) return;
  const intervalMs = getMonitorSettings().intervalSeconds * 1000;
  monitorTimer = setInterval(() => {
    checkMonitoredUsers().catch((error) => {
      sendMonitorState("error", {
        message: error && error.message ? error.message : String(error)
      });
    });
  }, intervalMs);
  if (typeof monitorTimer.unref === "function") monitorTimer.unref();
}

function startMonitor() {
  const config = getMonitorSettings();
  if (!config.targets.some((target) => target.enabled)) {
    throw new Error("監視するユーザーを先に登録してください。");
  }
  monitorRunning = true;
  restartMonitorTimer();
  sendMonitorState("running", { checkedAt: monitorLastCheckAt });
  checkMonitoredUsers().catch((error) => {
    sendMonitorState("error", {
      message: error && error.message ? error.message : String(error)
    });
  });
  return getMonitorState();
}

function stopMonitor() {
  monitorRunning = false;
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  sendMonitorState("stopped");
  return getMonitorState();
}

ipcMain.handle("monitor:get-state", () => getMonitorState());

ipcMain.handle("monitor:save-settings", (_event, values) => saveMonitorSettings(values));

ipcMain.handle("monitor:add-target", (_event, input) => {
  const userId = normalizeNicoUserId(input && input.userId);
  const config = getMonitorSettings();
  const existing = config.targets.find((target) => target.userId === userId);
  if (existing) throw new Error("このユーザーはすでに監視リストに登録されています。");
  config.targets.push({
    userId,
    name: String(input && input.name || "").trim().slice(0, 80),
    enabled: true,
    lastProgramId: ""
  });
  writeAppSettings({ monitor: config });
  sendMonitorState(monitorRunning ? "running" : "stopped", { settings: getMonitorSettings() });
  return getMonitorState();
});

ipcMain.handle("monitor:remove-target", (_event, rawUserId) => {
  const userId = normalizeNicoUserId(rawUserId);
  const config = getMonitorSettings();
  config.targets = config.targets.filter((target) => target.userId !== userId);
  writeAppSettings({ monitor: config });
  monitorTargetStatuses.delete(userId);
  sendMonitorState(monitorRunning ? "running" : "stopped", { settings: getMonitorSettings() });
  return getMonitorState();
});

ipcMain.handle("monitor:start", () => startMonitor());
ipcMain.handle("monitor:stop", () => stopMonitor());

ipcMain.handle("monitor:retry-target", (_event, input) => {
  const userId = normalizeNicoUserId(input && input.userId);
  const liveId = String(input && input.liveId || "");
  const config = getMonitorSettings();
  const target = config.targets.find((item) => item.userId === userId);
  if (target && (!liveId || target.lastProgramId === liveId)) {
    target.lastProgramId = "";
    writeAppSettings({ monitor: config });
  }
  return getMonitorState();
});

function getStreamlinkBundleRoot() {
  const managedRuntime = getActiveManagedRuntime(app.getPath("userData"));
  if (managedRuntime) return managedRuntime.root;
  return app.isPackaged
    ? path.join(process.resourcesPath, "streamlink")
    : path.join(__dirname, "..", "vendor", "streamlink");
}

function getVideoToolStatus() {
  const settings = readAppSettings();
  const managedRuntime = getActiveManagedRuntime(app.getPath("userData"));
  const bundleRoot = getStreamlinkBundleRoot();
  const bundledStreamlinkPath = findBundledStreamlinkExecutable(bundleRoot);
  const bundledFfmpegPath = findBundledFfmpegExecutable(bundleRoot);
  const streamlinkPath = bundledStreamlinkPath || findStreamlinkExecutable({
    customPath: settings.streamlinkPath
  });
  const ffmpegPath = bundledFfmpegPath || findFfmpegExecutable({
    customPath: settings.ffmpegPath,
    streamlinkPath
  });
  return {
    streamlinkAvailable: Boolean(streamlinkPath),
    streamlinkPath,
    streamlinkBundled: Boolean(bundledStreamlinkPath),
    streamlinkVersion: managedRuntime ? managedRuntime.version : (bundledStreamlinkPath ? "8.6.3-1" : null),
    streamlinkManaged: Boolean(managedRuntime),
    ffmpegAvailable: Boolean(ffmpegPath),
    ffmpegPath,
    ffmpegBundled: Boolean(bundledFfmpegPath)
  };
}

function remuxTransportStreamToMp4(inputPath, outputPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:v?", "-map", "0:a?",
      "-c", "copy", "-movflags", "+faststart",
      outputPath
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-1200);
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
      } else {
        reject(new Error(stderr.trim() || "FFmpegによるMP4変換に失敗しました。"));
      }
    });
  });
}

async function finalizeStreamlinkRecording(exit) {
  const stoppedAt = new Date().toISOString();
  const rawPath = streamlinkOutputPath;
  const ffmpegPath = streamlinkFfmpegPath;
  let finalPath = rawPath;
  let converted = false;
  const hasOutput = rawPath && fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0;

  if (hasOutput && ffmpegPath) {
    const mp4Path = rawPath.replace(/\.ts$/i, ".mp4");
    try {
      await remuxTransportStreamToMp4(rawPath, mp4Path, ffmpegPath);
      await fs.promises.unlink(rawPath).catch(() => {});
      finalPath = mp4Path;
      streamlinkFinalOutputPath = mp4Path;
      converted = true;
    } catch (_) {
      send("app:error", "MP4変換に失敗したため、元のTSファイルを保存しました。FFmpegの設定を確認してください。");
    }
  }

  if (currentLiveId && commentWriter) {
    appendMarker("videoStop", {
      timestamp: stoppedAt,
      receivedAt: stoppedAt,
      videoStoppedAt: stoppedAt,
      videoFile: finalPath || rawPath,
      sourceVideoFile: rawPath
    });
  }

  if (hasOutput && finalPath && streamlinkLiveId) {
    try {
      const finalDirectory = path.join(dataRoot(), "videos",
        broadcasterFolderName(streamlinkBroadcasterName || currentBroadcasterName, streamlinkBroadcasterId || currentBroadcasterId));
      fs.mkdirSync(finalDirectory, { recursive: true });
      if (path.resolve(path.dirname(finalPath)) !== path.resolve(finalDirectory)) {
        let organizedPath = path.join(finalDirectory, path.basename(finalPath));
        if (fs.existsSync(organizedPath)) {
          organizedPath = path.join(finalDirectory,
            path.basename(finalPath, path.extname(finalPath)) + "_" + stamp() + path.extname(finalPath));
        }
        await fs.promises.rename(finalPath, organizedPath);
        finalPath = organizedPath;
        streamlinkFinalOutputPath = organizedPath;
      }
    } catch (error) {
      send("app:error", "配信者フォルダーへの整理に失敗しました。元の保存先に残しています: " + error.message);
    }
  }

  const runtimeDirectory = streamlinkRuntimeDirectory;
  streamlinkProcess = null;
  streamlinkFinalizePromise = null;
  streamlinkRuntimeDirectory = "";
  streamlinkOutputPath = "";
  streamlinkFinalOutputPath = "";
  streamlinkLiveId = "";
  streamlinkBroadcasterName = "";
  streamlinkBroadcasterId = "";
  streamlinkFfmpegPath = "";
  if (runtimeDirectory) {
    await fs.promises.rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
  }

  const resultPath = hasOutput ? finalPath : null;
  const result = {
    path: resultPath,
    rawPath: hasOutput ? rawPath : null,
    converted,
    exitCode: exit.code,
    signal: exit.signal || null
  };
  send("video:state", { recording: false, ...result });

  if (!streamlinkStopRequested && exit.code !== 0) {
    send("app:error", "Streamlinkが終了コード " + exit.code + " で終了しました。配信の公開状態、視聴権限、Streamlinkのバージョンを確認してください。");
  } else if (!hasOutput) {
    send("app:error", "録画データが作成されませんでした。放送IDと視聴権限、Streamlinkの対応状況を確認してください。");
  }
  return result;
}

ipcMain.handle("video:tools-status", async () => getVideoToolStatus());

let streamlinkUpdateCheckPromise = null;

function sendStreamlinkUpdateState(state, details = {}) {
  send("streamlink:update-state", { state, ...details });
}

let streamlinkUpdateInstallPromise = null;

function installLatestStreamlinkRuntime(releaseInfo) {
  if (streamlinkUpdateInstallPromise) return streamlinkUpdateInstallPromise;
  streamlinkUpdateInstallPromise = (async () => {
    const info = releaseInfo || await fetchLatestWindowsRelease();
    const currentVersion = getVideoToolStatus().streamlinkVersion || "0.0.0-0";
    if (compareReleaseVersions(info.asset.version, currentVersion) <= 0) {
      sendStreamlinkUpdateState("current", { version: currentVersion });
      return { updated: false, currentVersion };
    }
    const installed = await installWindowsPortableRelease({
      userDataDirectory: app.getPath("userData"),
      release: info.release,
      asset: info.asset,
      onProgress: (progress) => sendStreamlinkUpdateState(progress.state, progress)
    });
    const status = getVideoToolStatus();
    sendStreamlinkUpdateState("updated", {
      version: installed.version,
      path: status.streamlinkPath,
      message: "Streamlinkを更新しました。次回の録画から新しいバージョンを使用します。"
    });
    return { updated: true, version: installed.version, status };
  })().finally(() => {
    streamlinkUpdateInstallPromise = null;
  });
  return streamlinkUpdateInstallPromise;
}

function checkStreamlinkUpdateNow(options = {}) {
  if (process.platform !== "win32") {
    const result = { supported: false, message: "Streamlinkの自動更新はWindows版で利用できます。" };
    sendStreamlinkUpdateState("unsupported", result);
    return Promise.resolve(result);
  }
  if (streamlinkUpdateCheckPromise) return streamlinkUpdateCheckPromise;
  sendStreamlinkUpdateState("checking");
  streamlinkUpdateCheckPromise = (async () => {
    const latest = await fetchLatestWindowsRelease();
    const currentVersion = getVideoToolStatus().streamlinkVersion || "0.0.0-0";
    const updateAvailable = compareReleaseVersions(latest.asset.version, currentVersion) > 0;
    if (!updateAvailable) {
      sendStreamlinkUpdateState("current", { version: currentVersion });
      return { supported: true, updateAvailable: false, currentVersion };
    }
    sendStreamlinkUpdateState("available", {
      version: latest.asset.version,
      currentVersion,
      message: "Streamlink " + latest.asset.version + " が公開されています。"
    });
    if (options.autoInstall && getMonitorSettings().autoUpdateStreamlink !== false) {
      return {
        supported: true,
        updateAvailable: true,
        ...(await installLatestStreamlinkRuntime(latest))
      };
    }
    return {
      supported: true,
      updateAvailable: true,
      currentVersion,
      version: latest.asset.version
    };
  })().catch((error) => {
    sendStreamlinkUpdateState("error", {
      message: error && error.message ? error.message : String(error)
    });
    if (options.silent) return { supported: true, error: error.message || String(error) };
    throw error;
  }).finally(() => {
    streamlinkUpdateCheckPromise = null;
  });
  return streamlinkUpdateCheckPromise;
}

async function startVideoInternal(value, quality, displayName = "", broadcasterId = "", options = {}) {
  if (streamlinkProcess) throw new Error("映像録画はすでに実行中です。");
  const liveId = safeLiveId(value);
  const timeshift = Boolean(options && options.timeshift);
  const toolStatus = getVideoToolStatus();
  const streamlinkPath = toolStatus.streamlinkPath;
  if (!streamlinkPath) {
    throw new Error("同梱Streamlinkが見つかりません。アプリを再インストールしてください。");
  }

  const ffmpegPath = toolStatus.ffmpegPath;
  const authSession = session.fromPartition("persist:nico-auth");
  const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
  const userSession = cookies.find((cookie) => cookie.name === "user_session")?.value || "";
  const runtime = createStreamlinkRuntime(app.getPath("temp"), userSession);
  if (displayName) currentBroadcasterName = String(displayName).slice(0, 80);
  if (broadcasterId) currentBroadcasterId = String(broadcasterId);
  const directory = path.join(dataRoot(), "videos", broadcasterFolderName(currentBroadcasterName, currentBroadcasterId));
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, liveId + "_" + stamp() + ".ts");
  const args = buildStreamlinkArgs({
    configPath: runtime.configPath,
    liveId,
    quality,
    outputPath,
    ffmpegPath,
    timeshift
  });

  let child;
  try {
    child = spawn(streamlinkPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: runtime.env
    });
  } catch (error) {
    await fs.promises.rm(runtime.runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    throw new Error("Streamlinkを起動できませんでした: " + error.message);
  }

  streamlinkProcess = child;
  streamlinkRuntimeDirectory = runtime.runtimeDirectory;
  streamlinkOutputPath = outputPath;
  streamlinkFinalOutputPath = ffmpegPath ? outputPath.replace(/\.ts$/i, ".mp4") : outputPath;
  streamlinkLiveId = liveId;
  streamlinkBroadcasterName = currentBroadcasterName;
  streamlinkBroadcasterId = currentBroadcasterId;
  streamlinkFfmpegPath = ffmpegPath || "";
  streamlinkStopRequested = false;
  if (child.stderr) child.stderr.on("data", () => {});

  streamlinkFinalizePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).then(finalizeStreamlinkRecording);

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch(async (error) => {
    try { child.kill(); } catch (_) {}
    if (streamlinkFinalizePromise) await streamlinkFinalizePromise.catch(() => {});
    throw new Error("Streamlinkを起動できませんでした: " + error.message);
  });

  const startedAt = new Date().toISOString();
  if (currentLiveId === liveId) {
    appendMarker("videoStart", {
      videoStartedAt: startedAt,
      videoOriginAt: options && options.timeshiftOriginAt || undefined,
      videoFile: ffmpegPath ? outputPath.replace(/\.ts$/i, ".mp4") : outputPath,
      streamlinkPath
    });
  }
  send("video:state", {
    recording: true,
    path: ffmpegPath ? outputPath.replace(/\.ts$/i, ".mp4") : outputPath,
    sourcePath: outputPath,
    startedAt,
    ffmpegAvailable: Boolean(ffmpegPath)
  });
  return {
    path: ffmpegPath ? outputPath.replace(/\.ts$/i, ".mp4") : outputPath,
    sourcePath: outputPath,
    startedAt,
    ffmpegAvailable: Boolean(ffmpegPath)
  };
}

ipcMain.handle("video:start", async (_event, value, quality, options = {}) => {
  if (!(options && options.timeshift)) {
    if (timeshiftCommentFetchActive) {
      throw new Error("過去配信のコメント取得中です。完了後に録画を開始してください。");
    }
    return startVideoInternal(value, quality, options && options.displayName, options && options.broadcasterId, options);
  }
  if (timeshiftCommentFetchActive) {
    throw new Error("別の過去配信コメントを取得中です。完了後に再試行してください。");
  }
  if (streamlinkProcess || streamlinkFinalizePromise) {
    throw new Error("別の映像録画が実行中、またはファイル確定中です。先に停止してください。");
  }

  // Lock before fetching the watch page so another capture/comment session cannot race this request.
  timeshiftCommentFetchActive = true;
  try {
    const liveId = safeLiveId(value);
    let page = null;
    let commentError = "";
    let cookieHeader = "";
    try {
      cookieHeader = await getNicoCookieHeader();
    } catch (error) {
      commentError = "ニコニコのログイン情報を確認できませんでした: " +
        (error && error.message ? error.message : String(error));
    }
    try {
      page = await fetchTimeshiftProgramPage(liveId, cookieHeader);
      if (!page.webSocketUrl) {
        commentError = "このタイムシフトでは過去コメント用の接続情報を取得できませんでした。映像録画のみ実行します。";
      }
    } catch (error) {
      const pageError = "過去番組のコメント情報を取得できませんでした: " +
        (error && error.message ? error.message : String(error));
      commentError = commentError ? commentError + " " + pageError : pageError;
    }

    if (!page || !page.webSocketUrl) {
      // Close any previous live-comment session and create this archive's own
      // log even when the archive does not expose a comment WebSocket endpoint.
      await prepareCommentSession(
        liveId,
        page && page.broadcasterName || "",
        page && page.broadcasterId || ""
      );
      const video = await startVideoInternal(
        liveId,
        quality,
        page && page.broadcasterName || "",
        page && page.broadcasterId || "",
        { ...options, timeshift: true, timeshiftOriginAt: page && page.beginAt || "" }
      );
      await closeCommentWriter();
      const finalCommentFile = commentFilePath;
      send("live:state", { state: "disconnected" });
      return {
        ...video,
        commentFile: finalCommentFile,
        commentCount: 0,
        commentsFetched: false,
        commentError
      };
    }

    let video = null;
    let commentCount = 0;
    let commentsTruncated = false;
    let finalCommentFile = "";
    await prepareCommentSession(liveId, page.broadcasterName, page.broadcasterId);
    video = await startVideoInternal(
      liveId,
      quality,
      page.broadcasterName,
      page.broadcasterId,
      { ...options, timeshift: true, timeshiftOriginAt: page.beginAt || "" }
    );

    try {
      const archive = await fetchTimeshiftArchive(page.webSocketUrl, cookieHeader, {
        onProgress: (progress) => send("timeshift:comments-progress", {
          liveId,
          segmentsFetched: progress.segmentsFetched,
          eventCount: progress.eventCount,
          phase: progress.phase
        })
      });
      const originAt = page.beginAt ||
        (archive.events[0] && archive.events[0].timestamp) || video.startedAt;
      appendMarker("timeshiftOrigin", {
        originAt,
        source: page.beginAt ? "program.beginTime" : "firstComment"
      });

      for (const event of archive.events) {
        if (!commentWriter) throw new Error("過去コメントの保存先が閉じられました。");
        const record = normalizeEvent(event.type, event);
        record.timestamp = event.timestamp;
        record.receivedAt = event.receivedAt || new Date().toISOString();
        record.isHistory = true;
        if (!commentWriter.write(JSON.stringify(record) + "\n")) {
          await new Promise((resolve, reject) => {
            commentWriter.once("drain", resolve);
            commentWriter.once("error", reject);
          });
        }
      }
      commentCount = archive.commentCount;
      commentsTruncated = archive.truncated;
      if (!commentCount) commentError = "過去コメントAPIから保存可能なコメントが見つかりませんでした。";
      if (commentsTruncated) {
        const note = "コメント取得上限に達したため、一部のみ保存しました。";
        commentError = commentError ? commentError + " " + note : note;
      }
    } catch (error) {
      const fetchError = "映像録画は継続しますが、過去コメントの取得に失敗しました: " +
        (error && error.message ? error.message : String(error));
      commentError = commentError ? commentError + " " + fetchError : fetchError;
    }

    await closeCommentWriter();
    finalCommentFile = commentFilePath;
    send("live:state", { state: "disconnected" });
    return {
      ...video,
      commentFile: finalCommentFile,
      commentCount,
      commentsFetched: commentCount > 0,
      commentsTruncated,
      commentError
    };
  } catch (error) {
    if (commentWriter) await closeCommentWriter();
    send("live:state", { state: "error" });
    throw error;
  } finally {
    timeshiftCommentFetchActive = false;
  }
});

ipcMain.handle("capture:start", async (_event, value, quality, options = {}) => {
  if (timeshiftCommentFetchActive) {
    throw new Error("過去配信のコメント取得中です。完了後に録画を開始してください。");
  }
  const liveId = safeLiveId(value);
  if (streamlinkProcess) throw new Error("映像録画はすでに実行中です。");

  const requestedName = String(options && options.displayName || "").trim().slice(0, 80);
  const requestedId = String(options && options.broadcasterId || "").trim();
  const reuseComments = currentLiveId === liveId && Boolean(provider && commentWriter);

  if (reuseComments) {
    if (requestedName) currentBroadcasterName = requestedName;
    if (requestedId) currentBroadcasterId = requestedId;
  } else {
    await prepareCommentSession(liveId, requestedName, requestedId);
  }

  // Both operations are launched in the same main-process turn. The JSONL
  // session marker exists before Streamlink can write its videoStart marker.
  const commentTask = reuseComments
    ? Promise.resolve({ liveId, commentFile: commentFilePath, reused: true })
    : connectPreparedCommentSession(liveId);
  const videoTask = startVideoInternal(liveId, quality, requestedName, requestedId);
  const [comments, video] = await Promise.allSettled([commentTask, videoTask]);

  if (video.status === "rejected") {
    const message = video.reason && video.reason.message ? video.reason.message : String(video.reason);
    // If this one-click operation opened a new comment session but video could
    // not start, do not leave a comment-only session running unexpectedly.
    if (!reuseComments && comments.status === "fulfilled") {
      if (provider) {
        try { provider.disconnect(); } catch (_) {}
        provider = null;
      }
      await closeCommentWriter();
      currentLiveId = "";
      send("live:state", { state: "disconnected" });
    }
    send("capture:state", {
      liveId,
      commentsConnected: reuseComments && comments.status === "fulfilled",
      recording: false,
      commentError: comments.status === "rejected"
        ? String(comments.reason && comments.reason.message || comments.reason) : "",
      videoError: message
    });
    throw new Error(message);
  }

  const commentError = comments.status === "rejected"
    ? String(comments.reason && comments.reason.message || comments.reason) : "";
  const result = {
    liveId,
    comment: comments.status === "fulfilled" ? comments.value : null,
    video: video.value,
    commentsConnected: comments.status === "fulfilled",
    commentError
  };
  send("capture:state", {
    liveId,
    commentsConnected: result.commentsConnected,
    recording: true,
    commentError
  });
  return result;
});

async function stopStreamlinkRecording() {
  const child = streamlinkProcess;
  const finalizePromise = streamlinkFinalizePromise;
  if (!child || !finalizePromise) return { path: null };

  streamlinkStopRequested = true;
  try { child.kill("SIGINT"); } catch (_) {}

  const forcedStop = setTimeout(() => {
    if (streamlinkProcess === child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch (_) {}
    }
  }, 8000);

  try {
    return await finalizePromise;
  } finally {
    clearTimeout(forcedStop);
  }
}

ipcMain.handle("video:stop", () => stopStreamlinkRecording());

function transcodeCompositionToMp4(inputPath, outputPath, quality) {
  const ffmpegPath = getVideoToolStatus().ffmpegPath;
  if (!ffmpegPath) {
    return Promise.reject(new Error("MP4変換に使えるFFmpegが見つかりません。WebM形式で保存します。"));
  }
  const args = buildMp4TranscodeArgs(inputPath, outputPath, quality);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      reject(new Error("FFmpegを起動できません: " + error.message));
      return;
    }
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2400); });
    child.once("error", (error) => reject(new Error("MP4変換を開始できません: " + error.message)));
    child.once("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) resolve(outputPath);
      else reject(new Error(stderr.trim() || ("FFmpegによるMP4変換に失敗しました（終了コード " + code + "）。")));
    });
  });
}

function makeWebmFallbackPath(mp4Path) {
  const directory = path.dirname(mp4Path);
  const stem = path.basename(mp4Path, path.extname(mp4Path));
  const candidate = path.join(directory, stem + "_WebM.webm");
  return fs.existsSync(candidate)
    ? path.join(directory, stem + "_WebM_" + stamp() + ".webm")
    : candidate;
}

ipcMain.handle("compose:start", async (_event, options = {}) => {
  if (composeWriter || composeFinalizePromise) throw new Error("動画生成または保存処理がすでに実行中です。");
  const format = normalizeCompositionFormat(options && options.format);
  const quality = normalizeCompositionQuality(options && options.quality);
  const extension = "." + format;
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: "コメント付き動画を書き出す",
    defaultPath: "NicoLiveMessage_" + stamp() + extension,
    filters: format === "mp4"
      ? [{ name: "MP4動画（H.264 / AAC）", extensions: ["mp4"] }]
      : [{ name: "WebM動画（VP9 / VP8）", extensions: ["webm"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };

  let finalPath = saveResult.filePath;
  if (path.extname(finalPath).toLowerCase() !== extension) {
    finalPath = path.join(path.dirname(finalPath), path.basename(finalPath, path.extname(finalPath)) + extension);
  }
  const workingPath = format === "mp4" ? finalPath + ".partial.webm" : finalPath;
  if (format === "mp4") await fs.promises.unlink(workingPath).catch(() => {});
  composeFilePath = workingPath;
  composeFinalFilePath = finalPath;
  composeOutputFormat = format;
  composeOutputQuality = quality;
  composeWriter = fs.createWriteStream(composeFilePath, { flags: "w" });
  await new Promise((resolve, reject) => {
    composeWriter.once("open", resolve);
    composeWriter.once("error", reject);
  });
  composeWriter.on("error", (error) => send("app:error", "合成動画の保存に失敗しました: " + error.message));
  return { path: composeFilePath, outputPath: finalPath, format, quality };
});

ipcMain.handle("compose:chunk", async (_event, arrayBuffer) => {
  if (!composeWriter || !arrayBuffer) throw new Error("合成動画ファイルが開かれていません。");
  await new Promise((resolve, reject) => {
    composeWriter.write(Buffer.from(arrayBuffer), (error) => error ? reject(error) : resolve());
  });
  return { written: true };
});

ipcMain.handle("compose:finish", async () => {
  if (composeFinalizePromise) return composeFinalizePromise;
  if (!composeWriter) return { path: null };
  const writer = composeWriter;
  const savedPath = composeFilePath;
  const finalPath = composeFinalFilePath || savedPath;
  const format = composeOutputFormat;
  const quality = composeOutputQuality;
  composeWriter = null;
  composeFilePath = "";

  composeFinalizePromise = (async () => {
    await new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.end(resolve);
    });
    if (format !== "mp4") {
      composeFinalFilePath = "";
      composeOutputFormat = "webm";
      composeOutputQuality = "standard";
      return { path: savedPath, format: "webm", converted: false };
    }

    send("compose:status", { state: "converting", message: "FFmpegでMP4（H.264 / AAC）へ変換しています。" });
    try {
      await transcodeCompositionToMp4(savedPath, finalPath, quality);
      await fs.promises.unlink(savedPath).catch(() => {});
      send("compose:status", { state: "complete", message: "MP4変換が完了しました。" });
      composeFinalFilePath = "";
      composeOutputFormat = "webm";
      composeOutputQuality = "standard";
      return { path: finalPath, format: "mp4", converted: true };
    } catch (error) {
      await fs.promises.unlink(finalPath).catch(() => {});
      let fallbackPath = savedPath;
      try {
        fallbackPath = makeWebmFallbackPath(finalPath);
        await fs.promises.rename(savedPath, fallbackPath);
      } catch (_) { fallbackPath = savedPath; }
      const warning = (error && error.message ? error.message : String(error)) + " 代わりにWebMを保存しました。";
      send("compose:status", { state: "fallback", message: warning, path: fallbackPath });
      composeFinalFilePath = "";
      composeOutputFormat = "webm";
      composeOutputQuality = "standard";
      return { path: fallbackPath, format: "webm", converted: false, warning };
    }
  })();

  try {
    return await composeFinalizePromise;
  } finally {
    composeFinalizePromise = null;
  }
});

ipcMain.handle("compose:cancel", async () => {
  if (composeFinalizePromise) throw new Error("動画の保存・変換を確定中です。完了するまでお待ちください。");
  const writer = composeWriter;
  const savedPath = composeFilePath;
  composeWriter = null;
  composeFilePath = "";
  composeFinalFilePath = "";
  composeOutputFormat = "webm";
  composeOutputQuality = "standard";
  if (writer) await new Promise((resolve) => writer.end(resolve));
  if (savedPath && fs.existsSync(savedPath)) await fs.promises.unlink(savedPath).catch(() => {});
  return { cancelled: true };
});

ipcMain.handle("data:open-folder", async () => {
  const result = await shell.openPath(dataRoot());
  return { error: result || "" };
});

const LIBRARY_VIDEO_EXTENSIONS = new Set([".mp4", ".ts", ".mkv", ".webm", ".mov"]);
const LIBRARY_COMMENT_EXTENSIONS = new Set([".jsonl", ".csv", ".ass"]);

function listCaptureLibrary() {
  const root = dataRoot();
  const items = [];
  for (const category of [
    { folder: "videos", type: "video", extensions: LIBRARY_VIDEO_EXTENSIONS },
    { folder: "comments", type: "comment", extensions: LIBRARY_COMMENT_EXTENSIONS }
  ]) {
    const categoryRoot = path.join(root, category.folder);
    const queue = [categoryRoot];
    while (queue.length) {
      const directory = queue.pop();
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) {}
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !category.extensions.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const stat = fs.statSync(fullPath);
          const relative = path.relative(root, fullPath);
          if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
          const broadcaster = path.basename(path.dirname(fullPath));
          const liveMatch = entry.name.match(/^(lv\d{5,})/i);
          items.push({
            path: fullPath,
            fileName: entry.name,
            extension: path.extname(entry.name).slice(1).toUpperCase(),
            type: category.type,
            broadcaster,
            liveId: liveMatch ? liveMatch[1].toLowerCase() : "",
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
          });
        } catch (_) {
          // Skip files that disappear while the library is being indexed.
        }
      }
    }
  }
  items.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return {
    root,
    total: items.length,
    videoCount: items.filter((item) => item.type === "video").length,
    commentCount: items.filter((item) => item.type === "comment").length,
    items: items.slice(0, 5000)
  };
}

function resolveLibraryItemPath(value) {
  const root = path.resolve(dataRoot());
  const target = path.resolve(String(value || ""));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ライブラリ内のファイルを指定してください。");
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
    if (!fs.statSync(realTarget).isFile()) throw new Error("ファイルではありません。");
  } catch (error) {
    throw new Error("ファイルが見つかりません: " + error.message);
  }
  const realRelative = path.relative(root, realTarget);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("保存フォルダー外のファイルは開けません。");
  }
  return realTarget;
}

ipcMain.handle("library:list", () => listCaptureLibrary());
ipcMain.handle("library:open-item", async (_event, value) => {
  const target = resolveLibraryItemPath(value);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: true };
});
ipcMain.handle("library:show-item", (_event, value) => {
  const target = resolveLibraryItemPath(value);
  shell.showItemInFolder(target);
  return { shown: true };
});
ipcMain.handle("library:delete-video", async (_event, value) => {
  const target = resolveLibraryItemPath(value);
  const videosRoot = path.resolve(dataRoot(), "videos");
  const relative = path.relative(videosRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("録画動画フォルダー内のファイルだけ削除できます。コメントログは削除できません。");
  }
  const extension = path.extname(target).toLowerCase();
  if (!LIBRARY_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("対応していない動画ファイル形式です。");
  }
  const activeRecordingPaths = [
    streamlinkOutputPath,
    streamlinkFinalOutputPath,
    streamlinkOutputPath && streamlinkOutputPath.replace(/\.ts$/i, ".mp4")
  ].filter(Boolean).map((filePath) => path.resolve(filePath));
  if ((streamlinkProcess || streamlinkFinalizePromise) &&
      activeRecordingPaths.includes(path.resolve(target))) {
    throw new Error("録画中またはMP4変換・ファイル確定中の動画は削除できません。録画停止後に再試行してください。");
  }

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "録画動画を削除",
    message: "この動画ファイルを完全に削除しますか？",
    detail: path.basename(target) + "\n\n削除した動画は元に戻せません。対応するコメントログは削除されません。",
    buttons: ["削除する", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (confirmation.response !== 0) return { cancelled: true };

  await fs.promises.unlink(target);
  return { deleted: true, fileName: path.basename(target) };
});

ipcMain.handle("comments:export-csv", async () => {
  let source = commentFilePath;
  if (!source || !fs.existsSync(source)) {
    const directory = path.join(dataRoot(), "comments");
    const candidates = [];
    const walk = (folder) => {
      if (!fs.existsSync(folder)) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(fullPath);
      }
    };
    walk(directory);
    candidates.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    if (!candidates.length) throw new Error("保存済みコメントファイルがありません。");
    source = candidates[candidates.length - 1];
  }
  if (commentWriter) {
    await new Promise((resolve, reject) => {
      commentWriter.write("", (error) => error ? reject(error) : resolve());
    });
  }
  const records = fs.readFileSync(source, "utf8").split(/\\r?\\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "コメントCSVを書き出す",
    defaultPath: source.replace(/\.jsonl$/i, ".csv"),
    filters: [{ name: "CSVファイル", extensions: ["csv"] }]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  fs.writeFileSync(result.filePath, recordsToCsv(records), "utf8");
  return { path: result.filePath };
});

ipcMain.handle("comments:export-ass", async () => {
  const directory = path.join(dataRoot(), "comments");
  if (!fs.existsSync(directory)) throw new Error("保存済みコメントフォルダーがありません。");
  const openResult = await dialog.showOpenDialog(mainWindow, {
    title: "ASSに変換するコメントログを選択",
    defaultPath: commentFilePath && fs.existsSync(commentFilePath) ? commentFilePath : directory,
    properties: ["openFile"],
    filters: [{ name: "コメントログ（JSONL）", extensions: ["jsonl"] }]
  });
  if (openResult.canceled || !openResult.filePaths || !openResult.filePaths[0]) return { cancelled: true };
  const source = openResult.filePaths[0];
  if (commentWriter && source === commentFilePath) {
    await new Promise((resolve, reject) => {
      commentWriter.write("", (error) => error ? reject(error) : resolve());
    });
  }
  const records = [];
  const lines = fs.readFileSync(source, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch (_) { /* skip malformed rows */ }
  }
  const generated = generateAssFromRecords(records);
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: "ASS字幕を書き出す",
    defaultPath: source.replace(/\.jsonl$/i, ".ass"),
    filters: [{ name: "Advanced SubStation Alpha", extensions: ["ass"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };
  fs.writeFileSync(saveResult.filePath, "\uFEFF" + generated.content, "utf8");
  return { path: saveResult.filePath, commentCount: generated.commentCount };
});

app.whenReady().then(() => {
  makeWindow();
  if (process.platform === "win32") {
    const runAutomaticStreamlinkUpdate = () => {
      if (getMonitorSettings().autoUpdateStreamlink === false) {
        sendStreamlinkUpdateState("disabled", {
          message: "Streamlinkの自動更新は設定で無効です。設定から再び有効にすると自動確認を再開します。"
        });
        return;
      }
      checkStreamlinkUpdateNow({ autoInstall: true, silent: true });
    };
    setTimeout(runAutomaticStreamlinkUpdate, 12000);
    const streamlinkUpdateTimer = setInterval(
      runAutomaticStreamlinkUpdate,
      6 * 60 * 60 * 1000
    );
    if (typeof streamlinkUpdateTimer.unref === "function") streamlinkUpdateTimer.unref();
  }
  if (configureAutoUpdater()) {
    // Check shortly after startup, then refresh the beta channel every six hours.
    setTimeout(() => checkForUpdatesNow().catch(() => {}), 8000);
    const updateTimer = setInterval(() => checkForUpdatesNow().catch(() => {}), 6 * 60 * 60 * 1000);
    if (typeof updateTimer.unref === "function") updateTimer.unref();
  } else {
    sendUpdateState("unsupported", {
      message: "WindowsのNSISインストーラー版ではないため、自動更新を利用できません。"
    });
  }
  const monitorConfig = getMonitorSettings();
  if (monitorConfig.autoStart && monitorConfig.targets.some((target) => target.enabled)) {
    setTimeout(() => {
      try { startMonitor(); } catch (error) {
        sendMonitorState("error", { message: error.message });
      }
    }, 5000);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) makeWindow();
  });
});

async function shutdownGracefully() {
  stopMonitor();
  if (livePreviewWindow && !livePreviewWindow.isDestroyed()) {
    livePreviewWindow.close();
    livePreviewWindow = null;
    livePreviewId = "";
  }
  // Stop the live stream first so the TS file can be finalized and remuxed to MP4.
  try {
    await stopStreamlinkRecording();
  } catch (error) {
    console.error("Streamlink shutdown failed:", error);
  }

  if (provider) {
    try { await provider.disconnect(); } catch (error) {
      console.error("Comment provider shutdown failed:", error);
    }
    provider = null;
  }

  try {
    await closeCommentWriter();
  } catch (error) {
    console.error("Comment log shutdown failed:", error);
  }

  // An interrupted WebM composition is incomplete; close and remove it instead of
  // leaving a partial file that looks like a completed export.
  if (composeFinalizePromise) await composeFinalizePromise.catch((error) => console.error("Composition finalization failed:", error));
  const writer = composeWriter;
  const partialComposePath = composeFilePath;
  composeWriter = null;
  composeFilePath = "";
  composeFinalFilePath = "";
  composeOutputFormat = "webm";
  composeOutputQuality = "standard";
  if (writer) {
    await new Promise((resolve) => {
      writer.once("error", resolve);
      writer.end(resolve);
    });
  }
  if (partialComposePath) {
    await fs.promises.unlink(partialComposePath).catch(() => {});
  }

  // The temporary config may contain the logged-in session token.
  if (streamlinkRuntimeDirectory) {
    await fs.promises.rm(streamlinkRuntimeDirectory, { recursive: true, force: true }).catch(() => {});
    streamlinkRuntimeDirectory = "";
  }
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;

  shutdownPromise = (async () => {
    await shutdownGracefully();
    shutdownComplete = true;
    app.quit();
  })().catch((error) => {
    console.error("Application shutdown failed:", error);
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});