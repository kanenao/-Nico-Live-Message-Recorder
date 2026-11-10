const { app, BrowserWindow, ipcMain, shell, dialog, session } = require("electron");
const { spawn } = require("node:child_process");
const {
  findStreamlinkExecutable,
  findFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs
} = require("./streamlink.cjs");
const { generateAssFromRecords } = require("./ass.cjs");
const fs = require("node:fs");
const path = require("node:path");

// This is a local desktop media-processing app; allow the selected local video to play for composition.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.setName("Nico Live Message Recorder");

let mainWindow = null;
let loginWindow = null;
let provider = null;
let currentLiveId = "";
let commentWriter = null;
let commentFilePath = "";
let streamlinkProcess = null;
let streamlinkFinalizePromise = null;
let streamlinkRuntimeDirectory = "";
let streamlinkOutputPath = "";
let streamlinkFfmpegPath = "";
let streamlinkStopRequested = false;
let composeWriter = null;
let composeFilePath = "";

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

function openCommentWriter(liveId) {
  const directory = path.join(dataRoot(), "comments");
  fs.mkdirSync(directory, { recursive: true });
  commentFilePath = path.join(directory, liveId + "_" + stamp() + ".jsonl");
  commentWriter = fs.createWriteStream(commentFilePath, { flags: "wx" });
  commentWriter.on("error", (error) => {
    send("app:error", "コメントファイルの保存に失敗しました: " + error.message);
  });
  appendMarker("sessionStart", { sessionStartedAt: new Date().toISOString() });
  send("comments:file", { path: commentFilePath });
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
    title: "Nico Live Message Recorder",
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

function getVideoToolStatus() {
  const settings = readAppSettings();
  const streamlinkPath = findStreamlinkExecutable({ customPath: settings.streamlinkPath });
  const ffmpegPath = findFfmpegExecutable({
    customPath: settings.ffmpegPath,
    streamlinkPath
  });
  return { streamlinkAvailable: Boolean(streamlinkPath), streamlinkPath, ffmpegAvailable: Boolean(ffmpegPath), ffmpegPath };
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

  const runtimeDirectory = streamlinkRuntimeDirectory;
  streamlinkProcess = null;
  streamlinkFinalizePromise = null;
  streamlinkRuntimeDirectory = "";
  streamlinkOutputPath = "";
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

ipcMain.handle("video:select-streamlink", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Streamlink実行ファイルを選択",
    properties: ["openFile"],
    filters: [{ name: "Streamlink実行ファイル", extensions: process.platform === "win32" ? ["exe"] : ["*"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true, ...getVideoToolStatus() };
  const selectedPath = result.filePaths[0];
  if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isFile()) {
    throw new Error("選択したファイルを確認できませんでした。");
  }
  writeAppSettings({ streamlinkPath: selectedPath });
  return { cancelled: false, ...getVideoToolStatus() };
});

ipcMain.handle("video:select-ffmpeg", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "FFmpeg実行ファイルを選択",
    properties: ["openFile"],
    filters: [{ name: "FFmpeg実行ファイル", extensions: process.platform === "win32" ? ["exe"] : ["*"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true, ...getVideoToolStatus() };
  const selectedPath = result.filePaths[0];
  if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isFile()) {
    throw new Error("選択したファイルを確認できませんでした。");
  }
  writeAppSettings({ ffmpegPath: selectedPath });
  return { cancelled: false, ...getVideoToolStatus() };
});

ipcMain.handle("video:open-streamlink-download", async () => {
  await shell.openExternal("https://github.com/streamlink/windows-builds/releases");
  return { opened: true };
});

ipcMain.handle("video:start", async (_event, value, quality) => {
  if (streamlinkProcess) throw new Error("映像録画はすでに実行中です。");
  const liveId = safeLiveId(value);
  const settings = readAppSettings();
  const streamlinkPath = findStreamlinkExecutable({ customPath: settings.streamlinkPath });
  if (!streamlinkPath) {
    throw new Error("Streamlinkが見つかりません。「Streamlinkを設定」からstreamlink.exeを選択するか、公式配布版をインストールしてください。");
  }

  const toolStatus = getVideoToolStatus();
  const ffmpegPath = toolStatus.ffmpegPath;
  const authSession = session.fromPartition("persist:nico-auth");
  const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
  const userSession = cookies.find((cookie) => cookie.name === "user_session")?.value || "";
  const runtime = createStreamlinkRuntime(app.getPath("temp"), userSession);
  const directory = path.join(dataRoot(), "videos");
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, liveId + "_" + stamp() + ".ts");
  const args = buildStreamlinkArgs({
    configPath: runtime.configPath,
    liveId,
    quality,
    outputPath,
    ffmpegPath
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
});

ipcMain.handle("video:stop", async () => {
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
});

ipcMain.handle("compose:start", async () => {
  if (composeWriter) throw new Error("動画生成はすでに実行中です。");
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: "コメント付き動画を書き出す",
    defaultPath: "NicoLiveMessage_" + stamp() + ".webm",
    filters: [{ name: "WebM動画", extensions: ["webm"] }]
  });
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };

  composeFilePath = saveResult.filePath;
  composeWriter = fs.createWriteStream(composeFilePath, { flags: "w" });
  await new Promise((resolve, reject) => {
    composeWriter.once("open", resolve);
    composeWriter.once("error", reject);
  });
  composeWriter.on("error", (error) => {
    send("app:error", "合成動画の保存に失敗しました: " + error.message);
  });
  return { path: composeFilePath };
});

ipcMain.handle("compose:chunk", async (_event, arrayBuffer) => {
  if (!composeWriter || !arrayBuffer) throw new Error("合成動画ファイルが開かれていません。");
  await new Promise((resolve, reject) => {
    composeWriter.write(Buffer.from(arrayBuffer), (error) => error ? reject(error) : resolve());
  });
  return { written: true };
});

ipcMain.handle("compose:finish", async () => {
  if (!composeWriter) return { path: null };
  const writer = composeWriter;
  const savedPath = composeFilePath;
  composeWriter = null;
  composeFilePath = "";
  await new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
  return { path: savedPath };
});

ipcMain.handle("compose:cancel", async () => {
  const writer = composeWriter;
  const savedPath = composeFilePath;
  composeWriter = null;
  composeFilePath = "";
  if (writer) {
    await new Promise((resolve) => {
      writer.end(resolve);
    });
  }
  if (savedPath && fs.existsSync(savedPath)) {
    await fs.promises.unlink(savedPath).catch(() => {});
  }
  return { cancelled: true };
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) makeWindow();
  });
});

app.on("before-quit", () => {
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
  }
  if (commentWriter) commentWriter.end();
  if (streamlinkProcess) {
    try { streamlinkProcess.kill(); } catch (_) {}
  }
  // Remove the short-lived config file that contains the session cookie on app exit.
  if (streamlinkRuntimeDirectory) {
    try { fs.rmSync(streamlinkRuntimeDirectory, { recursive: true, force: true }); } catch (_) {}
    streamlinkRuntimeDirectory = "";
  }
  if (composeWriter) composeWriter.end();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});