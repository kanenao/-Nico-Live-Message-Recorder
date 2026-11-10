const { app, BrowserWindow, ipcMain, shell, dialog, session, desktopCapturer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

let mainWindow = null;
let loginWindow = null;
let provider = null;
let currentLiveId = "";
let commentWriter = null;
let commentFilePath = "";
let videoWriter = null;
let videoFilePath = "";
let pendingCaptureRequest = null;

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
    "point", "message", "name", "link"
  ];
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) {
      result[key] = typeof data[key] === "string" ? data[key] : String(data[key]);
    }
  }
  return result;
}

function openCommentWriter(liveId) {
  const directory = path.join(dataRoot(), "comments");
  fs.mkdirSync(directory, { recursive: true });
  commentFilePath = path.join(directory, liveId + "_" + stamp() + ".jsonl");
  commentWriter = fs.createWriteStream(commentFilePath, { flags: "wx" });
  commentWriter.on("error", (error) => {
    send("app:error", "コメントファイルの保存に失敗しました: " + error.message);
  });
  send("comments:file", { path: commentFilePath });
}

function appendEvent(type, item) {
  const record = normalizeEvent(type, item);
  if (commentWriter) commentWriter.write(JSON.stringify(record) + "\n");
  send("live:event", record);
}

function closeCommentWriter() {
  return new Promise((resolve) => {
    if (!commentWriter) {
      resolve();
      return;
    }
    const writer = commentWriter;
    commentWriter = null;
    writer.end(() => resolve());
  });
}

function makeWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0b1020",
    title: "NicoLive Recorder",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("app:version", () => app.getVersion());

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

ipcMain.handle("live:connect", async (_event, value) => {
  const liveId = safeLiveId(value);

  if (provider) {
    try { provider.disconnect(); } catch (_) {}
    provider = null;
  }
  await closeCommentWriter();

  currentLiveId = liveId;
  openCommentWriter(liveId);

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
    provider.on("metadata", (metadata) => send("live:metadata", metadata));
    provider.on("stateChange", (state) => send("live:state", { state }));
    provider.on("error", (error) => {
      send("app:error", error && error.message ? error.message : String(error));
    });

    const metadata = await provider.connect();
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
});

ipcMain.handle("live:disconnect", async () => {
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
    provider = null;
  }
  await closeCommentWriter();
  currentLiveId = "";
  send("live:state", { state: "disconnected" });
  return { disconnected: true };
});


ipcMain.handle("video:list-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 240, height: 150 },
    fetchWindowIcons: true
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : ""
  }));
});

ipcMain.handle("video:select-source", async (_event, sourceId) => {
  if (!pendingCaptureRequest) {
    throw new Error("録画元の選択要求が終了しています。もう一度録画を開始してください。");
  }
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 0, height: 0 }
  });
  const selected = sources.find((source) => source.id === sourceId);
  if (!selected) throw new Error("選択したウィンドウが見つかりません。");

  const pending = pendingCaptureRequest;
  pendingCaptureRequest = null;
  const streams = { video: selected };
  if (pending.audioRequested) streams.audio = "loopback";
  pending.callback(streams);
  return { selected: true, name: selected.name };
});

ipcMain.handle("video:cancel-source", async () => {
  if (pendingCaptureRequest) {
    const pending = pendingCaptureRequest;
    pendingCaptureRequest = null;
    pending.callback(null);
  }
  return { cancelled: true };
});

ipcMain.handle("video:start", async (_event, value) => {
  if (videoWriter) throw new Error("映像録画はすでに実行中です。");
  const liveId = safeLiveId(value);
  const directory = path.join(dataRoot(), "videos");
  fs.mkdirSync(directory, { recursive: true });
  videoFilePath = path.join(directory, liveId + "_" + stamp() + ".webm");
  videoWriter = fs.createWriteStream(videoFilePath, { flags: "wx" });
  videoWriter.on("error", (error) => {
    send("app:error", "映像ファイルの保存に失敗しました: " + error.message);
  });
  send("video:state", { recording: true, path: videoFilePath });
  return { path: videoFilePath };
});

ipcMain.handle("video:chunk", async (_event, arrayBuffer) => {
  if (!videoWriter || !arrayBuffer) {
    throw new Error("録画ファイルが開かれていません。");
  }
  await new Promise((resolve, reject) => {
    videoWriter.write(Buffer.from(arrayBuffer), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return { written: true };
});

ipcMain.handle("video:stop", async () => {
  if (!videoWriter) return { path: null };
  const writer = videoWriter;
  const savedPath = videoFilePath;
  videoWriter = null;
  videoFilePath = "";
  await new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
  send("video:state", { recording: false, path: savedPath });
  return { path: savedPath };
});

ipcMain.handle("data:open-folder", async () => {
  const result = await shell.openPath(dataRoot());
  return { error: result || "" };
});

ipcMain.handle("comments:export-csv", async () => {
  let source = commentFilePath;
  if (!source || !fs.existsSync(source)) {
    const directory = path.join(dataRoot(), "comments");
    const candidates = fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort()
      : [];
    if (candidates.length === 0) throw new Error("保存済みコメントファイルがありません。");
    source = path.join(directory, candidates[candidates.length - 1]);
  }

  if (commentWriter) {
    await new Promise((resolve, reject) => {
      commentWriter.write("", (error) => error ? reject(error) : resolve());
    });
  }

  const rows = fs.readFileSync(source, "utf8").split(/\r?\n/).filter(Boolean);
  const quote = (value) => '"' + String(value === undefined || value === null ? "" : value).replace(/"/g, '""') + '"';
  const output = ["種別,日時,ユーザー名,ユーザーID,内容"];
  for (const line of rows) {
    try {
      const row = JSON.parse(line);
      output.push([
        row.type, row.timestamp, row.userName || row.name || "",
        row.userId || "", row.content || row.message || row.itemName || row.id || ""
      ].map(quote).join(","));
    } catch (_) {}
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "コメントCSVを書き出す",
    defaultPath: source.replace(/\.jsonl$/i, ".csv"),
    filters: [{ name: "CSVファイル", extensions: ["csv"] }]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  fs.writeFileSync(result.filePath, "\uFEFF" + output.join("\r\n"), "utf8");
  return { path: result.filePath };
});

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = request.frame && request.frame.url ? request.frame.url : "";
    if (!mainWindow || !frameUrl.startsWith("file://") || !request.videoRequested) {
      callback(null);
      return;
    }
    if (pendingCaptureRequest) pendingCaptureRequest.callback(null);
    pendingCaptureRequest = {
      callback,
      audioRequested: Boolean(request.audioRequested)
    };
    send("video:choose-source", {});
  }, { useSystemPicker: false });

  makeWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) makeWindow();
  });
});

app.on("before-quit", () => {
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
  }
  if (commentWriter) commentWriter.end();
  if (videoWriter) videoWriter.end();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});