const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, Tray, nativeImage, powerSaveBlocker, Notification } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const {
  findStreamlinkExecutable,
  findFfmpegExecutable,
  findBundledStreamlinkExecutable,
  findBundledFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs
} = require("./streamlink.cjs");
const { generateAssFromRecords } = require("./ass.cjs");
const { generateBroadcastArticle, parseCommentLog } = require("./articles.cjs");
const articleExport = require("./article-export.cjs");
const { transcribeVideoAudio, transcribeAudioFile } = require("./audio-transcription.cjs");
const { getOllamaStatus, generateArticleWithOllama } = require("./ollama.cjs");
const { writeCommentLine, finishCommentWriter } = require("./comment-writer.cjs");
const { hasNonEmptyFile } = require("./recording-file.cjs");
const { downloadOllamaInstaller, pullOllamaModel } = require("./ollama-setup.cjs");
const {
  normalizeCompositionFormat,
  normalizeCompositionQuality,
  normalizeCompositionOutputPath,
  createMp4IntermediatePath,
  calculateTranscodeProgressPercent,
  buildMp4TranscodeArgs
} = require("./composition-export.cjs");
const { fetchTimeshiftProgramPage, fetchTimeshiftArchive } = require("./timeshift-comments.cjs");
const { autoUpdater } = require("electron-updater");
const { normalizeNicoUserId, normalizeMonitorDate, fetchUserBroadcastStatus, fetchFollowingOnAirPrograms, fetchNicoUserName, mapWithConcurrency } = require("./monitor.cjs");
const {
  compareReleaseVersions,
  fetchLatestWindowsRelease,
  getActiveManagedRuntime,
  installWindowsPortableRelease
} = require("./streamlink-update.cjs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// This is a local desktop media-processing app; allow the selected local video to play for composition.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (process.platform === "win32") app.setAppUserModelId("jp.kanenao.nicolive.recorder");

app.setName("Nico Live Message Recorder");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let monitorPowerSaveBlockerId = null;
let loginWindow = null;
let livePreviewWindow = null;
let liveArticleCaptureWindow = null;
let liveArticleCaptureWindowLiveId = "";
let livePreviewId = "";
let provider = null;
let timeshiftCommentFetchActive = false;
let currentLiveId = "";
let commentWriter = null;
let commentFilePath = "";
let commentWriterError = null;
let articleUpdateTimer = null;
let articleUpdateInProgress = false;
let articleRefreshPending = false;
let liveArticleCaptureTimer = null;
let liveArticleFrames = [];
const LIVE_ARTICLE_FRAME_INTERVAL_MS = 15 * 1000;
const LIVE_ARTICLE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const LIVE_ARTICLE_MAX_FRAMES = 16;
let liveArticleSessionActive = false;
let liveArticleCaptureInProgress = false;
let liveArticleAudioProcess = null;
let liveArticleAudioFfmpegProcess = null;
let liveArticleAudioClosePromise = null;
let liveArticleAudioFfmpegClosePromise = null;
let liveArticleAudioRuntimeDirectory = "";
let liveArticleAudioPath = "";
let liveArticleAudioSegmentDirectory = "";
let liveArticleAudioSegmentTimer = null;
let liveArticleAudioProcessing = false;
let liveArticleAudioProcessedFiles = new Set();
let liveArticleAudioTranscriptSegments = [];
let liveArticleAudioTranscript = null;
let liveArticleAudioLastArticleUpdateAt = 0;
let liveArticleCommentRefreshCounter = 0;
let liveArticleCommentLastRefreshAt = 0;
const LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS = 25;
const LIVE_ARTICLE_AUDIO_POLL_INTERVAL_MS = 4000;
let currentBroadcasterName = "";
let currentBroadcasterId = "";
let currentProgramInfo = {};
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
let streamlinkStderr = "";
let streamlinkStopRequested = false;
let composeWriter = null;
let composeFilePath = "";
let composeFinalFilePath = "";
let composeOutputFormat = "webm";
let composeOutputQuality = "standard";
let composeOutputDurationMs = 0;
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
const monitorObservedLiveIds = new Map();
const monitorPendingDetections = [];
const activeDesktopNotifications = new Set();
const monitorFailureNotifications = new Set();

function dataRoot() {
  const root = path.join(app.getPath("videos"), "NicoLiveRecorder");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeLiveId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("放送IDまたは視聴URLを入力してください。");
  const bare = raw.match(/^(?:lv)?(\d{5,})$/i);
  if (bare) return "lv" + bare[1];
  let parsed;
  try { parsed = new URL(raw); } catch (_) {}
  if (parsed) {
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = new Set(["live.nicovideo.jp", "www.nicovideo.jp", "nicovideo.jp", "nico.ms"]);
    const match = parsed.pathname.match(/(?:^|\/)watch\/(?:lv)?(\d{5,})(?:\/|$)/i)
      || parsed.pathname.match(/(?:^|\/)(?:lv)(\d{5,})(?:\/|$)/i);
    if (["http:", "https:"].includes(parsed.protocol) && allowedHosts.has(host) && match) {
      return "lv" + match[1];
    }
  }
  throw new Error("ニコニコの放送ID（lv123456789）または視聴URL全体を入力してください。");
}

function stamp() {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:event", { channel, payload });
  }
}

function showDesktopNotification(title, body) {
  if (process.platform !== "win32" || !Notification.isSupported()) return false;
  try {
    const notification = new Notification({
      title: String(title || "Nico Live Message Recorder").slice(0, 120),
      body: String(body || "").slice(0, 900)
    });
    activeDesktopNotifications.add(notification);
    notification.on("click", () => showMainWindow());
    notification.once("close", () => activeDesktopNotifications.delete(notification));
    notification.once("failed", (_event, error) => {
      activeDesktopNotifications.delete(notification);
      console.warn("Windows notification could not be displayed:", error);
    });
    notification.show();
    return true;
  } catch (error) {
    console.warn("Windows notification could not be created:", error);
    return false;
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

async function enhanceBroadcastArticleWithOllama(article, records, articleContext, options = {}) {
  if (!article || article.status !== "generated") return article;
  const aiSettings = getMonitorSettings();
  if (!options.force && aiSettings.aiArticleEnabled === false) return article;
  try {
    const status = await getOllamaStatus({ baseUrl: aiSettings.baseUrl });
    if (!status.connected) throw new Error(status.message || "Ollamaに接続できません。");
    const configuredModel = String(aiSettings.aiArticleModel || "qwen2.5:3b");
    const configuredInstalled = status.models.find(item => item.name === configuredModel || item.name.startsWith(configuredModel + ":"));
    const visionPattern = /qwen[23].*vl|llava|vision|gemma3|moondream|minicpm-v/i;
    const visionModels = status.models.filter(item => visionPattern.test(item.name));
    const visionModel = options.images && options.images.length
      ? visionModels.find(item => item.name === "qwen2.5vl:3b")
        || visionModels.find(item => item.name.startsWith("qwen2.5vl:3b-"))
        || visionModels.find(item => item.name.toLowerCase().startsWith("qwen2.5vl"))
        || visionModels[0]
        || (configuredInstalled && visionPattern.test(configuredInstalled.name) ? configuredInstalled : null)
      : null;
    if (options.images && options.images.length && !visionModel) throw new Error("動画の映像分析には画像対応モデルが必要です。Ollamaで「ollama pull qwen2.5vl:3b」を実行してください。");
    const model = options.images && options.images.length ? visionModel.name : (configuredInstalled ? configuredInstalled.name : configuredModel);
    if (!status.models.some(item => item.name === model || item.name.startsWith(model + ":"))) throw new Error("指定モデルが未インストールです: " + model);
    const result = await generateArticleWithOllama({ baseUrl: aiSettings.baseUrl, model, records, context: articleContext, images: options.images || [], audioTranscript: options.audioTranscript || "" });
    article.title = result.title;
    article.summary = result.summary;
    article.paragraphs = result.paragraphs;
    article.aiHighlights = result.highlights || [];
    article.aiTimeline = result.timeline || [];
    article.aiAudienceReaction = result.audienceReaction || "";
    article.aiCommentSampleCount = Number(result.commentSampleCount) || 0;
    article.aiCommentTotalCount = Number(result.commentTotalCount) || 0;
    if (result.summary) article.summary = result.summary;
    if (result.topics.length) article.topics = result.topics.map(term => ({ term, count: 0 }));
    article.aiProvider = result.provider;
    article.aiModel = result.model;
  } catch (error) {
    article.aiFallbackReason = error.message || String(error);
    send("articles:ai-fallback", { liveId: article.liveId, reason: article.aiFallbackReason });
  }
  return article;
}

async function createAndSaveBroadcastArticle(commentPath, context = {}, options = {}) {
  if (!commentPath || !fs.existsSync(commentPath)) {
    return { status: "skipped", reason: "コメントログが見つかりません。" };
  }
  const recordsText = fs.readFileSync(commentPath, "utf8");
  const articleContext = {
    ...currentProgramInfo,
    broadcasterName: currentBroadcasterName,
    broadcasterId: currentBroadcasterId,
    liveId: currentLiveId,
    ...context,
    generatedAt: new Date().toISOString()
  };
  const records = recordsText.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
  const article = generateBroadcastArticle(records, articleContext);
  await enhanceBroadcastArticleWithOllama(article, records, articleContext, options);
  if (options.images && options.images.length) {
    article.videoFrameCount = options.images.length;
    article.videoAnalysis = article.aiProvider ? "生放送画面から取得した代表フレームを分析済み" : "生放送画面の代表フレームを取得（画像AI分析は未完了）";
  }
  if (options.audioTranscript) {
    article.audioTranscript = String(options.audioTranscript).slice(0, 30000);
    article.audioTranscriptSegmentCount = Number(options.audioTranscriptSegmentCount) || 0;
    article.audioAnalysis = "Whisperローカル音声認識で日本語文字起こし済み";
  }
  if ((options.images && options.images.length) || options.audioTranscript) {
    article.note = "自動生成記事です。映像は代表フレーム、音声はローカル音声認識の結果、コメントは保存ログを根拠に整理しています。認識誤りや見落としがあり得るため、重要な内容は元配信で確認してください。";
  }

  if (article.status !== "generated") {
    send("articles:skipped", { liveId: article.liveId || context.liveId || "", reason: article.reason });
    return article;
  }

  const directory = path.join(dataRoot(), "articles",
    broadcasterFolderName(article.broadcasterName, article.broadcasterId));
  fs.mkdirSync(directory, { recursive: true });
  const baseName = path.basename(commentPath, path.extname(commentPath));
  const articlePath = path.join(directory, baseName + ".json");
  article.articlePath = articlePath;
  article.commentFile = commentPath;
  let previousArticle = null;
  try { previousArticle = JSON.parse(fs.readFileSync(articlePath, "utf8")); } catch (_) {}
  if (context.videoFile) article.videoFile = context.videoFile;
  else if (previousArticle && previousArticle.videoFile) article.videoFile = previousArticle.videoFile;
  fs.writeFileSync(articlePath, JSON.stringify(article, null, 2), "utf8");
  send("articles:generated", { article });
  return article;
}

async function extractArticleVideoFrames(videoPath) {
  const resolvedPath = path.resolve(String(videoPath || ""));
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) throw new Error("選択した動画ファイルが見つかりません。");
  if (![".mp4", ".mkv", ".webm", ".mov", ".m4v", ".ts", ".avi"].includes(path.extname(resolvedPath).toLowerCase())) throw new Error("対応していない動画形式です。MP4 / MKV / WebM / MOV / TS / AVIを選択してください。");
  if (fs.statSync(resolvedPath).size > 4 * 1024 * 1024 * 1024) throw new Error("記事生成に使う動画は4GB以下にしてください。");
  const ffmpegPath = getVideoToolStatus().ffmpegPath;
  if (!ffmpegPath) throw new Error("映像分析にはFFmpegが必要です。アプリ同梱FFmpegまたは設定済みFFmpegを確認してください。");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nico-article-frames-"));
  const outputPattern = path.join(directory, "frame-%02d.jpg");
  try {
    let durationSeconds = 0;
    await new Promise(resolve => {
      const probe = spawn(ffmpegPath, ["-hide_banner", "-i", resolvedPath], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let probeText = "";
      const timeout = setTimeout(() => { probe.kill(); resolve(); }, 30000);
      probe.stderr.on("data", chunk => { probeText = (probeText + chunk.toString()).slice(-12000); });
      probe.once("error", () => { clearTimeout(timeout); resolve(); });
      probe.once("close", () => {
        clearTimeout(timeout);
        const match = probeText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (match) durationSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        resolve();
      });
    });
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("動画の長さを取得できませんでした。動画ファイルが正常か確認してください。");
    const targetFrames = Math.min(12, Math.max(1, Math.floor(durationSeconds)));
    const frameRate = (targetFrames / durationSeconds).toFixed(8);
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", resolvedPath, "-vf", "fps=" + frameRate + ",scale=640:-2", "-frames:v", String(targetFrames), "-q:v", "6", outputPattern], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("動画フレームの抽出がタイムアウトしました。短い動画で再試行してください。")); }, 180000);
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error("動画から映像フレームを抽出できませんでした。" + (stderr ? " " + stderr.trim().slice(-1200) : ""))); });
    });
    const names = fs.readdirSync(directory).filter(name => /^frame-\d+\.jpg$/i.test(name)).sort();
    if (!names.length) throw new Error("動画から分析できる映像フレームが見つかりませんでした。");
    return { directory, frames: names.map((name, index) => {
      const seconds = durationSeconds * (index + 0.5) / names.length;
      const whole = Math.floor(seconds);
      const timestamp = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60].map(value => String(value).padStart(2, "0")).join(":");
      return { image: fs.readFileSync(path.join(directory, name)).toString("base64"), capturedAt: timestamp };
    }) };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

async function generateStandaloneBroadcastArticle(input = {}) {
  const commentsText = String(input.commentsText || "");
  if (commentsText.length > 8 * 1024 * 1024) throw new Error("コメントログは8MB以下のJSONLファイルを指定してください。");
  const records = parseCommentLog(commentsText);
  if (records.length > 20000) throw new Error("コメントログが多すぎます。20,000行以下に分割してください。");
  const videoPath = String(input.videoPath || "").trim();
  const videoTitle = videoPath ? path.basename(videoPath, path.extname(videoPath)).slice(0, 300) : "";
  const context = {
    broadcasterName: String(input.broadcasterName || "").trim().slice(0, 80),
    broadcasterId: String(input.broadcasterId || "").trim().slice(0, 40),
    liveId: String(input.liveId || "").trim().slice(0, 32),
    programTitle: String(input.programTitle || videoTitle).trim().slice(0, 300),
    description: String(input.description || "").trim().slice(0, 3000),
    generatedAt: new Date().toISOString()
  };
  if (!records.length && !context.programTitle && !context.description && !videoPath) {
    throw new Error("番組タイトル・番組説明・コメントログのいずれかを入力してください。");
  }
  const article = generateBroadcastArticle(records, context);
  if (article.status !== "generated") return article;
  if (!context.broadcasterName && article.broadcasterName === "登録配信者") article.broadcasterName = "未登録配信者";
  let extracted = null;
  let audioTranscript = null;
  let audioTranscriptionError = "";
  try {
    if (videoPath) {
      extracted = await extractArticleVideoFrames(videoPath);
      const audioSettings = readAppSettings();
      if (audioSettings.articleWhisperCliPath && audioSettings.articleWhisperModelPath) {
        try {
          audioTranscript = await transcribeVideoAudio({
            videoPath,
            ffmpegPath: getVideoToolStatus().ffmpegPath,
            whisperCliPath: audioSettings.articleWhisperCliPath,
            modelPath: audioSettings.articleWhisperModelPath
          });
        } catch (error) { audioTranscriptionError = error.message || String(error); }
      }
    }
    await enhanceBroadcastArticleWithOllama(article, records, context, {
      force: true,
      images: extracted ? extracted.frames : [],
      audioTranscript: audioTranscript ? audioTranscript.text : "",
      audioTranscriptSegmentCount: audioTranscript ? audioTranscript.segmentCount : 0
    });
    if (videoPath) {
      article.videoFile = path.resolve(videoPath);
      article.videoFrameCount = extracted ? extracted.frames.length : 0;
      article.videoAnalysis = article.aiProvider ? "Ollama画像対応モデルで代表フレームを分析済み" : "代表フレーム抽出済み（Ollama画像分析は未完了）";
      if (audioTranscriptionError) article.audioTranscriptionError = audioTranscriptionError;
      if (!audioTranscript && !audioTranscriptionError) article.audioTranscriptionStatus = "未設定（Whisper実行ファイルと日本語モデルを選択すると音声も分析できます）";
    }
  } finally { if (extracted) fs.rmSync(extracted.directory, { recursive: true, force: true }); }
  article.articleSource = "manual";
  article.commentFileName = String(input.fileName || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 160);
  const directory = path.join(dataRoot(), "articles", "_manual");
  fs.mkdirSync(directory, { recursive: true });
  article.articlePath = path.join(directory, "manual_" + new Date().toISOString().replace(/[.:]/g, "-") + "_" + randomUUID().slice(0, 8) + ".json");
  fs.writeFileSync(article.articlePath, JSON.stringify(article, null, 2), "utf8");
  send("articles:generated", { article });
  return article;
}

function listBroadcastArticles() {
  const root = path.join(dataRoot(), "articles");
  const queue = [root];
  const items = [];
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
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
      try {
        const article = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        if (article && article.status === "generated" && article.schemaVersion === 1) {
          // articlePath is runtime metadata used by the delete action; older JSON files do not store it.
          article.articlePath = fullPath;
          items.push(article);
        }
      } catch (_) {
        // Ignore incomplete or older article files.
      }
    }
  }
  items.sort((a, b) => Date.parse(b.startedAt || b.generatedAt) - Date.parse(a.startedAt || a.generatedAt));
  return {
    total: items.length,
    broadcasterCount: new Set(items.map((item) => item.broadcasterId || item.broadcasterName).filter(Boolean)).size,
    commentCount: items.reduce((sum, item) => sum + (Number(item.commentCount) || 0), 0),
    items: items.slice(0, 2000)
  };
}

function generateArticleFromCommentFile(value) {
  const target = resolveLibraryItemPath(value);
  const commentsRoot = path.resolve(dataRoot(), "comments");
  const relative = path.relative(commentsRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      path.extname(target).toLowerCase() !== ".jsonl") {
    throw new Error("記事生成にはコメントフォルダー内のJSONLファイルを指定してください。");
  }
  return createAndSaveBroadcastArticle(target, {});
}

function openCommentWriter(liveId, displayName = "", broadcasterId = "") {
  currentBroadcasterName = String(displayName || "").trim();
  currentBroadcasterId = String(broadcasterId || "");
  const directory = path.join(dataRoot(), "comments",
    broadcasterFolderName(currentBroadcasterName, currentBroadcasterId));
  fs.mkdirSync(directory, { recursive: true });
  commentFilePath = path.join(directory, liveId + "_" + stamp() + ".jsonl");
  commentWriterError = null;
  commentWriter = fs.createWriteStream(commentFilePath, { flags: "wx" });
  commentWriter.on("error", (error) => {
    commentWriterError = error;
    send("app:error", "コメントファイルの保存に失敗しました: " + error.message);
  });
  appendMarker("sessionStart", {
    sessionStartedAt: new Date().toISOString(),
    broadcasterName: currentBroadcasterName,
    broadcasterId: currentBroadcasterId,
    ...currentProgramInfo
  });
  send("comments:file", { path: commentFilePath });
  if (articleUpdateTimer) clearInterval(articleUpdateTimer);
  articleUpdateTimer = setInterval(() => {
    void refreshLiveBroadcastArticle();
  }, 60 * 1000);
  if (typeof articleUpdateTimer.unref === "function") articleUpdateTimer.unref();
  if (currentProgramInfo.programTitle || currentProgramInfo.description) {
    void refreshLiveBroadcastArticle();
  }
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
      streamlinkBroadcasterId = currentBroadcasterId;
    }
  }

  const program = metadata.program || metadata.broadcast || metadata.live || {};
  const readField = (keys) => {
    for (const key of keys) {
      const value = metadata[key] !== undefined ? metadata[key] : program[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
  };
  const nextInfo = {
    ...currentProgramInfo,
    programTitle: readField(["programTitle", "title", "liveTitle"]) || currentProgramInfo.programTitle || "",
    description: readField(["programDescription", "description", "summary"]) || currentProgramInfo.description || "",
    startedAt: readField(["startedAt", "beginTime", "startTime"]) || currentProgramInfo.startedAt || "",
    endedAt: readField(["endedAt", "endTime"]) || currentProgramInfo.endedAt || ""
  };
  if (Object.keys(nextInfo).some((key) => nextInfo[key] && nextInfo[key] !== currentProgramInfo[key])) {
    currentProgramInfo = nextInfo;
    if (commentWriter) {
      appendMarker("programMetadata", {
        ...currentProgramInfo,
        broadcasterName: currentBroadcasterName,
        broadcasterId: currentBroadcasterId
      });
      if (currentProgramInfo.programTitle || currentProgramInfo.description) {
        void refreshLiveBroadcastArticle();
      }
    }
  }
}

function appendEvent(type, item) {
  const record = normalizeEvent(type, item);
  if (commentWriter) {
    void writeCommentLine(commentWriter, JSON.stringify(record)).catch((error) => {
      commentWriterError = error;
      send("app:error", `コメント保存に失敗しました: ${error.message}`);
    });
  }
  send("live:event", record);
  if (liveArticleSessionActive && type === "comment") {
    liveArticleCommentRefreshCounter += 1;
    if (liveArticleCommentRefreshCounter >= 30 && Date.now() - liveArticleCommentLastRefreshAt >= 60000) {
      liveArticleCommentRefreshCounter = 0;
      liveArticleCommentLastRefreshAt = Date.now();
      void refreshLiveBroadcastArticle();
    }
  }
}

function appendMarker(type, fields = {}) {
  if (!commentWriter) return;
  const timestamp = new Date().toISOString();
  const marker = { type, liveId: currentLiveId, timestamp, receivedAt: timestamp, ...fields };
  void writeCommentLine(commentWriter, JSON.stringify(marker)).catch((error) => {
    commentWriterError = error;
    send("app:error", `コメント保存に失敗しました: ${error.message}`);
  });
}

async function refreshLiveBroadcastArticle(options = {}) {
  if (!commentWriter || !commentFilePath) return null;
  if (articleUpdateInProgress) {
    // Keep one refresh queued while Ollama is busy; metadata or comment bursts
    // must not silently discard the next useful update.
    articleRefreshPending = true;
    return null;
  }
  const writer = commentWriter;
  const filePath = commentFilePath;
  const liveId = currentLiveId;
  const context = {
    ...currentProgramInfo,
    liveId,
    broadcasterName: currentBroadcasterName,
    broadcasterId: currentBroadcasterId,
    liveUpdate: true,
    liveStatus: options.finalize ? "ended" : "live"
  };
  articleUpdateInProgress = true;
  try {
    await writeCommentLine(writer, "");
    if (commentWriter !== writer || commentFilePath !== filePath || currentLiveId !== liveId) return null;
    if (liveArticleSessionActive) {
      send("articles:live-state", { state: "generating", liveId, frameCount: liveArticleFrames.length });
    }
    const article = await createAndSaveBroadcastArticle(filePath, context, {
      force: liveArticleSessionActive || Boolean(options.finalize),
      images: liveArticleSessionActive || options.finalize ? liveArticleFrames.slice(-LIVE_ARTICLE_MAX_FRAMES) : [],
      audioTranscript: liveArticleAudioTranscript ? liveArticleAudioTranscript.text : "",
      audioTranscriptSegmentCount: liveArticleAudioTranscript ? liveArticleAudioTranscript.segmentCount : 0
    });
    if (liveArticleSessionActive || options.finalize) {
      send("articles:live-state", {
        state: options.finalize ? "finalized" : "updated",
        liveId,
        frameCount: liveArticleFrames.length,
        generated: Boolean(article && article.status === "generated"),
        updatedAt: new Date().toISOString()
      });
    }
    return article;
  } catch (error) {
    send("articles:ai-fallback", {
      liveId,
      reason: "配信中の記事更新に失敗しました: " + error.message
    });
    if (liveArticleSessionActive) {
      send("articles:live-state", { state: "error", liveId, message: error.message || String(error) });
    }
    return null;
  } finally {
    articleUpdateInProgress = false;
    if (articleRefreshPending && commentWriter === writer && commentFilePath === filePath && currentLiveId === liveId) {
      articleRefreshPending = false;
      const retryTimer = setTimeout(() => { void refreshLiveBroadcastArticle(); }, 1000);
      if (typeof retryTimer.unref === "function") retryTimer.unref();
    } else if (!commentWriter || commentWriter !== writer) {
      articleRefreshPending = false;
    }
  }
}

function appendMarkerAndWait(type, fields = {}) {
  if (!commentWriter) return Promise.resolve(null);
  const writer = commentWriter;
  const timestamp = new Date().toISOString();
  const marker = { type, liveId: currentLiveId, timestamp, receivedAt: timestamp, ...fields };
  return writeCommentLine(writer, JSON.stringify(marker)).then(() => marker);
}

async function closeCommentWriter() {
  if (!commentWriter) return;
  if (articleUpdateTimer) { clearInterval(articleUpdateTimer); articleUpdateTimer = null; }
  if (liveArticleCaptureTimer) { clearInterval(liveArticleCaptureTimer); liveArticleCaptureTimer = null; }
  const writer = commentWriter;
  const oldPath = commentFilePath;
  const articleContext = {
    liveId: currentLiveId,
    broadcasterName: currentBroadcasterName,
    broadcasterId: currentBroadcasterId,
    ...currentProgramInfo,
    liveStatus: streamlinkProcess && streamlinkLiveId === currentLiveId ? "live" : "unknown"
  };
  commentWriter = null;
  let writeFailure = commentWriterError;
  commentWriterError = null;
  try {
    await finishCommentWriter(writer);
  } catch (error) {
    writeFailure = writeFailure || error;
  }
  if (writeFailure) {
    commentFilePath = oldPath;
    send("app:error", "コメントログを正常に確定できませんでした。未完成ファイルは元の場所に残しています: " + writeFailure.message);
    return;
  }
  try {
    commentFilePath = await moveCommentLogToBroadcasterFolder(oldPath);
    send("comments:file", { path: commentFilePath });
    await exportCommentSidecars(commentFilePath);
  } catch (error) {
    commentFilePath = oldPath;
    send("app:error", "コメントファイルの整理・形式変換に失敗しました: " + error.message);
  }
  while (articleUpdateInProgress) await new Promise(resolve => setTimeout(resolve, 200));
  try {
    await createAndSaveBroadcastArticle(commentFilePath, articleContext, {
      force: liveArticleSessionActive,
      images: liveArticleSessionActive ? liveArticleFrames.slice(-LIVE_ARTICLE_MAX_FRAMES) : [],
      audioTranscript: liveArticleAudioTranscript ? liveArticleAudioTranscript.text : "",
      audioTranscriptSegmentCount: liveArticleAudioTranscript ? liveArticleAudioTranscript.segmentCount : 0
    });
  } catch (error) {
    send("app:error", "放送記事の自動生成に失敗しました: " + error.message);
  }
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

  mainWindow.on("close", (event) => {
    if (process.platform === "win32" && tray && getMonitorSettings().closeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateSystemTrayMenu();
    }
  });
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("app:open-releases", async () => {
  const releasesUrl = "https://github.com/kanenao/-Nico-Live-Message-Recorder/releases";
  await shell.openExternal(releasesUrl);
  return true;
});

ipcMain.handle("app:changelog", async () => {
  const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");
  try {
    return await fs.promises.readFile(changelogPath, "utf8");
  } catch (error) {
    console.warn("Could not read application changelog:", error);
    return "";
  }
});

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

async function prepareCommentSession(liveId, displayName = "", broadcasterId = "", programInfo = {}) {
  if (provider) {
    try { provider.disconnect(); } catch (_) {}
    provider = null;
  }
  await closeCommentWriter();
  currentLiveId = liveId;
  currentProgramInfo = {
    programTitle: String(programInfo.programTitle || programInfo.title || "").slice(0, 300),
    description: String(programInfo.description || "").slice(0, 3000),
    startedAt: String(programInfo.startedAt || ""),
    endedAt: String(programInfo.endedAt || "")
  };
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

async function openHiddenLiveArticleCapture(value) {
  const liveId = safeLiveId(value);
  const url = "https://live.nicovideo.jp/watch/" + liveId;
  closeHiddenLiveArticleCapture();
  const capture = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    offscreen: true,
    frame: false,
    backgroundColor: "#080d18",
    autoHideMenuBar: true,
    webPreferences: {
      partition: "persist:nico-auth",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  liveArticleCaptureWindow = capture;
  liveArticleCaptureWindowLiveId = liveId;
  capture.webContents.setAudioMuted(true);
  capture.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  capture.on("closed", () => {
    if (liveArticleCaptureWindow === capture) {
      liveArticleCaptureWindow = null;
      liveArticleCaptureWindowLiveId = "";
    }
  });
  try {
    await capture.loadURL(url);
    if (capture.isDestroyed()) throw new Error("記事用の非表示映像ウィンドウが閉じられました。");
    return { liveId, hidden: true };
  } catch (error) {
    if (!capture.isDestroyed()) capture.destroy();
    if (liveArticleCaptureWindow === capture) {
      liveArticleCaptureWindow = null;
      liveArticleCaptureWindowLiveId = "";
    }
    throw error;
  }
}
function closeHiddenLiveArticleCapture() {
  const capture = liveArticleCaptureWindow;
  liveArticleCaptureWindow = null;
  liveArticleCaptureWindowLiveId = "";
  if (capture && !capture.isDestroyed()) {
    try { capture.destroy(); } catch (_) {}
  }
  return { closed: true };
}

async function captureLiveArticleFrame() {
  if (!liveArticleSessionActive || liveArticleCaptureInProgress || !liveArticleCaptureWindow ||
      liveArticleCaptureWindow.isDestroyed() || liveArticleCaptureWindowLiveId !== currentLiveId) return null;
  liveArticleCaptureInProgress = true;
  try {
    const image = await liveArticleCaptureWindow.webContents.capturePage();
    if (!image || image.isEmpty()) return null;
    const resized = image.resize({ width: 640 });
    const encoded = resized.toJPEG(62).toString("base64");
    if (!encoded) return null;
    liveArticleFrames.push({ image: encoded, capturedAt: new Date().toISOString() });
    if (liveArticleFrames.length > LIVE_ARTICLE_MAX_FRAMES) liveArticleFrames.shift();
    send("articles:live-state", { state: "capturing", liveId: currentLiveId, frameCount: liveArticleFrames.length, audioCapturing: Boolean(liveArticleAudioProcess) });
    return { frameCount: liveArticleFrames.length };
  } catch (error) {
    send("articles:live-state", { state: "capture-error", liveId: currentLiveId, message: error.message || String(error) });
    return null;
  } finally {
    liveArticleCaptureInProgress = false;
  }
}


function formatLiveAudioOffset(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}
async function processLiveArticleAudioSegments(liveId, includeCurrent = false) {
  if (liveArticleAudioProcessing || !liveArticleAudioSegmentDirectory) return;
  liveArticleAudioProcessing = true;
  try {
    const names = (await fs.promises.readdir(liveArticleAudioSegmentDirectory))
      .filter(name => /^audio-\d{5}\.wav$/i.test(name)).sort();
    const readyNames = includeCurrent ? names : names.slice(0, -1);
    const settings = readAppSettings();
    for (const name of readyNames) {
      if (liveArticleAudioProcessedFiles.has(name)) continue;
      const audioPath = path.join(liveArticleAudioSegmentDirectory, name);
      const stat = await fs.promises.stat(audioPath).catch(() => null);
      if (!stat || stat.size < 1024) { liveArticleAudioProcessedFiles.add(name); continue; }
      const index = Number((name.match(/(\d{5})/) || [])[1]) || 0;
      send("articles:live-state", { state: "audio-transcribing", liveId, segment: index + 1 });
      try {
        const result = await transcribeAudioFile({
          audioPath, whisperCliPath: settings.articleWhisperCliPath,
          modelPath: settings.articleWhisperModelPath
        });
        if (result.text) {
          liveArticleAudioTranscriptSegments.push(
            "【配信経過 " + formatLiveAudioOffset(index * LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS) + "】\n" + result.text
          );
          liveArticleAudioTranscript = {
            text: liveArticleAudioTranscriptSegments.join("\n").slice(-30000),
            segmentCount: liveArticleAudioTranscriptSegments.length
          };
          send("articles:live-state", {
            state: "audio-progress", liveId,
            segmentCount: liveArticleAudioTranscript.segmentCount,
            characterCount: liveArticleAudioTranscript.text.length,
            latestOffset: formatLiveAudioOffset((index + 1) * LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS)
          });
          if (Date.now() - liveArticleAudioLastArticleUpdateAt >= 60000) {
            liveArticleAudioLastArticleUpdateAt = Date.now();
            void refreshLiveBroadcastArticle();
          }
        }
      } catch (error) {
        send("articles:live-state", { state: "audio-warning", liveId, message: name + ": " + (error.message || String(error)) });
      } finally {
        liveArticleAudioProcessedFiles.add(name);
        await fs.promises.rm(audioPath, { force: true }).catch(() => {});
      }
    }
  } catch (error) {
    send("articles:live-state", { state: "audio-warning", liveId, message: error.message || String(error) });
  } finally { liveArticleAudioProcessing = false; }
}
async function startLiveArticleAudioCapture(liveId) {
  const settings = readAppSettings();
  const whisperCliPath = String(settings.articleWhisperCliPath || "");
  const modelPath = String(settings.articleWhisperModelPath || "");
  if (!whisperCliPath || !modelPath || !fs.existsSync(whisperCliPath) || !fs.existsSync(modelPath)) {
    send("articles:live-state", { state: "audio-disabled", liveId, message: "Whisper.cppの実行ファイルと日本語モデルを設定すると、生放送の音声も記事に反映できます。" });
    return { enabled: false, reason: "Whisper.cpp未設定" };
  }
  const tools = getVideoToolStatus();
  if (!tools.streamlinkPath || !tools.ffmpegPath) {
    send("articles:live-state", { state: "audio-error", liveId, message: "生放送音声の取得にはStreamlinkとFFmpegが必要です。" });
    return { enabled: false, reason: "Streamlink / FFmpeg未検出" };
  }
  const authSession = session.fromPartition("persist:nico-auth");
  const cookies = await authSession.cookies.get({ domain: "nicovideo.jp" });
  const token = cookies.find(cookie => cookie.name === "user_session")?.value || "";
  const runtime = createStreamlinkRuntime(app.getPath("temp"), token);
  const captureDirectory = fs.mkdtempSync(path.join(app.getPath("temp"), "nlmr-live-audio-"));
  const segmentDirectory = path.join(captureDirectory, "segments");
  fs.mkdirSync(segmentDirectory, { recursive: true });
  const streamArgs = buildStreamlinkArgs({
    configPath: runtime.configPath, liveId, quality: "best",
    stdout: true, ffmpegPath: tools.ffmpegPath
  });
  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-f", "segment", "-segment_time", String(LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS),
    "-reset_timestamps", "1", "-segment_format", "wav",
    path.join(segmentDirectory, "audio-%05d.wav")
  ];
  let streamChild, ffmpegChild;
  try {
    ffmpegChild = spawn(tools.ffmpegPath, ffmpegArgs, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    await new Promise((resolve, reject) => { ffmpegChild.once("spawn", resolve); ffmpegChild.once("error", reject); });
    streamChild = spawn(tools.streamlinkPath, streamArgs, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: runtime.env
    });
    await new Promise((resolve, reject) => { streamChild.once("spawn", resolve); streamChild.once("error", reject); });
    ffmpegChild.stdin.on("error", () => {});
    streamChild.stdout.pipe(ffmpegChild.stdin);
    ffmpegChild.stderr.on("data", chunk => {
      const message = chunk.toString("utf8").trim();
      if (message) send("articles:live-state", { state: "audio-warning", liveId, message: message.slice(-500) });
    });
    streamChild.stderr.on("data", chunk => {
      const message = chunk.toString("utf8");
      if (/error|failed|unable/i.test(message)) send("articles:live-state", { state: "audio-warning", liveId, message: message.trim().slice(-500) });
    });
  } catch (error) {
    for (const child of [streamChild, ffmpegChild]) if (child) { try { child.kill(); } catch (_) {} }
    await fs.promises.rm(runtime.runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(captureDirectory, { recursive: true, force: true }).catch(() => {});
    send("articles:live-state", { state: "audio-error", liveId, message: "リアルタイム音声取得を開始できませんでした: " + (error.message || String(error)) });
    return { enabled: false, reason: error.message || String(error) };
  }
  liveArticleAudioProcess = streamChild;
  liveArticleAudioFfmpegProcess = ffmpegChild;
  liveArticleAudioRuntimeDirectory = runtime.runtimeDirectory;
  liveArticleAudioPath = captureDirectory;
  liveArticleAudioSegmentDirectory = segmentDirectory;
  liveArticleAudioProcessedFiles = new Set();
  liveArticleAudioTranscriptSegments = [];
  liveArticleAudioTranscript = null;
  liveArticleAudioLastArticleUpdateAt = 0;
  liveArticleAudioClosePromise = new Promise(resolve => streamChild.once("close", (code, signal) => resolve({ code, signal })));
  liveArticleAudioFfmpegClosePromise = new Promise(resolve => ffmpegChild.once("close", (code, signal) => resolve({ code, signal })));
  liveArticleAudioSegmentTimer = setInterval(() => void processLiveArticleAudioSegments(liveId, false), LIVE_ARTICLE_AUDIO_POLL_INTERVAL_MS);
  if (typeof liveArticleAudioSegmentTimer.unref === "function") liveArticleAudioSegmentTimer.unref();
  send("articles:live-state", { state: "audio-capturing", liveId, segmentSeconds: LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS });
  return { enabled: true, segmentSeconds: LIVE_ARTICLE_AUDIO_SEGMENT_SECONDS };
}
async function stopLiveArticleAudioCapture(liveId) {
  const streamChild = liveArticleAudioProcess;
  const ffmpegChild = liveArticleAudioFfmpegProcess;
  const captureDirectory = liveArticleAudioPath;
  if (!streamChild && !ffmpegChild) return liveArticleAudioTranscript;
  if (liveArticleAudioSegmentTimer) { clearInterval(liveArticleAudioSegmentTimer); liveArticleAudioSegmentTimer = null; }
  send("articles:live-state", { state: "audio-finalizing", liveId });
  try {
    if (streamChild) { try { streamChild.kill(); } catch (_) {} }
    if (liveArticleAudioClosePromise) await Promise.race([liveArticleAudioClosePromise, new Promise(resolve => setTimeout(resolve, 15000))]);
    if (ffmpegChild && ffmpegChild.stdin && !ffmpegChild.stdin.destroyed) { try { ffmpegChild.stdin.end(); } catch (_) {} }
    if (liveArticleAudioFfmpegClosePromise) await Promise.race([liveArticleAudioFfmpegClosePromise, new Promise(resolve => setTimeout(resolve, 20000))]);
    while (liveArticleAudioProcessing) await new Promise(resolve => setTimeout(resolve, 100));
    await processLiveArticleAudioSegments(liveId, true);
    if (!liveArticleAudioTranscript || !liveArticleAudioTranscript.text) throw new Error("音声を文字起こしできませんでした。");
    send("articles:live-state", { state: "audio-complete", liveId, segmentCount: liveArticleAudioTranscript.segmentCount, characterCount: liveArticleAudioTranscript.text.length });
    return liveArticleAudioTranscript;
  } catch (error) {
    send("articles:live-state", { state: "audio-error", liveId, message: error.message || String(error) });
    return null;
  } finally {
    liveArticleAudioProcess = null;
    liveArticleAudioFfmpegProcess = null;
    liveArticleAudioClosePromise = null;
    liveArticleAudioFfmpegClosePromise = null;
    liveArticleAudioPath = "";
    liveArticleAudioSegmentDirectory = "";
    liveArticleAudioProcessing = false;
    liveArticleAudioProcessedFiles = new Set();
    const runtimeDirectory = liveArticleAudioRuntimeDirectory;
    liveArticleAudioRuntimeDirectory = "";
    if (captureDirectory) await fs.promises.rm(captureDirectory, { recursive: true, force: true }).catch(() => {});
    if (runtimeDirectory) await fs.promises.rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
async function startLiveArticleSession(input = {}) {
  if (timeshiftCommentFetchActive) throw new Error("過去配信のコメント取得中は生放送記事を開始できません。");
  if (provider || commentWriter || liveArticleSessionActive) throw new Error("別のコメント取得セッションが実行中です。先に切断してください。");
  if (streamlinkProcess || streamlinkFinalizePromise) throw new Error("録画中は生放送記事セッションを開始できません。録画停止後に再試行してください。");
  const liveId = safeLiveId(input.liveId);
  const displayName = String(input.broadcasterName || "").trim().slice(0, 80);
  const programInfo = {
    programTitle: String(input.programTitle || "").trim().slice(0, 300),
    description: String(input.description || "").trim().slice(0, 3000)
  };
  liveArticleFrames = [];
  liveArticleCommentRefreshCounter = 0;
  liveArticleCommentLastRefreshAt = 0;
  liveArticleSessionActive = true;
  try {
    await prepareCommentSession(liveId, displayName, "", programInfo);
    await openHiddenLiveArticleCapture(liveId);
    await connectPreparedCommentSession(liveId);
    await startLiveArticleAudioCapture(liveId);
    await new Promise(resolve => setTimeout(resolve, 8000));
    if (articleUpdateTimer) clearInterval(articleUpdateTimer);
    articleUpdateTimer = setInterval(() => { void refreshLiveBroadcastArticle(); }, LIVE_ARTICLE_REFRESH_INTERVAL_MS);
    if (typeof articleUpdateTimer.unref === "function") articleUpdateTimer.unref();
    if (liveArticleCaptureTimer) clearInterval(liveArticleCaptureTimer);
    liveArticleCaptureTimer = setInterval(() => { void captureLiveArticleFrame(); }, LIVE_ARTICLE_FRAME_INTERVAL_MS);
    if (typeof liveArticleCaptureTimer.unref === "function") liveArticleCaptureTimer.unref();
    await captureLiveArticleFrame();
    articleRefreshPending = false;
    send("articles:live-state", { state: "started", liveId, frameCount: liveArticleFrames.length });
    // Do not wait for the five-minute interval: create the first article as soon as
    // the live preview and comment connection are ready.
    void refreshLiveBroadcastArticle();
    return { started: true, liveId, commentFile: commentFilePath, frameCount: liveArticleFrames.length };
  } catch (error) {
    if (provider) { try { provider.disconnect(); } catch (_) {} provider = null; }
    await stopLiveArticleAudioCapture(liveId);
    await closeCommentWriter();
    closeHiddenLiveArticleCapture();
    liveArticleSessionActive = false;
    liveArticleFrames = [];
    send("articles:live-state", { state: "error", liveId, message: error.message || String(error) });
    throw error;
  }
}

async function stopLiveArticleSession() {
  if (!liveArticleSessionActive && !commentWriter) return { stopped: true, alreadyStopped: true };
  if (articleUpdateTimer) { clearInterval(articleUpdateTimer); articleUpdateTimer = null; }
  if (liveArticleCaptureTimer) { clearInterval(liveArticleCaptureTimer); liveArticleCaptureTimer = null; }
  articleRefreshPending = false;
  if (provider) { try { provider.disconnect(); } catch (_) {} provider = null; }
  // Let an in-flight Ollama request finish before creating the definitive article.
  while (articleUpdateInProgress) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  articleRefreshPending = false;
  await stopLiveArticleAudioCapture(currentLiveId);
  if (commentWriter && commentFilePath) {
    await refreshLiveBroadcastArticle({ finalize: true });
  }
  await closeCommentWriter();
  const liveId = currentLiveId;
  liveArticleSessionActive = false;
  liveArticleFrames = [];
  liveArticleAudioTranscript = null;
  currentLiveId = "";
  closeHiddenLiveArticleCapture();
  send("articles:live-state", { state: "stopped", liveId });
  return { stopped: true, liveId };
}

ipcMain.handle("articles:live-start", (_event, input) => startLiveArticleSession(input));
ipcMain.handle("articles:live-stop", () => stopLiveArticleSession());

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
  if (liveArticleSessionActive) return stopLiveArticleSession();
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

const WHISPER_AUTO_DOWNLOAD = Object.freeze({
  runtimeUrl: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
  runtimeSha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
  modelUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  modelSha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac"
});
async function downloadWhisperFile(url, destination, expectedHash, algorithm, stage) {
  const partialPath = destination + ".download";
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.rmSync(partialPath, { force: true }); } catch (_) {}
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Nico-Live-Message-Recorder" } });
  if (!response.ok || !response.body) throw new Error("ダウンロードに失敗しました（HTTP " + response.status + "）。");
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = createHash(algorithm);
  const fd = fs.openSync(partialPath, "w");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      fs.writeSync(fd, buffer); hash.update(buffer); received += buffer.length;
      send("whisper:download-progress", { stage, received, total, percent: total ? Math.min(99, Math.floor(received / total * 100)) : 0 });
    }
  } finally { fs.closeSync(fd); }
  if (hash.digest("hex").toLowerCase() !== expectedHash.toLowerCase()) {
    fs.rmSync(partialPath, { force: true });
    throw new Error("ダウンロードしたファイルのハッシュ検証に失敗しました。安全のためセットアップを中止しました。");
  }
  fs.renameSync(partialPath, destination);
}
function findWhisperCli(directory) {
  if (!fs.existsSync(directory)) return "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "whisper-cli.exe") return target;
    if (entry.isDirectory()) { const found = findWhisperCli(target); if (found) return found; }
  }
  return "";
}
async function installWhisperAutomatically() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Whisper.cppの自動セットアップはWindows x64版に対応しています。");
  const root = path.join(app.getPath("userData"), "whisper");
  const runtimeDirectory = path.join(root, "runtime");
  const modelDirectory = path.join(root, "models");
  let cliPath = findWhisperCli(runtimeDirectory);
  const modelPath = path.join(modelDirectory, "ggml-base.bin");
  if (!cliPath) {
    send("whisper:download-progress", { stage: "runtime", received: 0, total: 0, percent: 0 });
    const archivePath = path.join(root, "whisper-bin-x64.zip");
    await downloadWhisperFile(WHISPER_AUTO_DOWNLOAD.runtimeUrl, archivePath, WHISPER_AUTO_DOWNLOAD.runtimeSha256, "sha256", "runtime");
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "Expand-Archive -LiteralPath " + quote(archivePath) + " -DestinationPath " + quote(runtimeDirectory) + " -Force"],
      { windowsHide: true, timeout: 120000 });
    fs.rmSync(archivePath, { force: true });
    cliPath = findWhisperCli(runtimeDirectory);
  }
  if (!cliPath) throw new Error("展開したWhisper.cppから whisper-cli.exe が見つかりませんでした。");
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100 * 1024 * 1024) {
    send("whisper:download-progress", { stage: "model", received: 0, total: 0, percent: 0 });
    await downloadWhisperFile(WHISPER_AUTO_DOWNLOAD.modelUrl, modelPath, WHISPER_AUTO_DOWNLOAD.modelSha1, "sha1", "model");
  }
  writeAppSettings({ articleWhisperCliPath: cliPath, articleWhisperModelPath: modelPath, articleWhisperManaged: true });
  send("whisper:download-progress", { stage: "complete", received: 0, total: 0, percent: 100 });
  return { cliPath, modelPath, cliName: path.basename(cliPath), modelName: path.basename(modelPath) };
}
const DEFAULT_MONITOR_SETTINGS = Object.freeze({
  intervalSeconds: 10,
  autoRecord: true,
  autoStart: true,
  runAtStartup: true,
  closeToTray: true,
  keepAwake: true,
  quality: "best",
  commentFormat: "jsonl",
  autoUpdateStreamlink: true,
  notifyOnLive: true,
  aiArticleEnabled: true,
  aiArticleModel: "qwen2.5:3b",
  targets: []
});

function getMonitorSettings() {
  const stored = readAppSettings().monitor || {};
  const targets = Array.isArray(stored.targets) ? stored.targets : [];
  const isLegacyMonitorSettings = stored.runAtStartup === undefined;
  const storedIntervalSeconds = Number(stored.intervalSeconds);
  const normalizedIntervalSeconds = isLegacyMonitorSettings && storedIntervalSeconds === 60
    ? 10
    : storedIntervalSeconds;
  return {
    ...DEFAULT_MONITOR_SETTINGS,
    ...stored,
    intervalSeconds: [10, 15, 30, 60, 120, 300].includes(normalizedIntervalSeconds)
      ? normalizedIntervalSeconds
      : DEFAULT_MONITOR_SETTINGS.intervalSeconds,
    autoRecord: stored.autoRecord !== false,
    autoStart: stored.autoStart !== false,
    runAtStartup: stored.runAtStartup !== false,
    closeToTray: stored.closeToTray !== false,
    keepAwake: stored.keepAwake !== false,
    quality: stored.quality === "worst" ? "worst" : "best",
    commentFormat: ["jsonl", "csv", "ass", "all"].includes(stored.commentFormat) ? stored.commentFormat : "jsonl",
    autoUpdateStreamlink: stored.autoUpdateStreamlink !== false,
    notifyOnLive: stored.notifyOnLive !== false,
    aiArticleEnabled: stored.aiArticleEnabled !== false,
    aiArticleModel: typeof stored.aiArticleModel === "string" && stored.aiArticleModel.trim() ? stored.aiArticleModel.trim().slice(0, 100) : "qwen2.5:3b",
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
  if (![10, 15, 30, 60, 120, 300].includes(intervalSeconds)) {
    throw new Error("監視間隔は10秒・15秒・30秒・1分・2分・5分から選択してください。");
  }
  const normalized = {
    intervalSeconds,
    autoRecord: candidate.autoRecord !== false,
    autoStart: candidate.autoStart !== false,
    runAtStartup: candidate.runAtStartup !== false,
    closeToTray: candidate.closeToTray !== false,
    keepAwake: candidate.keepAwake !== false,
    quality: candidate.quality === "worst" ? "worst" : "best",
    commentFormat: ["jsonl", "csv", "ass", "all"].includes(candidate.commentFormat) ? candidate.commentFormat : "jsonl",
    autoUpdateStreamlink: candidate.autoUpdateStreamlink !== false,
    notifyOnLive: candidate.notifyOnLive !== false,
    aiArticleEnabled: candidate.aiArticleEnabled !== false,
    aiArticleModel: typeof candidate.aiArticleModel === "string" && candidate.aiArticleModel.trim() ? candidate.aiArticleModel.trim().slice(0, 100) : "qwen2.5:3b",
    targets: current.targets
  };
  writeAppSettings({ monitor: normalized });
  applyAutoLaunchSetting(normalized.runAtStartup);
  if (monitorRunning) {
    syncMonitorPowerSaveBlocker();
    restartMonitorTimer();
  }
  updateSystemTrayMenu();

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
    statuses: Object.fromEntries(monitorTargetStatuses.entries()),
    pendingDetections: monitorPendingDetections.splice(0, 100)
  };
}

function sendMonitorState(state, details = {}) {
  send("monitor:state", { running: monitorRunning, state, ...details });
  updateSystemTrayMenu();
}

function applyAutoLaunchSetting(enabled) {
  if (process.platform !== "win32" || typeof app.setLoginItemSettings !== "function") return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: [] });
  } catch (error) {
    console.warn("Could not update Windows startup setting:", error);
  }
}

function syncMonitorPowerSaveBlocker() {
  const shouldStayAwake = monitorRunning && getMonitorSettings().keepAwake;
  if (shouldStayAwake && monitorPowerSaveBlockerId === null) {
    try { monitorPowerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension"); }
    catch (error) { console.warn("Could not prevent system suspension during monitoring:", error); }
  } else if (!shouldStayAwake && monitorPowerSaveBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(monitorPowerSaveBlockerId)) {
        powerSaveBlocker.stop(monitorPowerSaveBlockerId);
      }
    } catch (error) {
      console.warn("Could not release monitor power-save blocker:", error);
    }
    monitorPowerSaveBlockerId = null;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) makeWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestAppQuit() {
  isQuitting = true;
  app.quit();
}

function updateSystemTrayMenu() {
  if (!tray) return;
  const config = getMonitorSettings();
  const canStart = !monitorRunning && config.targets.some((target) => target.enabled);
  tray.setToolTip(monitorRunning
    ? "Nico Live Message Recorder：24時間監視中"
    : "Nico Live Message Recorder：待機中");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Nico Live Message Recorder", enabled: false },
    { type: "separator" },
    { label: "ウィンドウを表示", click: showMainWindow },
    { label: monitorRunning ? "配信監視：実行中" : "配信監視：停止中", enabled: false },
    {
      label: "監視を開始",
      enabled: canStart,
      click: () => {
        try { startMonitor(); showMainWindow(); }
        catch (error) { console.error("Could not start monitoring from tray:", error); }
      }
    },
    { label: "監視を停止", enabled: monitorRunning, click: () => stopMonitor() },
    { type: "separator" },
    { label: "アプリを終了", click: requestAppQuit }
  ]));
}

async function createSystemTray() {
  if (process.platform !== "win32" || tray) return Boolean(tray);
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "small" });
    if (!icon || icon.isEmpty()) throw new Error("アプリケーションアイコンを取得できませんでした。");
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    updateSystemTrayMenu();
    return true;
  } catch (error) {
    console.warn("System tray could not be initialized; window close will exit normally:", error);
    tray = null;
    return false;
  }
}

function queueMonitorDetection(payload) {
  monitorPendingDetections.push(payload);
  while (monitorPendingDetections.length > 100) monitorPendingDetections.shift();

  if (getMonitorSettings().notifyOnLive) {
    const broadcaster = String(payload.displayName || payload.name || ("ユーザー " + payload.userId)).slice(0, 80);
    const title = payload.title ? String(payload.title).slice(0, 120) : "";
    const body = broadcaster + " が配信を開始しました。" +
      (title ? "\n" + title : "") +
      "\n" + String(payload.liveId || "");
    showDesktopNotification("配信開始を検知しました", body);
  }
  send("monitor:live-detected", payload);
}

function notifyMonitorRecordingResult(result) {
  const settings = getMonitorSettings();
  if (!settings.notifyOnLive || !result || !["started", "failed"].includes(result.status)) {
    return { shown: false, reason: "disabled-or-invalid" };
  }

  const liveId = String(result.liveId || "").slice(0, 32);
  if (!/^lv\d{5,}$/.test(liveId)) return { shown: false, reason: "invalid-live-id" };
  const userId = String(result.userId || "").replace(/\D/g, "").slice(0, 24);
  const key = (userId || "unknown") + ":" + liveId;
  const broadcaster = String(result.name || (userId ? "ユーザー " + userId : "配信者")).slice(0, 80);
  const detail = String(result.message || "").replace(/[\r\n]+/g, " ").slice(0, 220);

  if (result.status === "failed") {
    // Do not repeat the same failure toast on every automatic retry.
    if (monitorFailureNotifications.has(key)) return { shown: false, reason: "failure-already-notified" };
    monitorFailureNotifications.add(key);
    while (monitorFailureNotifications.size > 500) {
      monitorFailureNotifications.delete(monitorFailureNotifications.values().next().value);
    }
    const body = broadcaster + " / " + liveId +
      (detail ? "\n" + detail : "") +
      "\n次回の監視確認で再試行します。";
    return { shown: showDesktopNotification("自動録画を開始できませんでした", body) };
  }

  monitorFailureNotifications.delete(key);
  const commentError = String(result.commentError || "").replace(/[\r\n]+/g, " ").slice(0, 180);
  const body = broadcaster + " / " + liveId +
    (commentError
      ? "\n映像録画：開始済み\nコメント取得：失敗（" + commentError + "）"
      : "\n映像録画・コメント取得：開始しました。");
  return {
    shown: showDesktopNotification(
      commentError ? "映像録画を開始（コメント取得に失敗）" : "自動録画を開始しました",
      body
    )
  };
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

    // Prefer the authenticated follow-list API so follower-only streams are detected too.
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
      console.warn("Followed-program API unavailable; falling back to public history:", error);
    }

    // Query public history for non-followed targets concurrently, bounded to four requests.
    // Process the resulting statuses in list order so app-settings writes remain predictable.
    const historyTargets = enabledTargets.filter((target) => !followedLiveByUser.has(target.userId));
    const historyResults = await mapWithConcurrency(historyTargets, 4, async (target) => {
      try {
        return { userId: target.userId, result: await fetchUserBroadcastStatus(target.userId) };
      } catch (error) {
        return { userId: target.userId, error };
      }
    });
    const historyByUser = new Map(historyResults.map((item) => [item.userId, item]));

    for (const target of enabledTargets) {
      if (!monitorRunning) break;
      try {
        const followedProgram = followedLiveByUser.get(target.userId);
        const history = followedProgram ? null : historyByUser.get(target.userId);
        if (history && history.error) throw history.error;
        const result = history ? history.result : null;
        const live = followedProgram
          ? {
              liveId: followedProgram.liveId,
              title: followedProgram.title,
              status: "ON_AIR",
              isFollowerOnly: followedProgram.isFollowerOnly,
              beginTime: followedProgram.beginAt
            }
          : result.live;
        const latest = result ? result.latest : null;
        const providerName = String(
          (followedProgram && followedProgram.providerName) ||
          (latest && latest.providerName) || ""
        ).trim();
        const savedName = String(target.name || "").trim();
        const displayName = (providerName ||
          (savedName && !/^ユーザー \d+$/.test(savedName)
            ? savedName : "ユーザー " + target.userId)).slice(0, 80);
        const checkedAt = result ? result.checkedAt : new Date().toISOString();

        // A profile lookup is useful for labels/folder names, but must never delay
        // the immediate video + comment capture triggered by an on-air result.
        if (!providerName && (!savedName || /^ユーザー \d+$/.test(savedName))) {
          void resolveMonitorUserName(target, followedProgram, latest).then((resolvedName) => {
            const currentStatus = monitorTargetStatuses.get(target.userId);
            if (!resolvedName || !currentStatus || currentStatus.checkedAt !== checkedAt) return;
            currentStatus.name = resolvedName;
            monitorTargetStatuses.set(target.userId, currentStatus);
            send("monitor:target-status", currentStatus);
          }).catch((error) => {
            console.warn("Background broadcaster-name lookup failed:", target.userId, error);
          });
        }
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

        if (!live) {
          monitorObservedLiveIds.delete(target.userId);
          continue;
        }

        // In-memory observation, not the persisted lastProgramId, gates each live event.
        // A process restart therefore detects an already-on-air show and resumes auto-capture.
        const previouslyObservedLiveId = monitorObservedLiveIds.get(target.userId) || "";
        monitorObservedLiveIds.set(target.userId, live.liveId);
        if (previouslyObservedLiveId !== live.liveId) {
          const updated = getMonitorSettings();
          const match = updated.targets.find((item) => item.userId === target.userId);
          if (match && match.lastProgramId !== live.liveId) {
            match.lastProgramId = live.liveId;
            writeAppSettings({ monitor: updated });
          }
          queueMonitorDetection({
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

function scheduleNextMonitorCheck() {
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = null;
  if (!monitorRunning) return;
  const intervalMs = getMonitorSettings().intervalSeconds * 1000;
  monitorTimer = setTimeout(async () => {
    monitorTimer = null;
    try {
      await checkMonitoredUsers();
    } catch (error) {
      sendMonitorState("error", {
        message: error && error.message ? error.message : String(error)
      });
    } finally {
      scheduleNextMonitorCheck();
    }
  }, intervalMs);
}

function restartMonitorTimer() {
  scheduleNextMonitorCheck();
}

function startMonitor() {
  const config = getMonitorSettings();
  if (monitorRunning) return getMonitorState();
  if (!config.targets.some((target) => target.enabled)) {
    throw new Error("監視するユーザーを先に登録してください。");
  }
  monitorRunning = true;
  syncMonitorPowerSaveBlocker();
  sendMonitorState("running", { checkedAt: monitorLastCheckAt });
  checkMonitoredUsers().catch((error) => {
    sendMonitorState("error", {
      message: error && error.message ? error.message : String(error)
    });
  }).finally(() => scheduleNextMonitorCheck());
  return getMonitorState();
}

function stopMonitor() {
  monitorRunning = false;
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = null;
  monitorObservedLiveIds.clear();
  syncMonitorPowerSaveBlocker();
  sendMonitorState("stopped");
  return getMonitorState();
}

ipcMain.handle("monitor:get-state", () => getMonitorState());
ipcMain.handle("ollama:get-status", () => getOllamaStatus());
ipcMain.handle("ollama:download-installer", async () => {
  const installerPath = await downloadOllamaInstaller({
    directory: path.join(app.getPath("userData"), "ollama"),
    onProgress: (progress) => send("ollama:setup-progress", progress)
  });
  const launchError = await shell.openPath(installerPath);
  if (launchError) throw new Error("Ollamaインストーラーを起動できませんでした: " + launchError);
  return { installerPath, launched: true };
});
ipcMain.handle("ollama:pull-model", async (_event, input) => {
  const settings = getMonitorSettings();
  const model = String(input && input.model || settings.aiArticleModel || "qwen2.5:3b").trim();
  const result = await pullOllamaModel({
    baseUrl: settings.baseUrl || "http://127.0.0.1:11434", model,
    onProgress: (progress) => send("ollama:setup-progress", progress)
  });
  return result;
});

ipcMain.handle("monitor:save-settings", (_event, values) => saveMonitorSettings(values));

ipcMain.handle("monitor:notify-recording-result", (_event, result) => notifyMonitorRecordingResult(result));

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
  monitorObservedLiveIds.delete(userId);
  monitorPendingDetections.splice(0, monitorPendingDetections.length,
    ...monitorPendingDetections.filter((item) => item.userId !== userId));
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
  if (target) monitorObservedLiveIds.delete(userId);
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
      if (code === 0 && hasNonEmptyFile(outputPath)) {
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
  const hasOutput = hasNonEmptyFile(rawPath);

  if (hasOutput && ffmpegPath) {
    const mp4Path = rawPath.replace(/\.ts$/i, ".mp4");
    try {
      await remuxTransportStreamToMp4(rawPath, mp4Path, ffmpegPath);
      if (!hasNonEmptyFile(mp4Path)) {
        throw new Error("変換後のMP4ファイルを確認できません。");
      }
      finalPath = mp4Path;
      streamlinkFinalOutputPath = mp4Path;
      converted = true;
    } catch (_) {
      send("app:error", "MP4変換に失敗したため、元のTSファイルを保存しました。FFmpegの設定を確認してください。");
    }
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

  let hasFinalOutput = hasNonEmptyFile(finalPath);
  if (!hasFinalOutput && finalPath !== rawPath && hasNonEmptyFile(rawPath)) {
    finalPath = rawPath;
    streamlinkFinalOutputPath = rawPath;
    converted = false;
    hasFinalOutput = true;
    send("app:error", "変換後ファイルを確認できなかったため、元のTS録画を保存しました。");
  }
  if (hasFinalOutput && converted && finalPath !== rawPath) {
    await fs.promises.unlink(rawPath).catch(() => {});
  }
  if (!hasFinalOutput) {
    finalPath = null;
    converted = false;
    send("app:error", "録画ファイルの最終確認に失敗しました。保存先とディスクの空き容量を確認してください。");
  }

  if (currentLiveId && commentWriter) {
    try {
      await appendMarkerAndWait("videoStop", {
        timestamp: stoppedAt,
        receivedAt: stoppedAt,
        videoStoppedAt: stoppedAt,
        videoFile: finalPath,
        sourceVideoFile: rawPath
      });
    } catch (error) {
      send("app:error", "コメントログの終了マーカー保存に失敗しました: " + error.message);
    }
  }

  if (hasFinalOutput && commentWriter && commentFilePath && streamlinkLiveId) {
    try {
      await createAndSaveBroadcastArticle(commentFilePath, {
        liveId: streamlinkLiveId,
        broadcasterName: streamlinkBroadcasterName || currentBroadcasterName,
        broadcasterId: streamlinkBroadcasterId || currentBroadcasterId,
        ...currentProgramInfo,
        liveStatus: commentWriter && provider ? "live" : "unknown",
        videoFile: finalPath
      });
    } catch (error) {
      send("app:error", "放送記事の自動生成に失敗しました: " + error.message);
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
  const finalStderr = streamlinkStderr; streamlinkStderr = "";
  if (runtimeDirectory) {
    await fs.promises.rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
  }

  const resultPath = hasFinalOutput ? finalPath : null;
  const result = {
    path: resultPath,
    rawPath: hasNonEmptyFile(rawPath) ? rawPath : null,
    converted,
    incomplete: !streamlinkStopRequested && (exit.code !== 0 || Boolean(exit.signal)),
    exitCode: exit.code,
    signal: exit.signal || null
  };
  send("video:state", { recording: false, ...result });

  if (!streamlinkStopRequested && exit.code !== 0) {
    send("app:error", "Streamlinkが終了コード " + exit.code + " で終了しました。配信の公開状態・視聴権限・Streamlinkの対応状況を確認してください。" + (finalStderr.trim() ? "\n詳細: " + finalStderr.trim().slice(-1800) : ""));
  } else if (!hasFinalOutput) {
    send("app:error", "録画データが作成されませんでした。放送ID・視聴権限・Streamlinkの対応状況を確認してください。" + (finalStderr.trim() ? "\nStreamlink詳細: " + finalStderr.trim().slice(-1800) : ""));
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
  streamlinkStderr = "";
  if (child.stderr) child.stderr.on("data", chunk => { streamlinkStderr = (streamlinkStderr + chunk.toString("utf8")).slice(-12000); });

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

  const startupDeadline = Date.now() + 25000;
  let outputReady = false;
  while (Date.now() < startupDeadline) {
    if (hasNonEmptyFile(outputPath)) { outputReady = true; break; }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!outputReady) {
    const detail = streamlinkStderr.trim().slice(-1800);
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGINT"); } catch (_) {} }
    if (streamlinkFinalizePromise) await streamlinkFinalizePromise.catch(() => {});
    throw new Error("Streamlinkは起動しましたが、録画データを受信できませんでした。放送ID・視聴権限・Streamlinkの対応状況を確認してください。" + (detail ? "\nStreamlink詳細: " + detail : ""));
  }
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
        await writeCommentLine(commentWriter, JSON.stringify(record));
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
  const programInfo = {
    programTitle: String(options && (options.programTitle || options.title) || "").slice(0, 300),
    description: String(options && options.description || "").slice(0, 3000),
    startedAt: String(options && options.startedAt || "")
  };
  const reuseComments = currentLiveId === liveId && Boolean(provider && commentWriter);

  if (reuseComments) {
    if (requestedName) currentBroadcasterName = requestedName;
    if (requestedId) currentBroadcasterId = requestedId;
    currentProgramInfo = { ...currentProgramInfo, ...programInfo };
  } else {
    await prepareCommentSession(liveId, requestedName, requestedId, programInfo);
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

function transcodeCompositionToMp4(inputPath, outputPath, quality, durationMs) {
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
    let progressBuffer = "";
    let lastProgress = -1;
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const value = chunk.toString("utf8");
        stderr = (stderr + value).slice(-2400);
        progressBuffer += value;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || "";
        for (const line of lines) {
          const match = line.match(/^out_time_(?:ms|us)=(\d+)$/);
          if (!match) continue;
          const percent = calculateTranscodeProgressPercent(match[1], durationMs);
          if (percent <= lastProgress + 0.25) continue;
          lastProgress = percent;
          send("compose:status", {
            state: "progress",
            percent,
            message: "MP4変換中 " + Math.floor(percent) + "%"
          });
        }
      });
    }
    child.once("error", (error) => reject(new Error("MP4変換を開始できません: " + error.message)));
    child.once("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        send("compose:status", { state: "progress", percent: 100, message: "MP4変換中 100%" });
        resolve(outputPath);
      } else {
        reject(new Error(stderr.trim() || ("FFmpegによるMP4変換に失敗しました（終了コード " + code + "）。")));
      }
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

  const selectedPath = saveResult.filePath;
  const finalPath = normalizeCompositionOutputPath(selectedPath, format);
  const requestedDurationMs = Number(options && options.durationMs);
  if (format === "mp4" && (!Number.isFinite(requestedDurationMs) || requestedDurationMs <= 0)) {
    throw new Error("MP4変換の進捗計算に必要な動画の長さを取得できませんでした。");
  }
  composeOutputDurationMs = format === "mp4"
    ? Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.round(requestedDurationMs)))
    : 0;
  const pathWasNormalized = path.resolve(finalPath) !== path.resolve(selectedPath);
  if (pathWasNormalized) {
    const targetExists = fs.existsSync(finalPath);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: targetExists ? "warning" : "info",
      title: "保存先の確認",
      message: "選択したファイル名の拡張子を ." + format + " に変更します。",
      detail: targetExists
        ? "変更後の保存先「" + finalPath + "」は既に存在します。上書きしますか？"
        : "変更後の保存先：" + finalPath,
      buttons: ["キャンセル", targetExists ? "上書きして保存" : "この保存先で続行"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) return { cancelled: true };
  }
  const workingPath = format === "mp4"
    ? createMp4IntermediatePath(finalPath, randomUUID())
    : finalPath;
  composeFilePath = workingPath;
  composeFinalFilePath = finalPath;
  composeOutputFormat = format;
  composeOutputQuality = quality;
  composeWriter = fs.createWriteStream(composeFilePath, { flags: format === "mp4" ? "wx" : "w" });
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
  const durationMs = composeOutputDurationMs;
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
      composeOutputDurationMs = 0;
      return { path: savedPath, format: "webm", converted: false };
    }

    send("compose:status", { state: "converting", percent: 0, message: "FFmpegでMP4（H.264 / AAC）へ変換しています。" });
    try {
      await transcodeCompositionToMp4(savedPath, finalPath, quality, durationMs);
      await fs.promises.unlink(savedPath).catch(() => {});
      send("compose:status", { state: "complete", message: "MP4変換が完了しました。" });
      composeFinalFilePath = "";
      composeOutputFormat = "webm";
      composeOutputQuality = "standard";
      composeOutputDurationMs = 0;
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
      composeOutputDurationMs = 0;
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
  composeOutputDurationMs = 0;
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
  const savedArticles = listBroadcastArticles().items;
  for (const item of items) {
    if (item.type !== "video") continue;
    const article = savedArticles.find(candidate =>
      (candidate.videoFile && path.resolve(candidate.videoFile) === path.resolve(item.path)) ||
      (candidate.liveId && item.liveId && String(candidate.liveId).toLowerCase() === item.liveId.toLowerCase())
    );
    if (article) item.article = {
      articlePath: article.articlePath || "",
      title: article.title || article.programTitle || article.liveId || "放送記事",
      summary: article.summary || (Array.isArray(article.paragraphs) ? article.paragraphs[0] : "") || "",
      topics: Array.isArray(article.topics) ? article.topics.slice(0, 5).map(topic => topic.term).filter(Boolean) : []
    };
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
ipcMain.handle("library:thumbnail", (_event, value) => {
  try {
    const target = resolveLibraryItemPath(value);
    if (!LIBRARY_VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase())) return "";
    const settings = readAppSettings();
    const ffmpegPath = findBundledFfmpegExecutable() || findFfmpegExecutable({ customPath: settings.ffmpegPath });
    if (!ffmpegPath) return "";
    const image = execFileSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-ss", "00:00:01", "-i", target,
      "-frames:v", "1", "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
      "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    return image && image.length ? "data:image/jpeg;base64," + image.toString("base64") : "";
  } catch (_) {
    return "";
  }
});
function resolveBroadcastArticlePath(value) {
  const root = path.resolve(dataRoot(), "articles"), target = path.resolve(String(value || ""));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(target).toLowerCase() !== ".json") throw new Error("記事フォルダー内のJSONファイルを指定してください。");
  let realTarget;
  try { realTarget = fs.realpathSync(target); if (!fs.statSync(realTarget).isFile()) throw new Error("ファイルではありません。"); }
  catch (error) { throw new Error("記事ファイルが見つかりません: " + error.message); }
  const realRelative = path.relative(root, realTarget);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("記事保存フォルダー外のファイルは削除できません。");
  return realTarget;
}
ipcMain.handle("articles:delete", async (_event, value) => {
  const target = resolveBroadcastArticlePath(value);
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning", buttons: ["キャンセル", "記事だけ削除"], defaultId: 0, cancelId: 0,
    title: "放送記事の削除", message: "この放送記事を削除しますか？",
    detail: "削除するのは記事JSONだけです。録画動画・コメントログは削除されません。"
  });
  if (confirmation.response !== 1) return { cancelled: true };
  await fs.promises.unlink(target);
  return { deleted: true, fileName: path.basename(target) };
});
ipcMain.handle("articles:list", () => listBroadcastArticles());
ipcMain.handle("articles:export-html", async (_event, article) => {
  if (!article || typeof article !== "object" || Array.isArray(article)) throw new Error("記事データが正しくありません。");
  const safeTitle = String(article.title || article.programTitle || "放送記事")
    .replace(/[\\\\/:*?"<>|]/g, "_").trim().slice(0, 100) || "放送記事";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "放送記事をHTMLで保存",
    defaultPath: safeTitle + ".html",
    filters: [{ name: "HTMLファイル", extensions: ["html"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const target = path.resolve(result.filePath);
  await fs.promises.writeFile(target, articleExport.renderArticleHtml(article), "utf8");
  return { saved: true, filePath: target };
});
ipcMain.handle("articles:generate-from-comment", (_event, value) => generateArticleFromCommentFile(value));
ipcMain.handle("articles:generate-manual", (_event, input) => generateStandaloneBroadcastArticle(input));
ipcMain.handle("articles:select-video", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "記事生成に使う動画を選択", properties: ["openFile"], filters: [{ name: "動画ファイル", extensions: ["mp4", "mkv", "webm", "mov", "m4v", "ts", "avi"] }] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  return { canceled: false, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
});
ipcMain.handle("articles:get-whisper-settings", () => {
  const settings = readAppSettings();
  return { cliPath: settings.articleWhisperCliPath || "", modelPath: settings.articleWhisperModelPath || "", managed: Boolean(settings.articleWhisperManaged) };
});
ipcMain.handle("articles:download-whisper", async () => installWhisperAutomatically());
ipcMain.handle("articles:select-whisper-cli", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "whisper-cli実行ファイルを選択", properties: ["openFile"], filters: [{ name: "実行ファイル", extensions: process.platform === "win32" ? ["exe"] : ["*"] }] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const selectedPath = result.filePaths[0];
  writeAppSettings({ articleWhisperCliPath: selectedPath });
  return { canceled: false, path: selectedPath, name: path.basename(selectedPath) };
});
ipcMain.handle("articles:select-whisper-model", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Whisper日本語モデル(ggml-*.bin)を選択", properties: ["openFile"], filters: [{ name: "Whisperモデル", extensions: ["bin"] }] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const selectedPath = result.filePaths[0];
  writeAppSettings({ articleWhisperModelPath: selectedPath });
  return { canceled: false, path: selectedPath, name: path.basename(selectedPath) };
});
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
      writeCommentLine(commentWriter, "").then(resolve, reject);
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
    await writeCommentLine(commentWriter, "");
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

app.whenReady().then(async () => {
  applyAutoLaunchSetting(getMonitorSettings().runAtStartup);
  await createSystemTray();
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
  app.on("activate", () => showMainWindow());
});

async function shutdownGracefully() {
  stopMonitor();
  closeHiddenLiveArticleCapture();
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

  // Stop and transcribe the temporary live audio stream before finalizing the article.
  try {
    await stopLiveArticleAudioCapture(currentLiveId);
  } catch (error) {
    console.error("Live article audio shutdown failed:", error);
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
  isQuitting = true;
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