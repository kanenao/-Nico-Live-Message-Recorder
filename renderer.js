const api = window.nicoAPI;
const byId = (id) => document.getElementById(id);

const liveInput = byId("live-id");
const connectButton = byId("connect-button");
const disconnectButton = byId("disconnect-button");
const recordButton = byId("record-button");
const stopRecordButton = byId("stop-record-button");
const commentList = byId("comment-list");

// Register the three primary capture controls before any optional UI startup work.
// A failure in later renderer initialization must never leave these buttons inert.
function reportCaptureButtonError(action, error) {
  const detail = action + "に失敗しました：" + (error && error.message ? error.message : String(error));
  try { setCaptureDetail(detail); } catch (_) {}
  try { showToast(detail, true); } catch (_) {}
  console.error("[capture-ui]", detail, error);
}
if (connectButton) {
  connectButton.addEventListener("click", () => {
    Promise.resolve().then(connectLive).catch((error) => reportCaptureButtonError("放送接続", error));
  });
}
if (recordButton) {
  recordButton.addEventListener("click", () => {
    Promise.resolve().then(() => startVideoRecording()).catch((error) => reportCaptureButtonError("映像・音声録画", error));
  });
}
if (disconnectButton) {
  disconnectButton.addEventListener("click", () => {
    Promise.resolve().then(disconnectLive).catch((error) => reportCaptureButtonError("コメント切断", error));
  });
}
if (stopRecordButton) {
  stopRecordButton.addEventListener("click", () => {
    Promise.resolve().then(stopVideoRecording).catch((error) => reportCaptureButtonError("録画・コメント停止", error));
  });
}

let connected = false;
let recordStartedAt = 0;
let recordClock = null;
let currentLiveId = "";
let currentProgramMetadata = {};
let currentCaptureTarget = null;
let commentCaptureState = "disconnected";
let videoCaptureState = "idle";
let captureStopInProgress = false;
let currentRecordingIsTimeshift = false;
let commentCount = 0;
let eventCount = 0;
let displayedComments = 0;
let composePreviewUrl = null;
let composePreviewSchedule = [];
let composePreviewFrame = 0;
let monitorSettings = {
  intervalSeconds: 60,
  autoRecord: true,
  autoStart: true,
  runAtStartup: true,
  closeToTray: true,
  keepAwake: true,
  quality: "best",
  commentFormat: "jsonl",
  autoUpdateStreamlink: true,
  targets: []
};
const monitorStatuses = new Map();
const liveArticlePreviews = new Map();
let liveArticlePreviewSignature = "";
let liveArticlePreviewFetchedAt = 0;
let liveArticlePreviewRequestId = 0;
const monitorHandledDetections = new Set();
let monitorIsRunning = false;
const monitorAutoQueue = [];
let monitorAutoProcessing = false;
let recordStartInProgress = false;
let captureLibraryItems = [];
const expandedLibraryBroadcasters = new Set();
const libraryThumbnailQueue = [];
let libraryThumbnailRequests = 0;
function pumpLibraryThumbnailQueue() {
  while (libraryThumbnailRequests < 2 && libraryThumbnailQueue.length) {
    const job = libraryThumbnailQueue.shift();
    libraryThumbnailRequests += 1;
    Promise.resolve().then(job).catch(error => {
      console.warn("録画動画のサムネイル取得エラー:", error);
    }).finally(() => {
      libraryThumbnailRequests -= 1;
      pumpLibraryThumbnailQueue();
    });
  }
}
function scheduleLibraryThumbnail(image, placeholder, item) {
  libraryThumbnailQueue.push(async () => {
    if (!image.isConnected) return;
    try {
      const imageUrl = await api.getLibraryThumbnail(item.path);
      if (!image.isConnected || !placeholder.isConnected) return;
      if (!String(imageUrl || "").startsWith("data:image/jpeg;base64,")) {
        placeholder.textContent = "サムネイルなし";
        return;
      }
      image.addEventListener("error", () => {
        if (!image.isConnected) return;
        image.hidden = true;
        placeholder.hidden = false;
        placeholder.textContent = "画像を表示できません";
      }, { once: true });
      image.src = imageUrl;
      image.hidden = false;
      placeholder.hidden = true;
    } catch (_) {
      if (placeholder.isConnected) placeholder.textContent = "サムネイル取得失敗";
    }
  });
  pumpLibraryThumbnailQueue();
}
function makeVideoStoryboardPanel(loadStoryboard, titleText) {
  const panel = document.createElement("section");
  panel.className = "library-video-scenes video-storyboard-panel";
  panel.hidden = true;
  let loaded = false;
  let pending = false;
  let video = null;
  let selectedSeconds = 0;
  const header = document.createElement("div");
  header.className = "video-storyboard-heading";
  const heading = document.createElement("strong");
  heading.textContent = titleText || "録画した動画の場面";
  const status = document.createElement("p");
  status.className = "library-video-scenes-status";
  status.textContent = "場面一覧を表示すると、録画映像から最大30枚を取得します。";
  header.append(heading, status);
  panel.append(header);
  const expand = async () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden || loaded || pending) return;
    pending = true;
    status.textContent = "FFmpegで録画の場面を取得中…初回は時間がかかることがあります。";
    try {
      const result = await loadStoryboard();
      if (!panel.isConnected) return;
      const frames = Array.isArray(result && result.frames) ? result.frames
        .filter(frame => frame && String(frame.imageUrl || "").startsWith("data:image/jpeg;base64,"))
        : [];
      if (!frames.length) {
        status.textContent = result && result.message || "動画の場面を取得できませんでした。";
        return;
      }
      status.textContent = (result.durationSeconds
        ? "動画時間 " + formatDuration(result.durationSeconds * 1000) + " ／ " : "") +
        frames.length + "場面" + (result.fromCache ? "（キャッシュから表示）" : "") +
        " ／ 時刻を選んで画像を確認・再生できます。";
      const layout = document.createElement("div");
      layout.className = "video-storyboard-layout";
      const selected = document.createElement("div");
      selected.className = "library-video-selected video-storyboard-selected";
      const bigImage = document.createElement("img");
      bigImage.src = frames[0].imageUrl;
      bigImage.alt = "動画の " + frames[0].label + " の場面";
      const duration = document.createElement("span");
      duration.className = "video-storyboard-duration";
      duration.textContent = result.durationSeconds
        ? formatDuration(result.durationSeconds * 1000) : "録画";
      const selectedLabel = document.createElement("span");
      selectedLabel.textContent = frames[0].label;
      selectedSeconds = Number(frames[0].seconds) || 0;
      selected.append(bigImage, duration, selectedLabel);
      const play = document.createElement("button");
      play.type = "button";
      play.className = "button button-primary button-small video-storyboard-play";
      play.textContent = "この場面から再生";
      const playbackUrl = String(result.videoUrl || "");
      play.disabled = !/^file:\/\//i.test(playbackUrl);
      play.title = play.disabled ? "録画動画がないため場面画像のみ表示します" : "";
      play.addEventListener("click", async () => {
        if (play.disabled) return;
        if (!video) {
          video = document.createElement("video");
          video.controls = true;
          video.playsInline = true;
          video.preload = "metadata";
          video.className = "video-storyboard-player";
          video.src = playbackUrl;
          video.addEventListener("loadedmetadata", () => {
            video.currentTime = Math.min(selectedSeconds, Math.max(0, video.duration - 0.15));
            void video.play().catch(() => {});
          }, { once: true });
          video.addEventListener("error", () => {
            status.textContent = "内蔵プレイヤーで再生できない形式です。録画ライブラリの「再生」から開いてください。";
            video.hidden = true;
            bigImage.hidden = false;
          });
          selected.appendChild(video);
          bigImage.hidden = true;
        } else {
          bigImage.hidden = true;
          video.hidden = false;
          video.currentTime = Math.min(selectedSeconds, Math.max(0, video.duration - 0.15));
          await video.play().catch(() => {
            status.textContent = "再生できません。録画ライブラリの「再生」から開いてください。";
          });
        }
      });
      const left = document.createElement("div");
      left.className = "video-storyboard-left";
      left.append(selected, play);
      const filmstrip = document.createElement("div");
      filmstrip.className = "library-video-filmstrip video-storyboard-grid";
      const buttons = [];
      frames.forEach((frame, index) => {
        const scene = document.createElement("button");
        scene.type = "button";
        scene.className = "library-video-scene";
        scene.title = frame.label + " の場面を表示";
        scene.setAttribute("aria-pressed", String(index === 0));
        const img = document.createElement("img");
        img.src = frame.imageUrl;
        img.loading = "lazy";
        img.alt = "動画の " + frame.label + " の場面";
        const label = document.createElement("span");
        label.textContent = frame.label;
        scene.append(img, label);
        scene.addEventListener("click", () => {
          for (const button of buttons) button.setAttribute("aria-pressed", String(button === scene));
          selectedSeconds = Number(frame.seconds) || 0;
          bigImage.src = frame.imageUrl;
          bigImage.alt = img.alt;
          selectedLabel.textContent = frame.label;
          if (video && !video.hidden && Number.isFinite(video.duration)) {
            video.currentTime = Math.min(selectedSeconds, Math.max(0, video.duration - 0.15));
          }
        });
        buttons.push(scene);
        filmstrip.appendChild(scene);
      });
      layout.append(left, filmstrip);
      panel.appendChild(layout);
      loaded = true;
    } catch (error) {
      if (panel.isConnected) status.textContent =
        "動画内の場面を読み込めませんでした：" + (error.message || String(error));
    } finally {
      pending = false;
    }
  };
  return { panel, expand };
}
function makeLibraryVideoScenesPanel(item) {
  return makeVideoStoryboardPanel(() => api.getLibraryVideoPreview(item.path),
    item.fileName + " ／ 動画の場面一覧");
}
function makeArticleVideoScenesPanel(article) {
  return makeVideoStoryboardPanel(() => api.getArticleVideoPreview(article.articlePath),
    (article.programTitle || article.title || "放送") + " ／ 場面一覧");
}

function requireCaptureApi(method) {
  if (!api || typeof api[method] !== "function") {
    throw new Error("Electron連携API「" + method + "」を利用できません。アプリを完全終了して最新版を再起動してください。");
  }
}

function setCaptureDetail(message) {
  const detail = byId("capture-status-detail");
  if (detail) detail.textContent = String(message || "");
}

// A missing or temporarily replaced view must not abort an ongoing recording.
function setCaptureText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function showToast(message, isError) {
  const toast = byId("toast");
  if (!toast) {
    console.warn("[capture-ui] 通知先がありません:", message);
    return;
  }
  toast.textContent = message;
  toast.className = "toast visible" + (isError ? " error" : "");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.className = "toast";
  }, 4200);
}

function updateCaptureIndicators() {
  const commentDot = byId("capture-comment-dot");
  const commentText = byId("capture-comment-state");
  const videoDot = byId("capture-video-dot");
  const videoText = byId("capture-video-state");
  const commentPanel = commentDot && commentDot.parentElement;
  const videoPanel = videoDot && videoDot.parentElement;

  const commentLabels = {
    connected: "取得中・自動保存中",
    connecting: "接続中…",
    error: "接続エラー",
    disconnected: "停止中"
  };
  if (commentText) commentText.textContent = commentLabels[commentCaptureState] || "状態確認中";
  if (commentDot) {
    commentDot.classList.toggle("is-active", commentCaptureState === "connected");
    commentDot.classList.toggle("is-busy", commentCaptureState === "connecting");
    commentDot.classList.toggle("is-error", commentCaptureState === "error");
  }
  if (commentPanel) {
    commentPanel.classList.toggle("is-active", commentCaptureState === "connected");
    commentPanel.classList.toggle("is-error", commentCaptureState === "error");
  }

  const videoLabels = {
    recording: "録画中・ファイルへ書き込み中",
    stopping: "停止・ファイル確定中…",
    idle: "停止中"
  };
  if (videoText) videoText.textContent = videoLabels[videoCaptureState] || "状態確認中";
  if (videoDot) {
    videoDot.classList.toggle("is-active", videoCaptureState === "recording");
    videoDot.classList.toggle("is-busy", videoCaptureState === "stopping");
    videoDot.classList.toggle("is-error", false);
  }
  if (videoPanel) videoPanel.classList.toggle("is-active", videoCaptureState === "recording");

  const detail = byId("capture-status-detail");
  if (detail) {
    const parts = [];
    const videoPath = byId("video-file")?.textContent || "";
    const commentPath = byId("comment-file")?.textContent || "";
    if (videoPath && !videoPath.includes("開始後に表示")) parts.push(videoPath);
    if (commentPath && !commentPath.includes("接続後に表示")) parts.push(commentPath);
    detail.textContent = parts.length ? parts.join(" ／ ") : "録画・コメントの開始状態をここに表示します。";
  }

  const saveStatus = byId("comment-save-status");
  if (saveStatus) {
    saveStatus.innerHTML = commentCaptureState === "connected"
      ? '<span class="dot dot-green"></span> コメント自動保存中'
      : commentCaptureState === "connecting"
        ? '<span class="dot dot-blue"></span> コメント接続中'
        : commentCaptureState === "error"
          ? '<span class="dot" style="background:#ff647d"></span> コメント取得エラー'
          : '<span class="dot"></span> コメント保存停止中';
  }
}

function setConnection(state, label) {
  const badge = byId("connection-badge");
  const text = byId("connection-label");
  if (badge) badge.classList.remove("online", "busy", "failed");
  commentCaptureState = ["connected", "connecting", "error"].includes(state) ? state : "disconnected";
  if (state === "connected") {
    if (badge) badge.classList.add("online");
    if (text) text.textContent = "コメント受信中";
    connected = true;
  } else if (state === "connecting") {
    if (badge) badge.classList.add("busy");
    if (text) text.textContent = "接続中";
    connected = false;
  } else if (state === "error") {
    if (badge) badge.classList.add("failed");
    if (text) text.textContent = "接続エラー";
    connected = false;
  } else {
    if (text) text.textContent = label || "未接続";
    connected = false;
  }
  if (connectButton) connectButton.disabled = captureStopInProgress || state === "connecting" || state === "connected";
  if (disconnectButton) disconnectButton.disabled = captureStopInProgress || (state !== "connected" && state !== "connecting");
  updateCaptureIndicators();
}

function normalizeId(value) {
  const match = String(value || "").trim().match(/(?:lv)?(\d{5,})/i);
  return match ? "lv" + match[1] : "";
}

function clearComments() {
  if (commentList) commentList.replaceChildren();
  commentCount = 0;
  eventCount = 0;
  displayedComments = 0;
  setCaptureText("comment-count", "0");
  setCaptureText("event-count", "0");
}

function eventText(record) {
  if (record.type === "comment") return record.content || "";
  if (record.type === "gift") return "ギフト：" + (record.itemName || record.message || "ギフト");
  if (record.type === "emotion") return "エモーション：" + (record.id || record.content || "受信");
  if (record.type === "operatorComment") return "運営コメント：" + (record.content || "");
  if (record.type === "notification") return "通知：" + (record.message || record.content || "通知");
  return record.content || record.message || record.itemName || record.type;
}

function eventLabel(type) {
  const labels = {
    comment: "コメント",
    gift: "ギフト",
    emotion: "エモーション",
    operatorComment: "運営",
    notification: "通知"
  };
  return labels[type] || type || "イベント";
}

function renderEvent(record) {
  if (!record) return;
  eventCount += 1;
  setCaptureText("event-count", eventCount.toLocaleString("ja-JP"));
  if (record.type === "comment") {
    commentCount += 1;
    setCaptureText("comment-count", commentCount.toLocaleString("ja-JP"));
  }

  const empty = byId("empty-state");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = "comment-row";

  const time = document.createElement("span");
  time.className = "comment-time";
  const date = new Date(record.timestamp || record.receivedAt || Date.now());
  time.textContent = Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString("ja-JP", { hour12: false });

  const user = document.createElement("span");
  user.className = "comment-user";
  user.textContent = record.userName || record.userId || record.name || "匿名";

  const body = document.createElement("span");
  body.className = "comment-body";
  body.textContent = eventText(record);
  if (record.isHistory) body.textContent = "[過去] " + body.textContent;

  const type = document.createElement("span");
  type.className = "event-tag " + (record.type === "comment" ? "tag-comment" : "tag-other");
  type.textContent = eventLabel(record.type);

  row.append(time, user, body, type);
  if (commentList) commentList.appendChild(row);
  displayedComments += 1;

  if (commentList && displayedComments > 1500 && commentList.firstElementChild) {
    commentList.firstElementChild.remove();
    displayedComments -= 1;
  }
  if (commentList) commentList.scrollTop = commentList.scrollHeight;
}

function renderSessionProgramInfo() {
  const info = currentProgramMetadata || {};
  const activeTarget = currentCaptureTarget || {};
  const title = info.title || info.programTitle || activeTarget.title || "";
  const broadcaster = info.broadcasterName || activeTarget.displayName || activeTarget.name || "";
  const liveId = currentLiveId || activeTarget.liveId || "";
  const startedAt = info.startedAt || activeTarget.startedAt || "";
  const viewerCount = info.viewerCount ?? activeTarget.viewerCount ?? activeTarget.viewers;
  const captureState = videoCaptureState === "recording"
    ? "映像・音声を録画中"
    : videoCaptureState === "stopping"
      ? "録画停止中"
      : (connected ? "コメント取得中" : (currentCaptureTarget ? "録画準備中" : "待機中"));

  // Program metadata is optional; a missing summary node must not block capture.
  const labels = {
    "session-current-title": title || (liveId ? "番組情報を取得しています…" : "放送IDを入力すると番組情報が表示されます"),
    "session-current-broadcaster": "配信者：" + (broadcaster || "未取得"),
    "session-current-live-id": "放送ID：" + (liveId || "未入力"),
    "session-current-started-at": "開始：" + (startedAt ? formatBroadcastStart(startedAt) : "未取得"),
    "session-current-viewers": "来場者：" +
      (viewerCount == null || !Number.isFinite(Number(viewerCount)) ? "未取得" : Number(viewerCount).toLocaleString("ja-JP")),
    "session-current-status": captureState
  };
  for (const [id, value] of Object.entries(labels)) {
    const element = byId(id);
    if (element) element.textContent = value;
  }
  const statusLabel = byId("session-current-status");
  if (statusLabel) statusLabel.dataset.state = videoCaptureState;
}

function updateMetadata(metadata) {
  if (!metadata) return;
  const program = metadata.program || metadata.broadcast || metadata.live || {};
  const readValue = (keys) => {
    for (const key of keys) {
      const value = metadata[key] !== undefined ? metadata[key] : program[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return "";
  };
  const provider = metadata.provider || {};
  const title = String(readValue(["title", "programTitle", "liveTitle"]) || "").trim();
  const broadcasterName = String(readValue(["broadcasterName", "providerName"]) || provider.name || "").trim();
  const broadcasterId = String(readValue(["broadcasterId", "providerId"]) || provider.id || "").trim();
  const startedAt = readValue(["startedAt", "beginTime", "startTime"]);
  const viewerCount = readValue(["visitorCount", "viewerCount", "viewers", "watchCount", "currentViewers", "totalViewers", "totalVisitors", "viewCount"]);
  currentProgramMetadata = {
    ...currentProgramMetadata,
    liveId: currentLiveId,
    title: title || currentProgramMetadata.title || "",
    programTitle: title || currentProgramMetadata.programTitle || "",
    broadcasterName: broadcasterName || currentProgramMetadata.broadcasterName || "",
    broadcasterId: broadcasterId || currentProgramMetadata.broadcasterId || "",
    startedAt: startedAt || currentProgramMetadata.startedAt || "",
    viewerCount: viewerCount !== "" ? viewerCount : currentProgramMetadata.viewerCount
  };
  if (currentCaptureTarget && currentCaptureTarget.liveId === currentLiveId) {
    currentCaptureTarget = {
      ...currentCaptureTarget,
      name: currentProgramMetadata.broadcasterName || currentCaptureTarget.name || "",
      displayName: currentProgramMetadata.broadcasterName || currentCaptureTarget.displayName || "",
      userId: currentProgramMetadata.broadcasterId || currentCaptureTarget.userId || "",
      startedAt: currentProgramMetadata.startedAt || currentCaptureTarget.startedAt || "",
      title: currentProgramMetadata.title || currentCaptureTarget.title || "",
      viewerCount: currentProgramMetadata.viewerCount ?? currentCaptureTarget.viewerCount
    };
  }
  setCaptureText("live-title", currentProgramMetadata.title || "番組タイトルを取得できませんでした");
  const status = String(readValue(["status"]) || "").trim();
  setCaptureText("live-meta", (currentProgramMetadata.broadcasterName || "放送者情報なし") +
    (status ? " ・ " + status : ""));
  renderSessionProgramInfo();
  renderLiveBroadcasts();
}

function renderAuthStatus(result) {
  const status = result || {};
  const state = ["valid", "expired", "missing", "unknown"].includes(status.state) ? status.state : "unknown";
  const name = String(status.nickname || "").slice(0, 80);
  const userLabel = name ? name + (status.userId ? "（ID: " + status.userId + "）" : "")
    : (status.userId ? "ID: " + status.userId : "ニコニコアカウント");
  const labels = { valid: "ログイン済み", expired: "セッション切れ", missing: "未ログイン", unknown: "認証確認不可" };
  const header = byId("login-state");
  header.textContent = labels[state];
  header.className = "login-state" + (state === "valid" ? " is-logged-in" : "")
    + (state === "expired" ? " is-session-expired" : "");
  header.title = state === "valid" ? "ニコニコ認証成功：" + userLabel : labels[state];
  const sessionStatus = byId("user-session-status");
  const details = {
    valid: "認証成功：" + userLabel + "。ニコニコのサーバーでログイン状態を確認しました。",
    expired: "セッションが無効または期限切れです。ニコニコにログインし直すか、新しいuser_sessionを登録してください。",
    missing: "user_sessionは未設定です。",
    unknown: "認証状態を確認できません。通信状態を確認し「認証状態を確認」を押してください。セッション切れとは断定できません。"
  };
  if (sessionStatus) {
    sessionStatus.textContent = details[state];
    sessionStatus.dataset.state = state;
  }
  const warning = byId("auth-session-warning");
  if (warning) {
    warning.hidden = state !== "expired";
    if (state === "expired") warning.textContent = details.expired;
  }
}

async function refreshAuthStatus() {
  const sessionStatus = byId("user-session-status");
  if (sessionStatus) sessionStatus.textContent = "ニコニコに認証状態を問い合わせています…";
  try {
    const status = await api.getAuthStatus();
    renderAuthStatus(status);
    return status;
  } catch (_) {
    const unknown = { state: "unknown" };
    renderAuthStatus(unknown);
    return unknown;
  }
}

async function saveUserSession() {
  const input = byId("setting-user-session");
  const button = byId("save-user-session-button");
  const value = input.value.trim();
  if (!value) {
    showToast("user_sessionの値を入力してください。", true);
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    const result = await api.setUserSession(value);
    input.value = "";
    renderAuthStatus(result);
    showToast(result.state === "valid" ? "ニコニコのログイン確認に成功しました。" :
      result.state === "expired" ? "保存しましたが、セッションは無効または期限切れです。" :
      "user_sessionを保存しました。認証結果は確認できませんでした。", result.state !== "valid");
  } catch (error) {
    showToast(error.message || "user_sessionを保存できませんでした。", true);
  } finally {
    button.disabled = false;
  }
}

async function clearUserSession() {
  if (!window.confirm("保存済みのuser_sessionを削除しますか？")) return;
  const button = byId("clear-user-session-button");
  button.disabled = true;
  try {
    const result = await api.setUserSession("");
    byId("setting-user-session").value = "";
    renderAuthStatus(result);
    showToast("user_sessionを削除しました。");
  } catch (error) {
    showToast(error.message || "user_sessionを削除できませんでした。", true);
  } finally {
    button.disabled = false;
  }
}

async function connectLive() {
  if (captureStopInProgress) return showToast("録画・コメントの停止完了後に接続してください。", true);
  const liveId = normalizeId(liveInput.value);
  if (!liveId) {
    showToast("放送IDまたは視聴URLを入力してください。", true);
    liveInput.focus();
    return;
  }

  if (currentLiveId !== liveId) currentProgramMetadata = {};
  currentLiveId = liveId;
  currentCaptureTarget = null;
  currentProgramMetadata.liveId = liveId;
  liveInput.value = liveId;
  renderSessionProgramInfo();
  clearComments();
  setConnection("connecting");
  setCaptureText("live-title", "番組情報を取得中…");
  setCaptureText("live-meta", "コメントサーバーに接続しています");
  try {
    requireCaptureApi("connectLive");
    setCaptureDetail("コメント接続要求を送信しました。ニコニコ側の応答を待っています…");
    const result = await api.connectLive(liveId);
    updateMetadata(result.metadata);
    setCaptureText("comment-file", "コメント：" + result.commentFile);
    setConnection("connected");
    setCaptureDetail("コメント保存先：" + result.commentFile);
    showToast("コメント取得を開始しました。");
  } catch (error) {
    setConnection("error");
    setCaptureDetail("コメント接続エラー：" + (error.message || String(error)));
    showToast(error.message || "コメント接続に失敗しました。", true);
  }
}

async function disconnectLive() {
  if (captureStopInProgress) return;
  try {
    requireCaptureApi("disconnectLive");
    await api.disconnectLive();
    setConnection("disconnected");
    setCaptureDetail("コメント取得を停止しました。");
    showToast("コメント取得を停止しました。");
  } catch (error) {
    setCaptureDetail("コメント切断エラー：" + (error.message || String(error)));
    showToast(error.message || "切断に失敗しました。", true);
  }
}

function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours + ":" + minutes + ":" + seconds;
}

async function startVideoRecording(target = null) {
  const selectedTarget = target && typeof target === "object" && target.liveId ? target : null;
  if (captureStopInProgress || recordStartInProgress || recordStartedAt || videoCaptureState === "recording" || videoCaptureState === "stopping" || monitorAutoProcessing) {
    showToast("別の配信を録画中、または録画準備中です。終了後に開始してください。", true);
    return;
  }
  const liveId = normalizeId(selectedTarget ? selectedTarget.liveId : (liveInput.value || currentLiveId));
  if (!liveId) {
    showToast("先に放送IDを入力してください。", true);
    return;
  }

  const timeshift = !selectedTarget && byId("record-mode")?.value === "timeshift";
  currentRecordingIsTimeshift = timeshift;
  if (stopRecordButton) stopRecordButton.textContent = timeshift ? "映像録画を停止" : "録画・コメントを停止";
  if (currentLiveId !== liveId) currentProgramMetadata = {};
  currentLiveId = liveId;
  liveInput.value = liveId;
  currentProgramMetadata = {
    ...currentProgramMetadata,
    liveId,
    title: selectedTarget && selectedTarget.title || currentProgramMetadata.title || "",
    programTitle: selectedTarget && selectedTarget.title || currentProgramMetadata.programTitle || "",
    broadcasterName: selectedTarget && selectedTarget.name || currentProgramMetadata.broadcasterName || "",
    broadcasterId: selectedTarget && (selectedTarget.broadcasterId || selectedTarget.userId) || currentProgramMetadata.broadcasterId || "",
    startedAt: selectedTarget && selectedTarget.startedAt || currentProgramMetadata.startedAt || "",
    viewerCount: selectedTarget
      ? (selectedTarget.viewerCount ?? selectedTarget.viewers ?? currentProgramMetadata.viewerCount)
      : currentProgramMetadata.viewerCount
  };
  currentCaptureTarget = timeshift ? null : {
    ...(selectedTarget || {}),
    liveId,
    isManualRecording: true,
    isAutomaticRecording: false,
    name: currentProgramMetadata.broadcasterName || "",
    title: currentProgramMetadata.title || ""
  };
  if (selectedTarget) {
    setCaptureText("live-title", selectedTarget.title || "番組情報を取得中…");
    setCaptureText("live-meta", (selectedTarget.name || "登録配信者") +
      " · " + liveId + " · LIVE一覧から録画開始");
  }
  renderSessionProgramInfo();
  recordStartInProgress = true;
  if (recordButton) recordButton.disabled = true;
  renderLiveBroadcasts();
  if (!(connected && currentLiveId === liveId)) setConnection("connecting");
  setCaptureDetail(timeshift ? "タイムシフト録画要求を送信しました。映像・音声と過去コメントの応答を待っています…" : "映像・音声＋コメント録画要求を送信しました。Streamlinkとコメントサーバーの起動を待っています…");
  try {
    requireCaptureApi(timeshift ? "startVideo" : "startCapture");
    const quality = byId("record-quality")?.value || "best";
    let result;
    if (timeshift) {
      const archive = await api.startVideo(liveId, quality, { timeshift: true });
      result = {
        video: archive,
        comment: archive.commentFile ? { commentFile: archive.commentFile } : null,
        commentCount: Number(archive.commentCount) || 0,
        commentsFetched: Boolean(archive.commentsFetched),
        commentsTruncated: Boolean(archive.commentsTruncated),
        commentError: archive.commentError || ""
      };
    } else {
      result = await api.startCapture(liveId, quality, {
        displayName: selectedTarget && selectedTarget.name || currentProgramMetadata.broadcasterName || "",
        broadcasterId: selectedTarget && (selectedTarget.broadcasterId || selectedTarget.userId) || currentProgramMetadata.broadcasterId || "",
        programTitle: selectedTarget && selectedTarget.title || currentProgramMetadata.programTitle || currentProgramMetadata.title || "",
        description: selectedTarget && selectedTarget.description || currentProgramMetadata.description || "",
        startedAt: selectedTarget && selectedTarget.startedAt || currentProgramMetadata.startedAt || ""
      });
    }
    if (result.comment && result.comment.metadata) updateMetadata(result.comment.metadata);
    if (result.comment && result.comment.commentFile) {
      setCaptureText("comment-file", "コメント：" + result.comment.commentFile);
    }
    if (result.commentsConnected) {
      setConnection("connected");
    } else if (result.commentPending && !timeshift) {
      setConnection("connecting");
    } else if (!timeshift) {
      setConnection("error");
    }

    const video = result.video || {};
    setCaptureText("video-file", "保存先：" + (video.path || ""));
    setCaptureDetail("録画開始を確認しました。映像保存先：" + (video.path || "未取得") +
      (result.comment && result.comment.commentFile ? " ／ コメント保存先：" + result.comment.commentFile : "") +
      (result.commentPending ? " ／ コメント接続を継続中…" : ""));
    // A long archive-comment fetch may outlive the timeshift video itself.
    // Do not overwrite a completed video:state event when the IPC finally returns.
    if (!timeshift || videoCaptureState === "recording") {
      recordStartedAt = video.startedAt ? new Date(video.startedAt).getTime() : Date.now();
      setVideoState(true);
      startRecordClock();
    }
    if (timeshift && result.commentCount > 0) {
      showToast("タイムシフトの映像・音声録画と過去コメント " +
        result.commentCount.toLocaleString("ja-JP") + "件の保存を開始しました。");
      if (result.commentsTruncated) {
        showToast("過去コメントは取得上限に達したため一部のみ保存しました。", true);
      }
    } else if (timeshift && result.commentError) {
      showToast("映像録画は開始しましたが、過去コメントを取得できませんでした: " + result.commentError, true);
    } else if (timeshift) {
      showToast("タイムシフトの映像・音声録画を開始しました。過去コメントは見つかりませんでした。", true);
    } else if (result.commentPending) {
      showToast("映像・音声録画を開始しました。コメント接続を継続しています。");
    } else if (result.commentError) {
      showToast("映像録画は開始しましたが、コメント取得に失敗しました: " + result.commentError, true);
    } else {
      showToast("映像録画とコメント取得を同時に開始しました。");
    }
  } catch (error) {
    currentCaptureTarget = null;
    currentRecordingIsTimeshift = false;
    renderSessionProgramInfo();
    setVideoState(false);
    if (!connected) setConnection("error");
    setCaptureDetail("録画開始エラー：" + (error.message || String(error)));
    showToast(error.message || "録画・コメントの同時開始に失敗しました。", true);
  } finally {
    recordStartInProgress = false;
    if (recordButton) recordButton.disabled = captureStopInProgress || videoCaptureState === "recording" || videoCaptureState === "stopping" || monitorAutoProcessing;
    renderLiveBroadcasts();
  }
  processMonitorAutoQueue();
}

function startRecordClock() {
  if (recordClock) return;
  if (!recordStartedAt) recordStartedAt = Date.now();
  recordClock = window.setInterval(() => {
    setCaptureText("record-timer", formatDuration(Date.now() - recordStartedAt));
  }, 500);
}

function clearRecordClock() {
  if (recordClock) window.clearInterval(recordClock);
  recordClock = null;
  recordStartedAt = 0;
  setCaptureText("record-timer", "00:00:00");
}

function setVideoState(recording, stopping = false) {
  videoCaptureState = stopping ? "stopping" : (recording ? "recording" : "idle");
  renderSessionProgramInfo();
  const recordIndicator = byId("record-indicator");
  if (recordIndicator) recordIndicator.classList.toggle("recording", recording);
  setCaptureText("record-status", stopping
    ? "録画停止中…"
    : recording ? "録画中（直接取得）" : "録画していません");
  if (recordButton) recordButton.disabled = captureStopInProgress || recording || stopping;
  if (stopRecordButton) stopRecordButton.disabled = captureStopInProgress || !recording || stopping;
  updateCaptureIndicators();
  renderDashboardStats();
  renderLiveBroadcasts();
}

async function stopVideoRecording() {
  if (captureStopInProgress || (stopRecordButton && stopRecordButton.disabled)) return;
  const timeshift = currentRecordingIsTimeshift;
  captureStopInProgress = true;
  setVideoState(true, true);
  setCaptureDetail(timeshift
    ? "タイムシフト映像を停止・保存中です…"
    : "録画ファイルを確定してからコメント接続と保存処理を停止します…");
  try {
    requireCaptureApi(timeshift ? "stopVideo" : "stopCapture");
    const result = timeshift ? await api.stopVideo() : await api.stopCapture();
    const video = timeshift ? result : (result.video || {});
    if (video.path) setCaptureText("video-file", "映像：" + video.path);
    if (!timeshift) {
      if (result.comment && result.comment.commentFile) {
        setCaptureText("comment-file", "コメント：" + result.comment.commentFile);
      }
      setConnection("disconnected");
      setCaptureDetail("映像・音声録画とコメントを停止・保存しました。");
      showToast("映像・音声録画とコメント取得を同時に停止しました。");
    }
  } catch (error) {
    setCaptureDetail("録画・コメント停止エラー：" + (error.message || String(error)));
    showToast(error.message || "録画・コメントを停止できませんでした。", true);
  } finally {
    captureStopInProgress = false;
    setVideoState(Boolean(recordStartedAt));
    setConnection(commentCaptureState);
    if (!recordStartedAt) processMonitorAutoQueue();
  }
}

function renderLivePreviewState(payload) {
  if (!payload) return;
  const status = byId("live-preview-status");
  const openButton = byId("live-preview-open-button");
  const closeButton = byId("live-preview-close-button");
  switch (payload.state) {
    case "opening":
      status.textContent = "映像プレビューを開いています…";
      openButton.disabled = true;
      closeButton.disabled = false;
      break;
    case "opened":
      status.textContent = "視聴ページを別ウィンドウで表示中（" + (payload.liveId || "") + "）";
      openButton.disabled = false;
      closeButton.disabled = false;
      break;
    case "closed":
      status.textContent = "映像プレビューは閉じています。録画は継続します。";
      openButton.disabled = false;
      closeButton.disabled = true;
      break;
    case "error":
      status.textContent = "映像プレビューを開けませんでした：" + (payload.message || "ページを読み込めません。");
      openButton.disabled = false;
      closeButton.disabled = true;
      break;
    default:
      status.textContent = "見たいときだけ別ウィンドウで映像プレビューを開けます。";
      openButton.disabled = false;
      closeButton.disabled = true;
  }
}

async function openLivePreview() {
  const liveId = normalizeId(liveInput.value || currentLiveId);
  if (!liveId) {
    showToast("先に放送IDまたは視聴URLを入力してください。", true);
    return;
  }
  const button = byId("live-preview-open-button");
  button.disabled = true;
  try {
    await api.openLivePreview(liveId);
  } catch (error) {
    renderLivePreviewState({ state: "error", message: error.message || String(error) });
    showToast(error.message || "映像プレビューを開けませんでした。", true);
  } finally {
    button.disabled = false;
  }
}

async function closeLivePreview() {
  const button = byId("live-preview-close-button");
  button.disabled = true;
  try {
    await api.closeLivePreview();
  } catch (error) {
    showToast(error.message || "映像プレビューを閉じられませんでした。", true);
  }
}

function handleVideoState(payload) {
  if (!payload) return;
  if (payload.recording) {
    if (payload.path) setCaptureText("video-file", "映像：" + payload.path);
    recordStartedAt = payload.startedAt ? new Date(payload.startedAt).getTime() : (recordStartedAt || Date.now());
    setVideoState(true);
    startRecordClock();
    return;
  }

  if (payload.path) {
    setCaptureText("video-file", "映像：" + payload.path);
    showToast(payload.converted
      ? "録画を保存しました（MP4変換済み）: " + payload.path
      : "録画を保存しました（TS形式）: " + payload.path);
  } else if (payload.exitCode !== undefined) {
    showToast("録画データがありません。配信の状態と視聴権限を確認してください。", true);
  }
  clearRecordClock();
  currentCaptureTarget = null;
  currentRecordingIsTimeshift = false;
  renderSessionProgramInfo();
  setVideoState(false);
  if (!captureStopInProgress) processMonitorAutoQueue();
}

async function refreshVideoTools() {
  try {
    const status = await api.getVideoToolStatus();
    const streamlinkLabel = byId("streamlink-status");
    const ffmpegLabel = byId("ffmpeg-status");
    streamlinkLabel.textContent = status.streamlinkBundled
      ? "Streamlink：" + (status.streamlinkVersion || "同梱版") + (status.streamlinkManaged ? "（自動更新版）" : "（公式同梱版）")
      : status.streamlinkAvailable
        ? "Streamlink：PC内のインストール済み版を使用"
        : "Streamlink：見つかりません（アプリを再インストールしてください）";
    ffmpegLabel.textContent = status.ffmpegBundled
      ? "FFmpeg：同梱済み（MP4変換可能）"
      : status.ffmpegAvailable
        ? "FFmpeg：PC内のインストール済み版を使用"
        : "FFmpeg：未検出（録画はTS形式）";
  } catch (_) {
    byId("streamlink-status").textContent = "Streamlink：状態を確認できません";
    byId("ffmpeg-status").textContent = "FFmpeg：状態を確認できません";
  }
}


function parseBroadcastTimestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const isEpoch = raw.length >= 10 && raw.length <= 13 &&
    Array.from(raw).every(character => character >= "0" && character <= "9");
  if (isEpoch) {
    const numeric = Number(raw);
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBroadcastStart(value) {
  const timestamp = parseBroadcastTimestamp(value);
  if (!timestamp) return "開始時刻未取得";
  return new Date(timestamp).toLocaleString("ja-JP", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
}

function formatBroadcastElapsed(value) {
  const timestamp = parseBroadcastTimestamp(value);
  if (!timestamp) return "経過時間未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return "経過 " + [hours, minutes, remainder].map(part => String(part).padStart(2, "0")).join(":");
}

function getLiveBroadcastItems() {
  const byLiveId = new Map();
  const targets = Array.isArray(monitorSettings.targets) ? monitorSettings.targets : [];
  for (const target of targets) {
    const status = monitorStatuses.get(target.userId);
    if (!status || !status.isLive || status.error || !status.liveId) continue;
    byLiveId.set(status.liveId, { ...status, isRecording: false });
  }
  const activeCapture = currentCaptureTarget && currentCaptureTarget.liveId &&
    (recordStartInProgress || Boolean(recordStartedAt) ||
      videoCaptureState === "recording" || videoCaptureState === "stopping" || monitorAutoProcessing);
  if (activeCapture) {
    const capture = currentCaptureTarget;
    const liveId = capture.liveId;
    const existing = byLiveId.get(liveId) || {};
    const name = currentProgramMetadata.broadcasterName ||
      capture.displayName || capture.name || existing.name || "";
    const title = currentProgramMetadata.title ||
      capture.title || existing.title || "";
    byLiveId.set(liveId, {
      ...existing,
      ...capture,
      liveId,
      userId: capture.userId || capture.broadcasterId || existing.userId || "",
      name: name || "手動録画中の配信",
      title: title || "番組タイトルを取得中…",
      startedAt: currentProgramMetadata.startedAt || capture.startedAt || existing.startedAt || "",
      isLive: true,
      isRecording: true,
      isAutomaticRecording: Boolean(capture.isAutomaticRecording),
      isFollowerOnly: Boolean(capture.isFollowerOnly),
      detectionSource: capture.isAutomaticRecording ? "自動録画中" : "手動録画中"
    });
  }
  return Array.from(byLiveId.values())
    .sort((a, b) => parseBroadcastTimestamp(b.startedAt) - parseBroadcastTimestamp(a.startedAt));
}

// Load only articles for LIVE IDs. The reply has no embedded JPEGs, transcripts,
// or full article bodies, so a monitor heartbeat stays lightweight.
async function refreshLiveArticlePreviews(force = false) {
  if (!api || typeof api.getLiveArticlePreviews !== "function") return;
  const ids = [...new Set(getLiveBroadcastItems()
    .map(item => String(item.liveId || "").trim().toLowerCase())
    .filter(id => /^lv\d{5,}$/.test(id)))].slice(0, 100);
  const signature = ids.slice().sort().join(",");
  if (!ids.length) {
    liveArticlePreviewRequestId += 1;
    liveArticlePreviewSignature = "";
    liveArticlePreviewFetchedAt = 0;
    if (liveArticlePreviews.size) {
      liveArticlePreviews.clear();
      renderLiveBroadcasts();
    }
    return;
  }
  if (!force && signature === liveArticlePreviewSignature &&
      Date.now() - liveArticlePreviewFetchedAt < 45 * 1000) return;
  liveArticlePreviewSignature = signature;
  liveArticlePreviewFetchedAt = Date.now();
  const requestId = ++liveArticlePreviewRequestId;
  try {
    const result = await api.getLiveArticlePreviews(ids);
    if (requestId !== liveArticlePreviewRequestId) return;
    liveArticlePreviews.clear();
    for (const preview of Array.isArray(result && result.items) ? result.items : []) {
      if (preview && ids.includes(preview.liveId)) liveArticlePreviews.set(preview.liveId, preview);
    }
    renderLiveBroadcasts();
  } catch (error) {
    if (requestId !== liveArticlePreviewRequestId) return;
    liveArticlePreviewFetchedAt = 0;
    console.warn("LIVE AI article previews unavailable:", error);
  }
}

function openLiveArticleFromDashboard(status, hasArticle) {
  if (!hasArticle) {
    byId("manual-article-live-id").value = status.liveId || "";
    byId("manual-article-broadcaster").value = status.name || "";
    byId("manual-article-title").value = status.title || "";
    byId("manual-article-description").value = status.description || "";
  }
  byId("articles-search").value = hasArticle ? status.liveId : "";
  setActivePage("articles");
  if (hasArticle) {
    // Skip the large article-generation form and show the selected article.
    window.requestAnimationFrame(() => {
      byId("articles-list")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }
}

function renderDashboardStats() {
  const targets = Array.isArray(monitorSettings.targets) ? monitorSettings.targets : [];
  const liveCount = getLiveBroadcastItems().length;
  byId("dashboard-target-count").textContent = String(targets.length).padStart(2, "0");
  byId("dashboard-live-count").textContent = String(liveCount).padStart(2, "0");
  byId("dashboard-recording-count").textContent = videoCaptureState === "recording" ? "01" : "00";
  byId("dashboard-monitor-status").textContent = monitorIsRunning ? "監視中" : "停止中";
  byId("live-broadcast-count").textContent = String(liveCount);
}

function updateLiveElapsedLabels() {
  document.querySelectorAll(".live-broadcast-elapsed").forEach(element => {
    element.textContent = formatBroadcastElapsed(element.dataset.startedAt || "");
  });
}

function renderLiveBroadcasts() {
  const list = byId("live-broadcast-list");
  if (!list) return;
  list.replaceChildren();
  const liveItems = getLiveBroadcastItems();

  if (!liveItems.length) {
    const empty = document.createElement("div");
    empty.className = "live-broadcast-empty";
    empty.textContent = monitorIsRunning
      ? "現在、登録した配信者のLIVEは検知されていません。監視は継続中です。"
      : "監視を開始すると、登録した配信者のLIVE情報がここに表示されます。";
    list.appendChild(empty);
    renderDashboardStats();
    return;
  }

  for (const status of liveItems) {
    const card = document.createElement("article");
    card.className = "live-broadcast-card";

    const top = document.createElement("div");
    top.className = "live-broadcast-top";
    const liveBadge = document.createElement("span");
    liveBadge.className = "live-broadcast-badge";
    liveBadge.textContent = status.isRecording ? "● REC中" : "● LIVE";
    const start = document.createElement("span");
    start.className = "live-broadcast-start";
    start.textContent = "開始 " + formatBroadcastStart(status.startedAt);
    top.append(liveBadge, start);

    const broadcaster = document.createElement("strong");
    broadcaster.className = "live-broadcast-name";
    broadcaster.textContent = status.name || ("ユーザー " + status.userId);

    const title = document.createElement("p");
    title.className = "live-broadcast-title";
    title.textContent = status.title || "配信タイトルを取得できませんでした";

    const meta = document.createElement("div");
    meta.className = "live-broadcast-meta";
    const liveId = document.createElement("span");
    liveId.textContent = status.liveId || "";
    const elapsed = document.createElement("span");
    elapsed.className = "live-broadcast-elapsed";
    elapsed.dataset.startedAt = status.startedAt || "";
    elapsed.textContent = formatBroadcastElapsed(status.startedAt);
    meta.append(liveId, elapsed);

    const footer = document.createElement("div");
    footer.className = "live-broadcast-footer";
    const source = document.createElement("span");
    source.textContent = status.isRecording
      ? (status.isAutomaticRecording ? "自動録画中" : "手動録画中")
      : (status.isFollowerOnly ? "フォロー限定 · " : "") + (status.detectionSource || "配信監視");
    const actions = document.createElement("div");
    actions.className = "live-broadcast-actions";

    const record = document.createElement("button");
    record.type = "button";
    record.className = "button button-primary button-small live-broadcast-record-button";
    const recordingBusy = !status.isRecording && (recordStartInProgress || Boolean(recordStartedAt) ||
      videoCaptureState === "recording" || videoCaptureState === "stopping" || monitorAutoProcessing);
    record.disabled = Boolean(status.isRecording) || recordingBusy;
    record.textContent = status.isRecording
      ? "録画中" : videoCaptureState === "stopping"
        ? "停止中…" : recordingBusy ? "録画準備中…" : "録画開始";
    record.title = status.isRecording
      ? "この配信は現在録画中です。"
      : recordingBusy
        ? "現在の録画が終了してから開始できます。"
        : "この配信の映像・音声とコメントを同時に保存します。";
    record.addEventListener("click", () => startVideoRecording({
      liveId: status.liveId,
      title: status.title,
      name: status.name,
      userId: status.userId
    }));

    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "button button-quiet button-small";
    watch.textContent = "視聴ページを開く";
    watch.addEventListener("click", async () => {
      try {
        await api.openWatch(status.liveId);
      } catch (error) {
        showToast(error.message || "視聴ページを開けませんでした。", true);
      }
    });
    actions.append(record, watch);
    footer.append(source, actions);

    const articlePreview = document.createElement("section");
    articlePreview.className = "live-broadcast-ai-article";
    const articleHeader = document.createElement("div");
    articleHeader.className = "live-broadcast-article-header";
    const articleLabel = document.createElement("strong");
    articleLabel.textContent = "AI放送記事";
    const preview = liveArticlePreviews.get(String(status.liveId || "").toLowerCase());
    const articleType = document.createElement("span");
    articleType.textContent = preview
      ? (preview.aiProvider ? "Ollama記事" : "記事保存済み・AI未生成")
      : (status.isRecording ? "記事を作成中" : "記事未作成");
    articleHeader.append(articleLabel, articleType);
    articlePreview.appendChild(articleHeader);

    const articleTitle = document.createElement("strong");
    articleTitle.className = "live-broadcast-article-title";
    articleTitle.textContent = preview
      ? (preview.title || "放送記事")
      : (status.isRecording
        ? "コメントの受信・記事生成を準備しています…"
        : "この放送のAI記事はまだありません");
    articlePreview.appendChild(articleTitle);
    const articleSummary = document.createElement("p");
    articleSummary.className = "live-broadcast-article-summary";
    articleSummary.textContent = preview
      ? (preview.summary || "記事本文は記事一覧から確認できます。")
      : (status.isRecording
        ? "記事が保存されると、見出し・要約が自動的に表示されます。"
        : "記事生成画面から生放送の映像・音声・コメントを分析できます。");
    articlePreview.appendChild(articleSummary);
    const articleFooter = document.createElement("div");
    articleFooter.className = "live-broadcast-article-footer";
    const articleMeta = document.createElement("span");
    articleMeta.className = "live-broadcast-article-meta";
    articleMeta.textContent = preview
      ? "コメント " + (Number(preview.commentCount) || 0).toLocaleString("ja-JP") + "件" +
        (preview.videoFrameCount ? " · 映像 " + preview.videoFrameCount + "枚" : "") +
        (preview.hasAudio ? " · 音声解析あり" : "") +
        (preview.generatedAt ? " · 更新 " + new Date(preview.generatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "")
      : "配信ID：" + (status.liveId || "未取得");
    const articleButton = document.createElement("button");
    articleButton.type = "button";
    articleButton.className = "button button-outline button-small live-broadcast-article-button";
    articleButton.textContent = preview ? "記事を読む" : "記事を作成";
    articleButton.addEventListener("click", () => openLiveArticleFromDashboard(status, Boolean(preview)));
    articleFooter.append(articleMeta, articleButton);
    articlePreview.appendChild(articleFooter);

    card.append(top, broadcaster, title, meta, articlePreview, footer);
    list.appendChild(card);
  }
  renderDashboardStats();
}

function renderMonitorState(payload) {
  if (!payload) return;
  const state = byId("monitor-state");
  const startButton = byId("monitor-start-button");
  const stopButton = byId("monitor-stop-button");
  const running = Boolean(payload.running);
  monitorIsRunning = running;
  state.textContent = payload.state === "checking"
    ? "配信状況を確認中…"
    : running ? "監視中" : "監視停止中";
  state.classList.toggle("is-running", running);
  startButton.disabled = running;
  stopButton.disabled = !running;
  if (payload.checkedAt || payload.lastCheckAt) {
    const date = new Date(payload.checkedAt || payload.lastCheckAt);
    if (!Number.isNaN(date.getTime())) {
      byId("monitor-last-check").textContent =
        "最終確認：" + date.toLocaleTimeString("ja-JP", { hour12: false });
    }
  }
  if (payload.settings) {
    monitorSettings = payload.settings;
    renderMonitorTargets();
  }
  renderLiveBroadcasts();
  renderDashboardStats();
}

function renderMonitorTargets() {
  const list = byId("monitor-target-list");
  list.replaceChildren();
  const targets = Array.isArray(monitorSettings.targets) ? monitorSettings.targets : [];
  byId("monitor-count").textContent = String(targets.length);

  if (!targets.length) {
    const empty = document.createElement("div");
    empty.className = "monitor-empty";
    empty.textContent = "監視対象がまだ登録されていません。";
    list.appendChild(empty);
    renderLiveBroadcasts();
    renderDashboardStats();
    return;
  }

  for (const target of targets) {
    const status = monitorStatuses.get(target.userId);
    const row = document.createElement("div");
    row.className = "monitor-target-row";

    const main = document.createElement("div");
    main.className = "monitor-target-main";
    const name = document.createElement("strong");
    name.textContent = target.name || ("ユーザー " + target.userId);
    const id = document.createElement("span");
    id.textContent = "user/" + target.userId;
    const detail = document.createElement("small");
    detail.className = "monitor-target-detail";
    detail.textContent = status && status.isLive
      ? (status.title || "番組タイトル未取得") + " · 開始 " + formatBroadcastStart(status.startedAt)
      : status && status.error ? status.error : (status && status.checkedAt ? "現在オフライン" : "配信状況を確認すると詳細を表示します");
    main.append(name, id, detail);

    const statusLabel = document.createElement("span");
    statusLabel.className = "monitor-target-status";
    if (status && status.error) {
      statusLabel.classList.add("is-error");
      statusLabel.textContent = "確認エラー";
      statusLabel.title = status.error;
    } else if (status && status.isLive) {
      statusLabel.classList.add("is-live");
      statusLabel.textContent = "● 放送中：" + (status.liveId || "") +
        (status.isFollowerOnly ? " · フォロー限定" : "");
      statusLabel.title = (status.title || "") +
        (status.detectionSource ? " / 検知元：" + status.detectionSource : "");
    } else if (status && status.checkedAt) {
      statusLabel.textContent = "待機中";
    } else {
      statusLabel.textContent = "未確認";
    }

    const actions = document.createElement("div");
    actions.className = "monitor-target-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-quiet button-small";
    remove.textContent = "削除";
    remove.addEventListener("click", async () => {
      try {
        const result = await api.removeMonitorTarget(target.userId);
        applyMonitorState(result);
        monitorStatuses.delete(target.userId);
        renderMonitorTargets();
        showToast("監視リストから削除しました。");
      } catch (error) {
        showToast(error.message || "監視対象を削除できませんでした。", true);
      }
    });
    actions.appendChild(remove);
    row.append(main, statusLabel, actions);
    list.appendChild(row);
  }
  renderLiveBroadcasts();
  renderDashboardStats();
}

const ASS_MOTION_FIELDS = [
  ["assScrollSpeed", "scroll-speed", " px/秒"],
  ["assEntryOffset", "entry-offset", " px"],
  ["assScrollLanes", "scroll-lanes", " 行"],
  ["assFixedDuration", "fixed-duration", " 秒"]
];

function refreshAssMotionLabels(prefix) {
  const autoEnabled = byId(prefix + "auto-motion").checked;
  for (const [, id, unit] of ASS_MOTION_FIELDS) {
    const input = byId(prefix + id);
    const output = byId(prefix + id + "-value");
    if (input) input.disabled = autoEnabled;
    if (input && output) output.textContent = input.value + unit;
  }
  byId(prefix + "prevent-overlap").disabled = autoEnabled;
}

function readAssMotionInputs(prefix) {
  const settings = {};
  for (const [property, id] of ASS_MOTION_FIELDS) {
    settings[property] = Number(byId(prefix + id).value);
  }
  settings.assAutoMotion = byId(prefix + "auto-motion").checked;
  settings.assPreventOverlap = byId(prefix + "prevent-overlap").checked;
  return settings;
}

function applyAssMotionInputs(prefix, values, skipFocused = false) {
  const defaults = {
    assScrollSpeed: 360, assEntryOffset: 0,
    assScrollLanes: 18, assFixedDuration: 5
  };
  for (const [property, id] of ASS_MOTION_FIELDS) {
    const input = byId(prefix + id);
    if (input && (!skipFocused || document.activeElement !== input)) {
      input.value = String(values[property] ?? defaults[property]);
    }
  }
  const auto = byId(prefix + "auto-motion");
  if (auto && (!skipFocused || document.activeElement !== auto)) {
    auto.checked = values.assAutoMotion !== false;
  }
  const overlap = byId(prefix + "prevent-overlap");
  if (overlap && (!skipFocused || document.activeElement !== overlap)) {
    overlap.checked = values.assPreventOverlap !== false;
  }
  refreshAssMotionLabels(prefix);
}

function applyMonitorState(result) {
  if (!result) return;
  if (result.settings) {
    monitorSettings = result.settings;
    const ngEditor = byId("ass-ng-regex");
    if (ngEditor && document.activeElement !== ngEditor) ngEditor.value = monitorSettings.assNgRegex || "";
    applyAssMotionInputs("ass-", monitorSettings, true);
  }
  if (result.statuses && typeof result.statuses === "object") {
    for (const [userId, status] of Object.entries(result.statuses)) {
      monitorStatuses.set(userId, status);
    }
  }
  renderMonitorState(result);
  renderMonitorTargets();
  if (Array.isArray(result.pendingDetections)) {
    result.pendingDetections.forEach(handleMonitorLiveDetected);
  }
  void refreshLiveArticlePreviews();
}

function addMonitorActivity(message, kind = "") {
  const activity = byId("monitor-activity");
  const line = document.createElement("span");
  line.textContent = "[" + new Date().toLocaleTimeString("ja-JP", { hour12: false }) + "] " + message;
  if (kind === "live") line.className = "monitor-log-live";
  if (kind === "error") line.className = "monitor-log-error";
  activity.prepend(line);
  while (activity.children.length > 10) activity.lastElementChild.remove();
}

async function refreshMonitorState() {
  try {
    applyMonitorState(await api.getMonitorState());
  } catch (error) {
    addMonitorActivity(error.message || "監視状態を取得できませんでした。", "error");
  }
}

async function addMonitorTarget() {
  const userId = byId("monitor-user-id").value.trim();
  const name = byId("monitor-display-name").value.trim();
  try {
    const result = await api.addMonitorTarget({ userId, name });
    applyMonitorState(result);
    byId("monitor-user-id").value = "";
    byId("monitor-display-name").value = "";
    addMonitorActivity((name || userId) + " を監視リストに追加しました。");
    showToast("監視対象を追加しました。");
  } catch (error) {
    showToast(error.message || "監視対象を追加できませんでした。", true);
  }
}

async function startMonitor() {
  const button = byId("monitor-start-button");
  button.disabled = true;
  try {
    applyMonitorState(await api.startMonitor());
    addMonitorActivity("配信監視を開始しました。");
    showToast("配信監視を開始しました。");
  } catch (error) {
    button.disabled = false;
    showToast(error.message || "監視を開始できませんでした。", true);
  }
}

async function stopMonitor() {
  try {
    applyMonitorState(await api.stopMonitor());
    addMonitorActivity("配信監視を停止しました。");
    showToast("配信監視を停止しました。");
  } catch (error) {
    showToast(error.message || "監視を停止できませんでした。", true);
  }
}

function getCompositionEditorOptions() {
  const number = (id, fallback, min, max) => {
    const value = Number(byId(id).value);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  return {
    fontScale: number("compose-font-scale", 100, 50, 200) / 100,
    baseFontSize: number("compose-font-size", 64, 18, 96),
    speed: number("compose-speed", 100, 30, 250) / 100,
    scrollSpeedPxPerSecond: number("compose-pixels-per-second", 330, 80, 1000),
    overlapProtection: byId("compose-overlap-protection").checked,
    laneGapMs: number("compose-lane-gap", 80, 0, 500),
    marginPercent: number("compose-position", 7, 4, 25),
    offsetMs: number("compose-offset", 0, -10000, 10000),
    opacity: number("compose-opacity", 100, 20, 100) / 100,
    displayMode: byId("compose-display-mode").value,
    colorMode: byId("compose-color-mode").value,
    resolution: byId("compose-resolution").value,
    fps: number("compose-fps", 30, 30, 60),
    bitrate: number("compose-bitrate", 6000000, 1000000, 20000000),
    rowLimit: number("compose-row-limit", 12, 1, 24),
    durationSeconds: byId("compose-duration").value === "auto" ? 0 : number("compose-duration", 5, 1, 30),
    outlineWidth: number("compose-outline", 4, 0, 12),
    fontFamily: byId("compose-font-family").value,
    ngWords: String(byId("compose-ng-words").value || "").split(/\r?\n/).map((word) => word.trim().toLocaleLowerCase("ja-JP")).filter(Boolean),
    outputWidth: number("compose-width", 0, 0, 7680),
    outputHeight: number("compose-height", 0, 0, 4320),
    keepAspect: byId("compose-keep-aspect").checked,
    outputFormat: byId("compose-output-format").value,
    outputQuality: byId("compose-output-quality").value,
    shadow: byId("compose-shadow").checked
  };
}

function applyNicoCommentPreset() {
  const values = {
    "compose-font-scale": 100,
    "compose-font-size": 75,
    "compose-speed": 100,
    "compose-pixels-per-second": 450,
    "compose-row-limit": 12,
    "compose-lane-gap": 80,
    "compose-duration": "auto",
    "compose-display-mode": "all",
    "compose-font-family": "ＭＳ Ｐゴシック",
    "compose-color-mode": "original",
    "compose-position": 7,
    "compose-opacity": 100,
    "compose-outline": 5
  };
  for (const [id, value] of Object.entries(values)) {
    const input = byId(id);
    if (!input) continue;
    input.value = String(value);
    input.dispatchEvent(new Event(input.type === "range" ? "input" : "change", { bubbles: true }));
  }
  byId("compose-overlap-protection").checked = true;
  byId("compose-shadow").checked = true;
  byId("compose-overlap-protection").dispatchEvent(new Event("change", { bubbles: true }));
  byId("compose-shadow").dispatchEvent(new Event("change", { bubbles: true }));
  updateCompositionEditorLabels();
  drawComposePreviewFrame();
  setComposePreviewStatus("ニコ生標準プリセットを適用しました");
  showToast("ニコ生風の標準コメント設定にしました。");
}

function updateCompositionEditorLabels() {
  for (const [inputId, outputId, suffix] of [
    ["compose-font-scale", "compose-font-value", "%"],
    ["compose-speed", "compose-speed-value", "%"],
    ["compose-position", "compose-position-value", "%"],
    ["compose-opacity", "compose-opacity-value", "%"],
    ["compose-font-size", "compose-font-size-value", " px"],
    ["compose-lane-gap", "compose-lane-gap-value", " ms"]
  ]) {
    const input = byId(inputId);
    const output = byId(outputId);
    if (input && output) output.textContent = input.value + suffix;
  }
  const outline = byId("compose-outline");
  const outlineOutput = byId("compose-outline-value");
  if (outline && outlineOutput) outlineOutput.textContent = outline.value + " px";
  const offset = byId("compose-offset");
  const offsetOutput = byId("compose-offset-value");
  if (offset && offsetOutput) {
    const value = Number(offset.value) || 0;
    offsetOutput.textContent = (value > 0 ? "+" : "") + value + " ms";
  }
}

async function checkOllamaStatus() {
  const badge = byId("ollama-status-badge");
  const message = byId("ollama-status-message");
  const button = byId("ollama-check-button");
  if (badge) { badge.textContent = "確認中…"; badge.dataset.state = "checking"; }
  if (message) message.textContent = "Ollamaへ接続しています…";
  if (button) button.disabled = true;
  try {
    const status = await api.getOllamaStatus();
    if (badge) {
      badge.textContent = status.connected ? "接続済み" : "未接続";
      badge.dataset.state = status.connected ? "downloaded" : "error";
    }
    if (message) {
      message.textContent = status.connected
        ? "接続先：" + status.baseUrl + " ／ インストール済みモデル：" + (status.models.length ? status.models.map(item => item.name).join("、") : "なし")
        : (status.message || "Ollamaに接続できません。");
    }
  } catch (error) {
    if (badge) { badge.textContent = "未接続"; badge.dataset.state = "error"; }
    if (message) message.textContent = error.message || "Ollamaに接続できません。";
  } finally {
    if (button) button.disabled = false;
  }
}

function openSettings() {
  byId("setting-monitor-interval").value = String(monitorSettings.intervalSeconds || 10);
  byId("setting-monitor-quality").value = monitorSettings.quality === "worst" ? "worst" : "best";
  byId("setting-comment-format").value = ["jsonl", "csv", "ass", "all"].includes(monitorSettings.commentFormat) ? monitorSettings.commentFormat : "jsonl";
  byId("setting-ass-ng-regex").value = monitorSettings.assNgRegex || "";
  applyAssMotionInputs("setting-ass-", monitorSettings);
  byId("setting-auto-record").checked = monitorSettings.autoRecord !== false;
  byId("setting-auto-start").checked = monitorSettings.autoStart !== false;
  byId("setting-run-at-startup").checked = monitorSettings.runAtStartup !== false;
  byId("setting-close-to-tray").checked = monitorSettings.closeToTray !== false;
  byId("setting-keep-awake").checked = monitorSettings.keepAwake !== false;
  byId("setting-auto-update-streamlink").checked = monitorSettings.autoUpdateStreamlink !== false;
  byId("setting-notify-on-live").checked = monitorSettings.notifyOnLive !== false;
  byId("setting-ai-article-enabled").checked = monitorSettings.aiArticleEnabled !== false;
  byId("setting-ai-article-model").value = monitorSettings.aiArticleModel || "qwen2.5:3b";
  void checkOllamaStatus();
  void refreshAuthStatus();
  byId("settings-modal").hidden = false;
}

function closeSettings() {
  byId("settings-modal").hidden = true;
}

async function saveSettings() {
  const values = {
    intervalSeconds: Number(byId("setting-monitor-interval").value),
    quality: byId("setting-monitor-quality").value,
    commentFormat: byId("setting-comment-format").value,
    assNgRegex: byId("setting-ass-ng-regex").value,
    autoRecord: byId("setting-auto-record").checked,
    autoStart: byId("setting-auto-start").checked,
    runAtStartup: byId("setting-run-at-startup").checked,
    closeToTray: byId("setting-close-to-tray").checked,
    keepAwake: byId("setting-keep-awake").checked,
    autoUpdateStreamlink: byId("setting-auto-update-streamlink").checked,
    notifyOnLive: byId("setting-notify-on-live").checked,
    aiArticleEnabled: byId("setting-ai-article-enabled").checked,
    aiArticleModel: byId("setting-ai-article-model").value.trim() || "qwen2.5:3b"
  };
  Object.assign(values, readAssMotionInputs("setting-ass-"));
  const button = byId("save-settings-button");
  button.disabled = true;
  try {
    applyMonitorState(await api.saveMonitorSettings(values));
    byId("ass-ng-regex").value = values.assNgRegex;
    applyAssMotionInputs("ass-", monitorSettings);
    closeSettings();
    showToast("設定を保存しました。");
  } catch (error) {
    showToast(error.message || "設定を保存できませんでした。", true);
  } finally {
    button.disabled = false;
  }
}

function handleMonitorLiveDetected(payload) {
  if (!payload || !payload.liveId) return;
  const detectionKey = String(payload.userId || "") + ":" + String(payload.liveId);
  if (monitorHandledDetections.has(detectionKey)) return;
  monitorHandledDetections.add(detectionKey);
  while (monitorHandledDetections.size > 250) {
    monitorHandledDetections.delete(monitorHandledDetections.values().next().value);
  }
  const label = (payload.name || ("ユーザー " + payload.userId)) +
    " の配信開始を検知：" + payload.liveId +
    (payload.title ? "「" + payload.title + "」" : "") +
    (payload.source ? "（" + payload.source + "）" : "") +
    (payload.isFollowerOnly ? "［フォロー限定］" : "");
  addMonitorActivity(label, "live");
  showToast("配信開始を検知しました：" + payload.liveId);

  if (!monitorSettings.autoRecord) return;
  if (
    payload.liveId === currentLiveId &&
    (recordStartedAt || recordButton.disabled || monitorAutoProcessing)
  ) return;
  if (monitorAutoQueue.some((item) => item.liveId === payload.liveId)) return;
  monitorAutoQueue.push(payload);
  processMonitorAutoQueue();
}

async function processMonitorAutoQueue() {
  if (monitorAutoProcessing || monitorAutoQueue.length === 0) return;
  // Never interrupt an existing manual or automatic recording.
  if (captureStopInProgress || recordButton.disabled || recordStartedAt) return;

  const target = monitorAutoQueue.shift();
  if (!target || !target.liveId) return;
  monitorAutoProcessing = true;
  if (recordButton) recordButton.disabled = true;
  renderLiveBroadcasts();

  try {
    const liveId = normalizeId(target.liveId);
    if (!liveId) throw new Error("監視で検出した放送IDが正しくありません。");

    if (currentLiveId !== liveId) currentProgramMetadata = {};
    currentLiveId = liveId;
    currentProgramMetadata = {
      ...currentProgramMetadata,
      liveId,
      title: target.title || "",
      programTitle: target.title || "",
      broadcasterName: target.displayName || target.name || "",
      broadcasterId: target.broadcasterId || target.userId || "",
      startedAt: target.startedAt || ""
    };
    currentCaptureTarget = { ...target, liveId, isAutomaticRecording: true, isManualRecording: false };
    currentRecordingIsTimeshift = false;
    liveInput.value = liveId;
    renderSessionProgramInfo();
    clearComments();
    setConnection("connecting");
    setCaptureText("live-title", target.title || "番組情報を取得中…");
    setCaptureText("live-meta", "配信監視から自動録画を開始しています");

    setConnection("connecting");
    const capture = await api.startCapture(liveId, monitorSettings.quality || "best", {
      displayName: target.displayName || target.name || "",
      broadcasterId: target.broadcasterId || target.userId || "",
      programTitle: target.title || "",
      startedAt: target.startedAt || ""
    });
    if (capture.comment && capture.comment.metadata) updateMetadata(capture.comment.metadata);
    if (capture.comment && capture.comment.commentFile) {
      setCaptureText("comment-file", "コメント：" + capture.comment.commentFile);
    }
    setConnection(capture.commentsConnected ? "connected" : "error");

    const result = capture.video || {};
    setCaptureText("video-file", "保存先：" + (result.path || ""));
    recordStartedAt = result.startedAt ? new Date(result.startedAt).getTime() : Date.now();
    setVideoState(true);
    startRecordClock();
    addMonitorActivity(liveId + " の映像・コメント同時取得を開始しました。", "live");
    if (capture.commentError) {
      showToast("映像録画は開始しましたが、コメント取得に失敗しました: " + capture.commentError, true);
    } else {
      showToast("映像録画とコメント取得を開始しました：" + liveId);
    }
    api.notifyMonitorRecordingResult({
      status: "started",
      userId: target.userId,
      name: target.displayName || target.name || "",
      liveId,
      commentError: capture.commentError || ""
    }).catch(() => {});
  } catch (error) {
    setConnection("error");
    currentCaptureTarget = null;
    renderSessionProgramInfo();
    monitorHandledDetections.delete(String(target.userId || "") + ":" + String(target.liveId || ""));
    await api.retryMonitorTarget({
      userId: target.userId,
      liveId: target.liveId
    }).catch(() => {});
    addMonitorActivity(
      (target.liveId || "") + " の自動録画に失敗。次回の監視確認で再試行します：" + (error.message || String(error)),
      "error"
    );
    showToast(error.message || "監視対象の自動録画に失敗しました。", true);
    api.notifyMonitorRecordingResult({
      status: "failed",
      userId: target.userId,
      name: target.displayName || target.name || "",
      liveId: target.liveId,
      message: error.message || String(error)
    }).catch(() => {});
  } finally {
    monitorAutoProcessing = false;
    if (!recordStartedAt && videoCaptureState !== "recording") {
      currentCaptureTarget = null;
      renderSessionProgramInfo();
      if (recordButton) recordButton.disabled = recordStartInProgress || videoCaptureState === "stopping";
    }
    renderLiveBroadcasts();
    if (monitorAutoQueue.length > 0 && !recordButton.disabled) {
      window.setTimeout(processMonitorAutoQueue, 1500);
    }
  }
}


const APP_PAGES = new Set(["dashboard", "monitor", "record", "comments", "compose", "library", "articles", "updates"]);

function setActivePage(page) {
  const activePage = APP_PAGES.has(page) ? page : "dashboard";
  const content = document.querySelector(".content");
  content.dataset.activePage = activePage;

  content.querySelectorAll(":scope > [data-page]").forEach((view) => {
    const isActive = view.dataset.page === activePage;
    view.classList.toggle("page-hidden", !isActive);
    if (view.id === "library-panel" || view.id === "articles-panel") view.hidden = !isActive;
  });

  document.querySelectorAll("[data-page-target]").forEach((button) => {
    const isActive = button.dataset.pageTarget === activePage;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (activePage === "library") loadCaptureLibrary();
  if (activePage === "articles") loadBroadcastArticles();
  if (activePage === "dashboard") void refreshLiveArticlePreviews();
}

function formatLibraryBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatLibraryDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "日時不明"
    : date.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function createLibraryText(className, value) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = String(value || "");
  return element;
}

function renderCaptureLibrary() {
  const list = byId("library-list");
  if (!list) return;
  list.replaceChildren();
  const query = String(byId("library-search").value || "").trim().toLowerCase();
  const filter = byId("library-filter").value;
  const items = captureLibraryItems.filter((item) => {
    if (filter !== "all" && item.type !== filter) return false;
    const searchable = [item.fileName, item.broadcaster, item.broadcasterUserId, item.liveId, item.extension].join(" ").toLowerCase();
    return !query || searchable.includes(query);
  });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = captureLibraryItems.length
      ? "条件に一致するファイルがありません。"
      : "まだ録画・コメントファイルがありません。録画またはコメント接続を開始すると、ここに表示されます。";
    list.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const broadcaster = String(item.broadcaster || "配信者名未取得").trim() || "配信者名未取得";
    if (!groups.has(broadcaster)) groups.set(broadcaster, []);
    groups.get(broadcaster).push(item);
  }

  for (const [broadcaster, broadcasterItems] of groups) {
    const card = document.createElement("section");
    card.className = "library-broadcaster-card";
    const heading = document.createElement("div");
    heading.className = "library-broadcaster-heading";
    const profileUserId = broadcasterItems.find(item => item.broadcasterUserId)?.broadcasterUserId || "";
    const openProfile = async () => {
      try { await api.openNicoUserProfile(profileUserId); }
      catch (error) { showToast(error.message || "ユーザーページを開けませんでした。", true); }
    };
    const thumb = document.createElement(profileUserId ? "button" : "div");
    thumb.className = "library-broadcaster-thumb";
    thumb.textContent = "N";
    if (profileUserId) {
      thumb.type = "button";
      thumb.classList.add("library-profile-link");
      thumb.title = broadcaster + " のニコニコユーザーページを開く";
      thumb.setAttribute("aria-label", thumb.title);
      thumb.addEventListener("click", () => void openProfile());
    }
    const profileIconUrl = broadcasterItems.find(item => item.profileIconUrl)?.profileIconUrl || "";
    if (profileIconUrl) {
      const image = document.createElement("img");
      image.alt = broadcaster + " のプロフィール画像";
      image.referrerPolicy = "no-referrer";
      image.src = profileIconUrl;
      image.addEventListener("error", () => { image.remove(); thumb.textContent = "N"; }, { once: true });
      thumb.replaceChildren(image);
    }
    const identity = document.createElement("div");
    identity.className = "library-broadcaster-identity";
    const name = document.createElement(profileUserId ? "button" : "strong");
    name.textContent = broadcaster;
    if (profileUserId) {
      name.type = "button";
      name.className = "library-profile-name-link";
      name.title = "ニコニコのユーザーページを開く";
      name.addEventListener("click", () => void openProfile());
    }
    const videoCount = broadcasterItems.filter(item => item.type === "video").length;
    const commentCount = broadcasterItems.filter(item => item.type === "comment").length;
    const meta = document.createElement("span");
    meta.textContent = "動画 " + videoCount + " 件 · コメント " + commentCount + " 件 · " +
      formatLibraryDate(broadcasterItems[0]?.modifiedAt);
    identity.append(name, meta);
    if (!profileUserId) {
      // 自動照合できない古い録画にのみ、安全な手動入力を残す。
      const setId = document.createElement("button");
      setId.type = "button";
      setId.className = "library-profile-map-button";
      setId.textContent = "ユーザーIDを手動設定";
      setId.title = "コメントログや放送情報から自動取得できなかった場合のみ設定してください。";
      const form = document.createElement("form");
      form.className = "library-profile-id-form";
      form.hidden = true;
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "ニコニコのユーザーIDまたはURL";
      input.setAttribute("aria-label", broadcaster + " のユーザーID");
      input.required = true;
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "button button-primary button-small";
      save.textContent = "保存";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button button-quiet button-small";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => { form.hidden = true; setId.hidden = false; });
      setId.addEventListener("click", () => {
        form.hidden = false;
        setId.hidden = true;
        input.focus();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api.setLibraryProfileUserId(broadcaster, input.value.trim());
          showToast(broadcaster + " のユーザーIDを保存しました。");
          await loadCaptureLibrary();
        } catch (error) {
          showToast(error.message || "ユーザーIDを保存できませんでした。", true);
        } finally {
          save.disabled = false;
        }
      });
      form.append(input, save, cancel);
      identity.append(setId, form);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "button button-secondary button-small library-broadcaster-toggle";
    const expanded = expandedLibraryBroadcasters.has(broadcaster);
    toggle.textContent = expanded ? "録画を閉じる" : "録画を見る";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", () => {
      if (expandedLibraryBroadcasters.has(broadcaster)) expandedLibraryBroadcasters.delete(broadcaster);
      else expandedLibraryBroadcasters.add(broadcaster);
      renderCaptureLibrary();
    });
    heading.append(thumb, identity, toggle);
    card.appendChild(heading);
    const contents = document.createElement("div");
    contents.className = "library-broadcaster-files";
    contents.hidden = !expanded;
    card.appendChild(contents);

    for (const item of broadcasterItems) {
    const row = document.createElement("div");
    row.className = "library-row";
    const file = document.createElement("div");
    file.className = "library-file-cell";
    file.appendChild(createLibraryText("library-file-name", item.fileName));
    file.appendChild(createLibraryText("library-file-meta", item.liveId || item.extension));
    let scenes = null;
    if (item.type === "video") {
      scenes = makeLibraryVideoScenesPanel(item);
      const thumbnail = document.createElement("button");
      thumbnail.type = "button";
      thumbnail.className = "library-video-thumbnail";
      thumbnail.title = "動画内の別の場面も見る";
      thumbnail.setAttribute("aria-label", item.fileName + " の動画内の場面を見る");
      const image = document.createElement("img");
      image.alt = item.fileName + " の録画映像から取得したサムネイル";
      image.loading = "lazy";
      image.hidden = true;
      const placeholder = document.createElement("span");
      placeholder.className = "library-video-thumbnail-placeholder";
      placeholder.textContent = "サムネイル取得中…";
      thumbnail.append(image, placeholder);
      thumbnail.addEventListener("click", () => void scenes.expand());
      file.appendChild(thumbnail);
      if (expanded) scheduleLibraryThumbnail(image, placeholder, item);
    }
    row.appendChild(file);
    if (item.type === "video" && item.article) {
      const articleSummary = document.createElement("div"); articleSummary.className = "library-article-summary";
      const articleTitle = document.createElement("strong"); articleTitle.textContent = "放送記事：" + item.article.title; articleSummary.appendChild(articleTitle);
      if (item.article.summary) { const summary = document.createElement("p"); summary.textContent = item.article.summary; articleSummary.appendChild(summary); }
      if (item.article.topics && item.article.topics.length) { const topics = document.createElement("small"); topics.textContent = "話題：" + item.article.topics.join("・"); articleSummary.appendChild(topics); }
      const openArticle = document.createElement("button"); openArticle.type = "button"; openArticle.className = "button button-outline button-small"; openArticle.textContent = "記事を見る";
      openArticle.addEventListener("click", async () => { await loadBroadcastArticles(); byId("articles-search").value = item.liveId || item.article.title; setActivePage("articles"); renderBroadcastArticles(); });
      articleSummary.appendChild(openArticle); file.appendChild(articleSummary);
    }
    row.appendChild(createLibraryText("library-broadcaster", item.broadcaster));
    const type = createLibraryText("library-type", item.type === "video" ? "録画動画 · " + item.extension : "コメント · " + item.extension);
    type.classList.toggle("is-video", item.type === "video");
    row.appendChild(type);
    row.appendChild(createLibraryText("library-date", formatLibraryDate(item.modifiedAt)));
    row.appendChild(createLibraryText("library-size", formatLibraryBytes(item.sizeBytes)));
    const actions = document.createElement("div");
    actions.className = "library-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "button button-primary button-small";
    openButton.textContent = item.type === "video" ? "再生" : "開く";
    openButton.addEventListener("click", async () => {
      try { await api.openLibraryItem(item.path); }
      catch (error) { showToast(error.message || "ファイルを開けませんでした。", true); }
    });
    const showButton = document.createElement("button");
    showButton.type = "button";
    showButton.className = "button button-quiet button-small";
    showButton.textContent = "場所";
    showButton.addEventListener("click", async () => {
      try { await api.showLibraryItem(item.path); }
      catch (error) { showToast(error.message || "保存場所を開けませんでした。", true); }
    });
    actions.append(openButton, showButton);
    if (item.type === "comment" && item.extension === "JSONL") {
      const articleButton = document.createElement("button");
      articleButton.type = "button";
      articleButton.className = "button button-outline button-small";
      articleButton.textContent = "記事を生成";
      articleButton.addEventListener("click", async () => {
        articleButton.disabled = true;
        try {
          const result = await api.generateBroadcastArticle(item.path);
          if (result && result.status === "generated") {
            showToast("放送記事を生成しました: " + (result.title || item.liveId));
            await loadBroadcastArticles();
          } else {
            showToast((result && result.reason) || "記事を生成できませんでした。", true);
          }
        } catch (error) {
          showToast(error.message || "放送記事を生成できませんでした。", true);
        } finally {
          articleButton.disabled = false;
        }
      });
      actions.appendChild(articleButton);
    }
    if (item.type === "video") {
      const scenesButton = document.createElement("button");
      scenesButton.type = "button";
      scenesButton.className = "button button-outline button-small library-video-scenes-button";
      scenesButton.textContent = "動画内を見る";
      scenesButton.addEventListener("click", () => void scenes.expand());
      actions.appendChild(scenesButton);
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "button button-danger button-small";
      deleteButton.textContent = "削除";
      deleteButton.title = "確認後にこの動画ファイルだけを削除します。コメントログは残ります。";
      deleteButton.addEventListener("click", async () => {
        deleteButton.disabled = true;
        try {
          const result = await api.deleteLibraryVideo(item.path);
          if (result && result.cancelled) return;
          showToast("動画を削除しました: " + (result.fileName || item.fileName));
          await loadCaptureLibrary();
        } catch (error) {
          showToast(error.message || "動画を削除できませんでした。", true);
        } finally {
          deleteButton.disabled = false;
        }
      });
      actions.appendChild(deleteButton);
    }
    if (item.type === "comment") {
      const deleteCommentButton = document.createElement("button");
      deleteCommentButton.type = "button";
      deleteCommentButton.className = "button button-danger button-small";
      deleteCommentButton.textContent = "削除";
      deleteCommentButton.title = "確認後、このコメントファイルだけを削除します。録画動画とAI記事は残ります。";
      deleteCommentButton.addEventListener("click", async () => {
        deleteCommentButton.disabled = true;
        try {
          const result = await api.deleteLibraryComment(item.path);
          if (result && result.cancelled) return;
          showToast("コメントファイルを削除しました: " + (result.fileName || item.fileName));
          await loadCaptureLibrary();
        } catch (error) {
          showToast(error.message || "コメントファイルを削除できませんでした。", true);
        } finally {
          deleteCommentButton.disabled = false;
        }
      });
      actions.appendChild(deleteCommentButton);
    }
    row.appendChild(actions);
    if (scenes) row.appendChild(scenes.panel);
    contents.appendChild(row);
    }
    list.appendChild(card);
  }
}

async function loadCaptureLibrary() {
  const button = byId("library-refresh-button");
  if (button) button.disabled = true;
  const list = byId("library-list");
  if (list && !captureLibraryItems.length) {
    list.textContent = "録画ファイルを検索しています…";
  }
  try {
    const [result, articleResult] = await Promise.all([api.getCaptureLibrary(), api.getBroadcastArticles()]);
    broadcastArticles = Array.isArray(articleResult.items) ? articleResult.items : [];
    captureLibraryItems = Array.isArray(result.items) ? result.items : [];
    byId("library-total").textContent = String(result.total || 0);
    byId("library-video-count").textContent = String(result.videoCount || 0);
    byId("library-comment-count").textContent = String(result.commentCount || 0);
    renderCaptureLibrary();
  } catch (error) {
    if (list) list.textContent = error.message || "ライブラリを読み込めませんでした。";
  } finally {
    if (button) button.disabled = false;
  }
}

const articleThumbnailQueue = [];
let articleThumbnailRequests = 0;
function scheduleArticleThumbnail(thumbnail, placeholder, article) {
  articleThumbnailQueue.push(async () => {
    if (!thumbnail.isConnected) return;
    try {
      const imageUrl = await api.getArticleThumbnail(article.articlePath);
      if (!thumbnail.isConnected || !placeholder.isConnected) return;
      if (typeof imageUrl === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(imageUrl)) {
        thumbnail.addEventListener("error", () => {
          thumbnail.remove();
          placeholder.hidden = false;
          placeholder.textContent = "画像を表示できません";
        }, { once: true });
        thumbnail.src = imageUrl;
        article.coverImage = imageUrl;
        thumbnail.hidden = false;
        placeholder.hidden = true;
      } else {
        thumbnail.remove();
        placeholder.textContent = "放送映像が保存されていません";
      }
    } catch (_) {
      if (!thumbnail.isConnected) return;
      thumbnail.remove();
      placeholder.textContent = "サムネイルを取得できません";
    }
  });
  pumpArticleThumbnailQueue();
}
function pumpArticleThumbnailQueue() {
  while (articleThumbnailRequests < 2 && articleThumbnailQueue.length) {
    const job = articleThumbnailQueue.shift();
    articleThumbnailRequests++;
    // Delay until the new card has been added to the document.
    Promise.resolve().then(job).catch(() => {}).finally(() => {
      articleThumbnailRequests--;
      pumpArticleThumbnailQueue();
    });
  }
}

function renderBroadcastArticles() {
  const list = byId("articles-list");
  if (!list) return;
  list.replaceChildren();
  const query = String(byId("articles-search").value || "").trim().toLowerCase();
  const statusFilter = byId("articles-status-filter")?.value || "all";
  const sortMode = byId("articles-sort")?.value || "newest";
  const items = broadcastArticles.filter((article) => {
    const isLive = article.liveStatus === "live" || article.isLive === true;
    if (statusFilter === "live" && !isLive) return false;
    if (statusFilter === "ended" && isLive) return false;
    if (statusFilter === "manual" && article.articleSource !== "manual") return false;
    if (statusFilter === "ai" && !article.aiProvider) return false;
    const topics = (article.topics || []).map((topic) => typeof topic === "string" ? topic : topic.term);
    const timeline = (article.aiTimeline || []).map((item) => item && item.detail || "");
    const searchable = [
      article.broadcasterName, article.programTitle, article.title, article.liveId,
      article.summary, article.note, article.aiAudienceReaction, article.videoAnalysis,
      article.audioAnalysis, article.audioTranscript,
      ...(article.paragraphs || []), ...(article.aiHighlights || []), ...timeline, ...topics
    ].join(" ").toLowerCase();
    return !query || searchable.includes(query);
  }).sort((a, b) => {
    const aTime = Date.parse(a.generatedAt || a.startedAt || 0) || 0;
    const bTime = Date.parse(b.generatedAt || b.startedAt || 0) || 0;
    if (sortMode === "oldest") return aTime - bTime;
    if (sortMode === "comments") return Number(b.commentCount || 0) - Number(a.commentCount || 0);
    return bTime - aTime;
  });
  const countLabel = byId("articles-filter-count");
  if (countLabel) countLabel.textContent = items.length.toLocaleString("ja-JP") + " 件表示 / 全 " + broadcastArticles.length.toLocaleString("ja-JP") + " 件";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "article-empty";
    empty.textContent = broadcastArticles.length
      ? "検索条件に一致する記事がありません。"
      : "まだ放送記事がありません。配信の録画終了またはコメント切断時に自動生成されます。過去のJSONLログは録画ライブラリから記事化できます。";
    list.appendChild(empty);
    return;
  }

  const dayGroups = new Map();
  const dayFormatter = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short" });
  for (const item of items) {
    const parsed = new Date(item.startedAt || item.generatedAt || "");
    const day = Number.isNaN(parsed.getTime()) ? "日時未取得" : dayFormatter.format(parsed);
    if (!dayGroups.has(day)) dayGroups.set(day, []);
    dayGroups.get(day).push(item);
  }
  for (const [day, dayItems] of dayGroups) {
    const dayHeading = document.createElement("div");
    dayHeading.className = "broadcast-article-day-heading";
    const dateLabel = document.createElement("strong"); dateLabel.textContent = day;
    const countLabel = document.createElement("span"); countLabel.textContent = dayItems.length.toLocaleString("ja-JP") + "本";
    dayHeading.append(dateLabel, countLabel);
    list.appendChild(dayHeading);
    for (const article of dayItems) {
    const card = document.createElement("article");
    card.className = "broadcast-article-card";
    const masthead = document.createElement("div");
    masthead.className = "broadcast-article-masthead";
    const byline = document.createElement("span");
    byline.textContent = "配信者：" + (article.broadcasterName || "未取得") + " · " + formatLibraryDate(article.startedAt || article.generatedAt);
    masthead.appendChild(byline);
    const stateBadge = document.createElement("span");
    const articleIsLive = article.liveStatus === "live" || article.isLive === true;
    stateBadge.className = "broadcast-article-status-badge" + (articleIsLive ? " is-live" : "");
    stateBadge.textContent = articleIsLive ? "● 配信中" : "配信終了";
    masthead.appendChild(stateBadge);
    const hero = document.createElement("div");
    hero.className = "broadcast-article-hero";
    const heroCopy = document.createElement("div");
    heroCopy.className = "broadcast-article-hero-copy";
    const media = document.createElement("div");
    media.className = "broadcast-article-media";
    const mediaPlaceholder = document.createElement("div");
    mediaPlaceholder.className = "broadcast-article-media-placeholder";
    mediaPlaceholder.textContent = article.liveStatus === "live" || article.isLive
      ? "● LIVE 配信中"
      : "放送映像プレビュー";
    media.appendChild(mediaPlaceholder);
    const coverImage = typeof article.coverImage === "string" && article.coverImage.length < 420100 &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(article.coverImage) ? article.coverImage : "";
    if (coverImage) {
      const cover = document.createElement("img");
      cover.className = "broadcast-article-thumbnail";
      cover.alt = (article.programTitle || article.title || "放送") + " の放送画面";
      cover.loading = "lazy";
      cover.src = coverImage;
      cover.addEventListener("error", () => {
        cover.remove();
        mediaPlaceholder.hidden = false;
        mediaPlaceholder.textContent = "保存画像を表示できません";
      }, { once: true });
      mediaPlaceholder.hidden = true;
      media.appendChild(cover);
    } else if (article.articlePath && typeof api.getArticleThumbnail === "function") {
      const thumbnail = document.createElement("img");
      thumbnail.className = "broadcast-article-thumbnail";
      thumbnail.alt = (article.programTitle || article.title || "放送") + " の録画サムネイル";
      thumbnail.loading = "lazy";
      thumbnail.hidden = true;
      mediaPlaceholder.textContent = "サムネイルを確認中…";
      media.appendChild(thumbnail);
      scheduleArticleThumbnail(thumbnail, mediaPlaceholder, article);
    } else {
      mediaPlaceholder.textContent = "放送映像が保存されていません";
    }
    const heading = document.createElement("div");
    heading.className = "broadcast-article-heading";
    const title = document.createElement("h3");
    title.textContent = (article.aiProvider && article.title) || article.programTitle || article.title || article.liveId || "放送記事";
    const meta = document.createElement("p");
    meta.className = "broadcast-article-meta";
    meta.textContent = ["ニコニコ生放送", article.liveId || ""].filter(Boolean).join(" · ");
    if (article.liveStatus === "live" || article.isLive) {
      const liveBadge = document.createElement("span");
      liveBadge.className = "broadcast-article-live-badge";
      liveBadge.textContent = "● LIVE 配信中・記事更新中";
      heading.append(liveBadge);
    }
    heading.append(title, meta);
    const tags = document.createElement("div");
    tags.className = "broadcast-article-tags";
    const addTag = (label, kind = "") => {
      const tag = document.createElement("span");
      tag.className = "broadcast-article-tag" + (kind ? " " + kind : "");
      tag.textContent = label;
      tags.appendChild(tag);
    };
    if (article.aiProvider) addTag("AI生成 · " + article.aiProvider + (article.aiModel ? " / " + article.aiModel : ""), "ai");
    else addTag("統計・コメント整理記事", "local");
    if (article.aiGenerationStatus === "recovered") addTag("本文を短縮再生成済み", "ai");
    if (article.aiGenerationStatus === "stale") addTag("前回の完成記事を保持（今回のAI更新失敗）", "local");
    if (article.aiGenerationStatus === "fallback") addTag("AI本文未完了・標準記事を表示中", "local");
    if (article.articleSource === "manual") addTag("登録なし・手動生成");
    if (article.videoFrameCount) addTag("映像 " + article.videoFrameCount + "枚" + (article.videoAiAnalyzed ? "・AI解析済み" : "・フレーム取得済み"), "video");
    if (article.mediaAnalysis && article.mediaAnalysis.audio === "unavailable") addTag("音声未解析", "local");
    if (article.mediaAnalysis && article.mediaAnalysis.comments === "unavailable") addTag("コメント未取得", "local");
    if (article.audioAnalysis || article.audioTranscriptSegmentCount) addTag("音声文字起こし済み", "audio");
    if (article.liveStatus === "live" || article.isLive) addTag("ライブ更新中", "live");
    if (tags.childElementCount) heading.appendChild(tags);
    heroCopy.appendChild(heading);
    if (article.title && article.programTitle && article.title !== article.programTitle) {
      const editorialTitle = document.createElement("p");
      editorialTitle.className = "broadcast-article-editorial-title";
      editorialTitle.textContent = article.aiProvider
        ? "元の番組タイトル：" + article.programTitle
        : "記事見出し：" + article.title;
      heroCopy.appendChild(editorialTitle);
    }
    const commentSignal = document.createElement("div");
    commentSignal.className = "broadcast-article-comment-signal";
    commentSignal.textContent = Number(article.commentCount || 0) > 0
      ? "コメント " + Number(article.commentCount).toLocaleString("ja-JP") + "件を取得・記事に反映しています。"
      : (articleIsLive ? "コメントの受信を待っています。" : "取得できたコメントはありません。");
    heroCopy.appendChild(commentSignal);
    const sources = document.createElement("div");
    sources.className = "broadcast-article-evidence";
    const sourceLabels = [];
    if (Number(article.videoFrameCount) > 0 || article.videoAnalysis) sourceLabels.push("映像フレーム");
    if (article.audioTranscript || article.audioAnalysis) sourceLabels.push("音声・文字起こし");
    if (Number(article.commentCount) > 0) sourceLabels.push("保存コメント");
    if (article.programTitle || article.description) sourceLabels.push("番組情報");
    if (sourceLabels.length) {
      const label = document.createElement("strong");
      label.textContent = "記事の参照資料";
      sources.appendChild(label);
      for (const source of sourceLabels) {
        const pill = document.createElement("span");
        pill.textContent = source;
        sources.appendChild(pill);
      }
      heroCopy.appendChild(sources);
    }
    hero.append(media, heroCopy);

    const stats = document.createElement("div");
    stats.className = "broadcast-article-stats";
    const stat = (label, value) => {
      const item = document.createElement("div");
      item.className = "broadcast-article-stat";
      const caption = document.createElement("span");
      caption.textContent = label;
      const amount = document.createElement("strong");
      amount.textContent = value;
      item.append(caption, amount);
      return item;
    };
    stats.append(
      stat("来場者", article.visitorCount == null ? "未取得" : Number(article.visitorCount).toLocaleString("ja-JP")),
      stat("投稿者", Number(article.uniqueCommenters || 0).toLocaleString("ja-JP") + "人"),
      stat("コメント", Number(article.commentCount || 0).toLocaleString("ja-JP") + "件"),
      stat("配信時間", article.durationMinutes == null ? "未取得" :
        (article.liveStatus === "live" || article.isLive ? "約" + article.durationMinutes + "分経過" : "約" + article.durationMinutes + "分"))
    );

    const body = document.createElement("div");
    body.className = "broadcast-article-body";
    if (article.summary) {
      const lead = document.createElement("p");
      lead.className = "broadcast-article-lead";
      lead.textContent = article.summary;
      body.appendChild(lead);
    }
    if (Array.isArray(article.aiHighlights) && article.aiHighlights.length) {
      const highlights = document.createElement("section");
      highlights.className = "broadcast-article-highlights";
      const heading = document.createElement("h4");
      heading.textContent = "この記事の注目点";
      const list = document.createElement("ul");
      for (const item of article.aiHighlights) {
        const row = document.createElement("li"); row.textContent = item; list.appendChild(row);
      }
      highlights.append(heading, list); body.appendChild(highlights);
    }
    const articleSections = Array.isArray(article.aiSections)
      ? article.aiSections.filter(item => item && item.heading && item.body).slice(0, 6)
      : [];
    if (articleSections.length) {
      const sectionLabel = document.createElement("div");
      sectionLabel.className = "broadcast-article-story-label";
      sectionLabel.textContent = "放送の詳しい内容";
      body.appendChild(sectionLabel);
      for (const chapter of articleSections) {
        const section = document.createElement("section");
        section.className = "broadcast-article-chapter";
        const heading = document.createElement("h4");
        heading.textContent = String(chapter.heading).slice(0, 90);
        const text = document.createElement("p");
        text.textContent = String(chapter.body).slice(0, 2000);
        section.append(heading, text);
        body.appendChild(section);
      }
    } else {
      for (const paragraph of Array.isArray(article.paragraphs) ? article.paragraphs : []) {
        const p = document.createElement("p");
        p.textContent = paragraph;
        body.appendChild(p);
      }
    }
    if (Array.isArray(article.aiTimeline) && article.aiTimeline.length) {
      const timeline = document.createElement("section");
      timeline.className = "broadcast-article-timeline";
      const heading = document.createElement("h4"); heading.textContent = "放送の流れ"; timeline.appendChild(heading);
      for (const item of article.aiTimeline) {
        const row = document.createElement("p"); row.textContent = [item.time, item.detail].filter(Boolean).join("　"); timeline.appendChild(row);
      }
      body.appendChild(timeline);
    }
    if (article.aiAudienceReaction) {
      const reaction = document.createElement("p"); reaction.className = "broadcast-article-reaction";
      reaction.textContent = "コメント欄の反応：" + article.aiAudienceReaction; body.appendChild(reaction);
    }
    const note = document.createElement("p");
    note.className = "broadcast-article-note";
    note.textContent = article.note || "番組情報と保存済みコメントから自動生成された記事です。";
    const topicValues = (article.topics || []).map((topic) => typeof topic === "string" ? topic : topic.term).filter(Boolean);
    if (topicValues.length) {
      const topics = document.createElement("div");
      topics.className = "broadcast-article-topics";
      const label = document.createElement("strong");
      label.textContent = "注目トピック";
      topics.appendChild(label);
      for (const topic of topicValues.slice(0, 10)) {
        const chip = document.createElement("span");
        chip.textContent = topic;
        topics.appendChild(chip);
      }
      body.appendChild(topics);
    }
    const sourceDetails = [];
    if (article.videoAnalysis) sourceDetails.push("映像：" + article.videoAnalysis);
    if (article.audioAnalysis) sourceDetails.push("音声：" + article.audioAnalysis);
    if (Number(article.aiCommentTotalCount) > 0) {
      sourceDetails.push("AI参照コメント：" + Number(article.aiCommentSampleCount || 0).toLocaleString("ja-JP") + " / " + Number(article.aiCommentTotalCount).toLocaleString("ja-JP") + "件");
    }
    if (article.aiSourceCoverage && article.aiProvider) {
      const coverage = article.aiSourceCoverage;
      sourceDetails.push("映像AI：" + (coverage.video === "analyzed" ? "解析あり" : "未解析"));
      sourceDetails.push("音声AI：" + (coverage.audio === "transcribed" ? "文字起こしを参照" : "未解析"));
    }
    if (article.aiEvidence && Number(article.aiEvidence.timestampedCount) > 0) {
      sourceDetails.push("時刻付きコメント：" + Number(article.aiEvidence.timestampedCount).toLocaleString("ja-JP") + "件");
    }
    if (sourceDetails.length) {
      const sources = document.createElement("p");
      sources.className = "broadcast-article-sources";
      sources.textContent = sourceDetails.join("　｜　");
      body.appendChild(sources);
    }
    if (Array.isArray(article.aiQualityNotes) && article.aiQualityNotes.length) {
      const quality = document.createElement("p");
      quality.className = "broadcast-article-sources";
      quality.textContent = "記事の取得状況：" + article.aiQualityNotes.slice(0, 4).join(" ／ ");
      body.appendChild(quality);
    }
    body.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "broadcast-article-actions";
    if (article.liveId) {
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "button button-quiet button-small";
      watch.textContent = "元の放送を開く";
      watch.addEventListener("click", async () => {
        try { await api.openWatch(article.liveId); }
        catch (error) { showToast(error.message || "放送ページを開けませんでした。", true); }
      });
      actions.appendChild(watch);
    }
    if (article.videoFile) {
      const video = document.createElement("button");
      video.type = "button";
      video.className = "button button-outline button-small";
      video.textContent = "録画を再生";
      video.addEventListener("click", async () => {
        try { await api.openLibraryItem(article.videoFile); }
        catch (error) { showToast(error.message || "録画ファイルを開けませんでした。", true); }
      });
      actions.appendChild(video);
    }
    if (article.articlePath && !(article.liveStatus === "live" || article.isLive)) {
      const reanalyze = document.createElement("button");
      reanalyze.type = "button";
      reanalyze.className = "button button-primary button-small";
      reanalyze.textContent = "映像・音声・コメントを再解析";
      reanalyze.title = "録画から映像を抽出し、音声を文字起こしして保存コメントと照合します。";
      reanalyze.addEventListener("click", async () => {
        reanalyze.disabled = true;
        reanalyze.textContent = "再解析中…";
        try {
          const updated = await api.reanalyzeBroadcastArticle(article.articlePath);
          showToast("映像・音声・コメントの再解析が完了しました：" + (updated.title || updated.programTitle || "放送記事"));
          await loadBroadcastArticles();
        } catch (error) {
          showToast(error.message || "録画の再解析に失敗しました。", true);
        } finally {
          reanalyze.disabled = false;
          reanalyze.textContent = "映像・音声・コメントを再解析";
        }
      });
      actions.appendChild(reanalyze);
    }
    const exportArticle = document.createElement("button");
    exportArticle.type = "button";
    exportArticle.className = "button button-outline button-small";
    exportArticle.textContent = "HTMLで保存";
    exportArticle.addEventListener("click", async () => {
      exportArticle.disabled = true;
      try {
        const result = await api.exportBroadcastArticleHtml(article);
        if (result && result.saved) showToast("放送記事をHTMLで保存しました。");
      } catch (error) { showToast(error.message || "HTMLを書き出せませんでした。", true); }
      finally { exportArticle.disabled = false; }
    });
    actions.appendChild(exportArticle);
    const deleteArticle = document.createElement("button"); deleteArticle.type = "button"; deleteArticle.className = "button button-danger button-small"; deleteArticle.textContent = "記事を削除";
    deleteArticle.title = "記事JSONだけを削除します。録画動画とコメントログは残ります。";
    deleteArticle.addEventListener("click", async () => {
      deleteArticle.disabled = true;
      try { const result = await api.deleteBroadcastArticle(article.articlePath); if (result && result.cancelled) return;
        showToast("放送記事を削除しました。録画動画とコメントログは残っています。"); await loadBroadcastArticles(); await loadCaptureLibrary(); void refreshLiveArticlePreviews(true);
      } catch (error) { showToast(error.message || "放送記事を削除できませんでした。", true); }
      finally { deleteArticle.disabled = false; }
    });
    actions.appendChild(deleteArticle);
    if (article.generatedAt) {
      const updated = document.createElement("p");
      updated.className = "broadcast-article-updated";
      updated.textContent = "最終更新：" + formatLibraryDate(article.generatedAt);
      body.appendChild(updated);
    }
    const articleStoryboard = article.articlePath && !articleIsLive &&
      typeof api.getArticleVideoPreview === "function"
      ? makeArticleVideoScenesPanel(article) : null;
    if (articleStoryboard) {
      const scenesButton = document.createElement("button");
      scenesButton.type = "button";
      scenesButton.className = "button button-outline button-small broadcast-article-scenes-button";
      scenesButton.textContent = "動画内の場面一覧を見る";
      scenesButton.setAttribute("aria-expanded", "false");
      scenesButton.addEventListener("click", () => {
        void articleStoryboard.expand();
        scenesButton.setAttribute("aria-expanded", String(!articleStoryboard.panel.hidden));
        scenesButton.textContent = articleStoryboard.panel.hidden
          ? "動画内の場面一覧を見る" : "動画内の場面一覧を閉じる";
      });
      media.appendChild(scenesButton);
    }
    card.append(masthead, hero, stats);
    if (articleStoryboard) card.appendChild(articleStoryboard.panel);
    if (article.audioTranscript || article.audioAnalysis) {
      const audio = document.createElement("section");
      audio.className = "broadcast-article-audio";
      const audioTitle = document.createElement("strong");
      audioTitle.textContent = "音声から確認した内容";
      const audioStatus = document.createElement("p");
      audioStatus.textContent = article.audioAnalysis || "Whisper.cppで音声を文字起こししました。";
      audio.append(audioTitle, audioStatus);
      if (article.audioTranscript) {
        const details = document.createElement("details");
        details.className = "broadcast-article-transcript";
        const summary = document.createElement("summary");
        summary.textContent = "音声文字起こしを表示（" + Number(article.audioTranscriptSegmentCount || 0).toLocaleString("ja-JP") + "区間）";
        const transcript = document.createElement("p");
        transcript.textContent = String(article.audioTranscript).slice(0, 30000);
        details.append(summary, transcript);
        audio.appendChild(details);
      }
      card.appendChild(audio);
    }
    card.appendChild(body);
    if (article.aiFallbackReason) {
      const error = document.createElement("p");
      error.className = "broadcast-article-ai-warning";
      error.textContent = "AI更新エラー：" + article.aiFallbackReason;
      card.appendChild(error);
    }
    const footer = document.createElement("div");
    footer.className = "broadcast-article-footer";
    const summary = document.createElement("p");
    summary.textContent = [
      article.durationMinutes != null ? "配信時間 " + article.durationMinutes + "分" : "",
      "コメント " + Number(article.commentCount || 0).toLocaleString("ja-JP") + "件",
      article.visitorCount != null ? "来場者 " + Number(article.visitorCount).toLocaleString("ja-JP") + "人" : "来場者未取得",
      article.aiProvider ? "AI分析済み" : "AI未分析"
    ].filter(Boolean).join(" · ");
    footer.appendChild(summary);
    card.append(footer, actions);
    list.appendChild(card);
    }
  }
}

let broadcastArticles = [];
let selectedManualArticleVideoPath = "";
let liveArticleSessionActive = false;

async function selectManualArticleVideo() {
  const status = byId("manual-article-video-name");
  try { const result = await api.selectArticleVideo(); if (result?.canceled) return; selectedManualArticleVideoPath = result.path || ""; status.textContent = result.name || "動画を選択しました"; }
  catch (error) { status.textContent = error.message || "動画を選択できませんでした。"; showToast(status.textContent, true); }
}

async function startLiveArticleSession() {
  const button = byId("manual-article-live-start-button");
  const status = byId("manual-article-live-status");
  const liveId = byId("manual-article-live-id").value.trim();
  if (!liveId) { status.textContent = "生放送の放送IDを入力してください。"; showToast(status.textContent, true); return; }
  button.disabled = true;
  status.textContent = "視聴ページを表示せず、非表示の映像取得とコメント接続を開始しています…";
  try {
    const result = await api.startLiveArticleSession({
      liveId,
      broadcasterName: byId("manual-article-broadcaster").value,
      programTitle: byId("manual-article-title").value,
      description: byId("manual-article-description").value
    });
    liveArticleSessionActive = true;
    button.hidden = true;
    byId("manual-article-live-stop-button").hidden = false;
    status.textContent = "生放送の記事生成を開始しました。実際の配信映像をStreamlink経由でサンプリングし、放送音声とコメントを照合して記事を更新します。録画ファイルは残しません。";
    showToast("生放送の記事生成を開始しました。");
  } catch (error) {
    status.textContent = error.message || "生放送記事を開始できませんでした。";
    showToast(status.textContent, true);
  } finally { button.disabled = false; }
}

async function stopLiveArticleSession() {
  const button = byId("manual-article-live-stop-button");
  const status = byId("manual-article-live-status");
  button.disabled = true;
  status.textContent = "記事を最終保存して生放送との接続を終了しています…";
  try {
    await api.stopLiveArticleSession();
    liveArticleSessionActive = false;
    button.hidden = true;
    byId("manual-article-live-start-button").hidden = false;
    status.textContent = "生放送の記事生成を終了しました。取得したコメント・映像・音声を使って記事を保存しました。";
    await loadBroadcastArticles();
    showToast("生放送記事を保存しました。");
  } catch (error) {
    status.textContent = error.message || "生放送記事を停止できませんでした。";
    showToast(status.textContent, true);
  } finally { button.disabled = false; }
}

async function loadArticleWhisperSettings() {
  try {
    const settings = await api.getArticleWhisperSettings();
    if (settings.cliPath) byId("manual-article-whisper-cli-name").textContent = settings.cliPath;
    if (settings.modelPath) byId("manual-article-whisper-model-name").textContent = settings.modelPath;
    if (settings.managed) byId("manual-article-whisper-download-status").textContent = "自動セットアップ済み。録画動画・生放送の記事生成で利用できます。";
  } catch (_) {}
}
void loadArticleWhisperSettings();
async function downloadArticleWhisper() {
  const button = byId("manual-article-whisper-auto-button");
  const status = byId("manual-article-whisper-download-status");
  button.disabled = true; status.textContent = "Whisper.cppの準備を開始しています…";
  try {
    const result = await api.downloadArticleWhisper();
    byId("manual-article-whisper-cli-name").textContent = result.cliPath;
    byId("manual-article-whisper-model-name").textContent = result.modelPath;
    status.textContent = "自動セットアップ完了。音声文字起こしを利用できます。";
    showToast("Whisper.cppと日本語モデルを設定しました。");
  } catch (error) {
    status.textContent = error.message || "Whisper.cppの自動セットアップに失敗しました。";
    showToast(status.textContent, true);
  } finally { button.disabled = false; }
}

async function selectArticleWhisperCli() {
  try { const result = await api.selectArticleWhisperCli(); if (result && !result.canceled) { byId("manual-article-whisper-cli-name").textContent = result.name; showToast("Whisper実行ファイルを設定しました。"); } }
  catch (error) { showToast(error.message || "実行ファイルを選択できませんでした。", true); }
}

async function selectArticleWhisperModel() {
  try { const result = await api.selectArticleWhisperModel(); if (result && !result.canceled) { byId("manual-article-whisper-model-name").textContent = result.name; showToast("Whisper日本語モデルを設定しました。"); } }
  catch (error) { showToast(error.message || "日本語モデルを選択できませんでした。", true); }
}

async function generateManualBroadcastArticle() {
  const button = byId("manual-article-generate-button");
  const status = byId("manual-article-status");
  const file = byId("manual-article-file").files?.[0];
  button.disabled = true;
  status.textContent = selectedManualArticleVideoPath ? "動画の映像フレームと音声を解析し、コメントと照合しています…" : "記事を生成しています…";
  try {
    const result = await api.generateManualBroadcastArticle({
      broadcasterName: byId("manual-article-broadcaster").value,
      liveId: byId("manual-article-live-id").value,
      programTitle: byId("manual-article-title").value,
      description: byId("manual-article-description").value,
      commentsText: file ? await file.text() : "",
      fileName: file ? file.name : "",
      videoPath: selectedManualArticleVideoPath
    });
    if (!result || result.status !== "generated") {
      status.textContent = result?.reason || "記事を生成できませんでした。";
      showToast(status.textContent, true);
      return;
    }
    status.textContent = result.aiProvider
      ? "Ollama（" + result.aiModel + "）で記事を生成・保存しました。" + (result.videoFrameCount ? " 映像" + result.videoFrameCount + "枚を分析。" : "") + (result.audioAnalysis ? " 音声文字起こし" + (result.audioTranscriptSegmentCount || 0) + "区間を反映。" : "")
      : "記事を保存しました。" + (result.aiFallbackReason ? " AIは利用できないため標準方式で生成しました。 " + result.aiFallbackReason : "");
    if (result.audioTranscriptionError) status.textContent += " 音声解析: " + result.audioTranscriptionError;
    else if (result.audioTranscriptionStatus) status.textContent += " " + result.audioTranscriptionStatus;
    showToast("記事を生成しました: " + (result.title || "放送記事"));
    await loadBroadcastArticles();
  } catch (error) {
    status.textContent = error.message || "記事を生成できませんでした。";
    showToast(status.textContent, true);
  } finally { button.disabled = false; }
}

async function loadBroadcastArticles() {
  const button = byId("articles-refresh-button");
  if (button) button.disabled = true;
  const list = byId("articles-list");
  if (list && !broadcastArticles.length) list.textContent = "放送記事を読み込んでいます…";
  try {
    const result = await api.getBroadcastArticles();
    broadcastArticles = Array.isArray(result.items) ? result.items : [];
    byId("articles-total").textContent = String(result.total || 0);
    byId("articles-broadcaster-count").textContent = String(result.broadcasterCount || 0);
    byId("articles-comment-total").textContent = Number(result.commentCount || 0).toLocaleString("ja-JP");
    renderBroadcastArticles();
  } catch (error) {
    if (list) list.textContent = error.message || "放送記事を読み込めませんでした。";
  } finally {
    if (button) button.disabled = false;
  }
}

function formatUpdateBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderStreamlinkUpdateState(payload) {
  if (!payload) return;
  const status = byId("streamlink-update-status");
  switch (payload.state) {
    case "checking":
      status.textContent = "Streamlink自動更新：公式最新版を確認中…";
      break;
    case "available":
      status.textContent = "Streamlink " + payload.version + " が見つかりました。自動でダウンロード・適用します。";
      break;
    case "downloading":
      status.textContent = "Streamlink " + payload.version + " を自動ダウンロード・SHA-256検証中…";
      break;
    case "extracting":
      status.textContent = "Streamlink " + payload.version + " を展開・動作確認中…";
      break;
    case "updated":
      status.textContent = payload.message || ("Streamlink " + payload.version + " に自動更新しました。");
      refreshVideoTools();
      showToast("Streamlink " + payload.version + " へ自動更新しました。次回の録画から使用します。");
      break;
    case "current":
      status.textContent = "Streamlinkは最新です（" + (payload.version || "確認済み") + "）。自動更新は有効です。";
      break;
    case "disabled":
      status.textContent = payload.message || "Streamlink自動更新は設定で無効です。";
      break;
    case "unsupported":
      status.textContent = payload.message || "Streamlink自動更新はWindows版のみ対応です。";
      break;
    case "error":
      status.textContent = "Streamlink自動更新に失敗しました。次回の確認時に再試行します：" + (payload.message || "通信エラー");
      break;
    default:
      status.textContent = "Streamlink自動更新は有効です。アプリ起動時・6時間ごとに確認して自動適用します。";
  }
}

function parseReleaseHistory(markdown) {
  const entries = [];
  let current = null;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], notes: [] };
      entries.push(current);
      continue;
    }
    const note = line.match(/^\s*-\s+(.+)$/);
    if (current && note) current.notes.push(note[1]);
  }
  return entries;
}
function renderReleaseHistory(markdown) {
  const list = byId("release-history-list");
  if (!list) return;
  list.replaceChildren();
  const entries = parseReleaseHistory(markdown);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "release-history-empty";
    empty.textContent = "更新履歴を読み込めませんでした。アプリを再起動して再度お試しください。";
    list.appendChild(empty);
    return;
  }
  const currentVersion = byId("app-current-version").textContent.replace(/^v/, "").trim();
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "release-history-item";
    const heading = document.createElement("div");
    heading.className = "release-history-item-heading";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    heading.appendChild(title);
    if (entry.title === currentVersion || entry.title === "v" + currentVersion) {
      const current = document.createElement("span");
      current.className = "release-history-current";
      current.textContent = "現在のバージョン";
      heading.appendChild(current);
    }
    article.appendChild(heading);
    if (entry.notes.length) {
      const listItems = document.createElement("ul");
      for (const note of entry.notes) {
        const item = document.createElement("li");
        item.textContent = note;
        listItems.appendChild(item);
      }
      article.appendChild(listItems);
    }
    list.appendChild(article);
  }
}

async function loadReleaseHistory() {
  const list = byId("release-history-list");
  if (!list) return;
  try {
    renderReleaseHistory(await api.getChangelog());
  } catch (error) {
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "release-history-empty";
    empty.textContent = "更新履歴の読み込みに失敗しました: " + (error.message || "不明なエラー");
    list.appendChild(empty);
  }
}

function renderUpdateState(payload) {
  if (!payload) return;
  const panel = byId("update-panel");
  const status = byId("update-status");
  const progress = byId("update-progress");
  const installButton = byId("install-update-button");
  const checkButton = byId("check-update-button");
  const retryButton = byId("retry-update-download-button");
  const manualButton = byId("update-releases-button");
  const settingsRetryButton = byId("settings-retry-update-download-button");
  const settingsStatus = byId("settings-update-status");
  const settingsProgress = byId("settings-update-progress");
  const settingsInstallButton = byId("settings-install-update-button");
  const settingsCheckButton = byId("settings-check-update-button");
  const settingsBadge = byId("settings-update-badge");
  const latestVersionRow = byId("settings-latest-version-row");
  const latestVersionLabel = byId("settings-latest-version");
  panel.hidden = false;
  progress.hidden = true;
  installButton.hidden = true;
  retryButton.hidden = true;
  manualButton.hidden = true;
  settingsRetryButton.hidden = true;
  checkButton.disabled = false;

  const version = payload.version ? "v" + payload.version : "";
  switch (payload.state) {
    case "checking":
      status.textContent = "GitHubで新しいバージョンを確認しています…";
      checkButton.disabled = true;
      break;
    case "available":
      status.textContent = version + " が見つかりました。バックグラウンドでダウンロードしています…";
      checkButton.disabled = true;
      break;
    case "retrying":
      status.textContent = payload.message || "インストーラー全体を再ダウンロードしています…";
      checkButton.disabled = true;
      break;
    case "progress": {
      const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
      progress.hidden = false;
      progress.value = percent;
      checkButton.disabled = true;
      const total = payload.total ? "（" + formatUpdateBytes(payload.transferred) + " / " + formatUpdateBytes(payload.total) + "）" : "";
      status.textContent = "更新をダウンロード中… " + percent.toFixed(1) + "% " + total;
      break;
    }
    case "downloaded":
      status.textContent = version + " のダウンロードが完了しました。アプリ終了時に自動適用します。今すぐ更新する場合は「再起動して更新」を押してください。";
      progress.hidden = false;
      progress.value = 100;
      installButton.hidden = false;
      break;
    case "not-available":
      status.textContent = "最新バージョンです" + (version ? "（" + version + "）" : "。");
      break;
    case "unsupported":
      status.textContent = payload.message || "自動アップデートはWindowsのインストーラー版で利用できます。";
      break;
    case "error":
      status.textContent = "自動更新エラー：" + (payload.message || "通信エラー");
      retryButton.hidden = payload.category === "integrity";
      settingsRetryButton.hidden = payload.category === "integrity";
      manualButton.hidden = false;
      break;
    default:
      status.textContent = "更新状態を確認できません。";
  }

  settingsStatus.textContent = status.textContent;
  settingsProgress.hidden = progress.hidden;
  settingsProgress.value = progress.value;
  settingsInstallButton.hidden = installButton.hidden;
  settingsInstallButton.disabled = installButton.disabled;
  settingsRetryButton.hidden = retryButton.hidden;
  settingsRetryButton.disabled = retryButton.disabled;
  settingsCheckButton.disabled = checkButton.disabled;

  const badgeLabels = {
    checking: "確認中",
    retrying: "再試行中",
    available: "更新あり",
    progress: "ダウンロード中",
    downloaded: "更新準備完了",
    "not-available": "最新です",
    unsupported: "自動更新対象外",
    error: "確認エラー"
  };
  settingsBadge.textContent = badgeLabels[payload.state] || "状態確認中";
  settingsBadge.dataset.state = payload.state || "idle";

  const latestVersion = payload.version || latestVersionLabel.textContent.replace(/^v/, "");
  const hasNewVersion = ["available", "progress", "downloaded"].includes(payload.state) && Boolean(latestVersion);
  latestVersionRow.hidden = !hasNewVersion;
  latestVersionLabel.textContent = hasNewVersion ? "v" + latestVersion : "—";
}

async function checkAppUpdates() {
  const checkButton = byId("check-update-button");
  checkButton.disabled = true;
  renderUpdateState({ state: "checking" });
  try {
    const result = await api.checkForUpdates();
    if (result && result.supported === false) {
      renderUpdateState({
        state: "unsupported",
        message: result.reason || "この配布形式ではアプリ内自動更新を利用できません。Windowsインストーラー版をご利用ください。"
      });
    }
  } catch (error) {
    renderUpdateState({
      state: "error",
      message: error && error.message ? error.message : "通信エラー"
    });
    showToast(error.message || "アップデートを確認できませんでした。", true);
  }
}

async function retryAppUpdateDownload() {
  const button = byId("retry-update-download-button");
  const settingsButton = byId("settings-retry-update-download-button");
  button.disabled = true;
  settingsButton.disabled = true;
  renderUpdateState({ state: "retrying", message: "ダウンロードを再試行しています…" });
  try {
    await api.retryUpdateDownload();
  } catch (error) {
    renderUpdateState({ state: "error", message: error && error.message || "ダウンロードを再試行できませんでした。" });
  } finally {
    button.disabled = false;
    settingsButton.disabled = false;
  }
}

async function installAppUpdate() {
  const button = byId("install-update-button");
  const settingsButton = byId("settings-install-update-button");
  button.disabled = true;
  settingsButton.disabled = true;
  const installMessage = "録画とコメントログを安全に保存してから更新します…";
  byId("update-status").textContent = installMessage;
  byId("settings-update-status").textContent = installMessage;
  try {
    await api.installUpdate();
  } catch (error) {
    button.disabled = false;
    settingsButton.disabled = false;
    showToast(error.message || "更新をインストールできませんでした。", true);
  }
}

try {
  if (!api || typeof api.onEvent !== "function") throw new Error("Electron preload bridge のイベントAPIを利用できません。");
  api.onEvent(({ channel, payload }) => {
  if (channel === "live:event") renderEvent(payload);
  if (channel === "live:metadata") updateMetadata(payload);
  if (channel === "live:state") {
    const state = payload && payload.state ? payload.state : "disconnected";
    setConnection(state);
  }
  if (channel === "comments:file" && payload && payload.path) {
    setCaptureText("comment-file", "コメント：" + payload.path);
  }
  if (channel === "video:state") {
    if (payload && payload.starting) {
      setCaptureDetail((payload.message || "Streamlink起動中です。") + " 保存先：" + (payload.path || "確認中"));
    } else {
      if (payload && payload.recording) setCaptureDetail("映像録画中です。保存先：" + (payload.path || "準備中"));
      else if (payload && payload.path) setCaptureDetail("録画ファイルを確定しました：" + payload.path);
      else if (payload && payload.exitCode !== undefined) setCaptureDetail("録画プロセス終了。終了コード：" + payload.exitCode + " ／ 映像ファイル：" + (payload.path || "作成されていません"));
      handleVideoState(payload);
    }
  }
  if (channel === "preview:state") renderLivePreviewState(payload);
  if (channel === "capture:state" && payload) {
    if (payload.liveId && payload.liveId !== currentLiveId) return;
    if (payload.videoError) {
      setCaptureDetail("映像録画の開始に失敗しました：" + payload.videoError);
    } else if (payload.commentPending) {
      setConnection("connecting");
      setCaptureDetail("映像・音声録画中です。コメント接続を継続しています…");
    } else if (payload.commentError) {
      setConnection("error");
      setCaptureDetail("映像録画は継続していますが、コメント取得に失敗しました：" + payload.commentError);
    } else if (payload.recording && payload.commentsConnected) {
      setConnection("connected");
      setCaptureDetail("映像録画とコメント取得の両方が開始しました。");
    }
  }
  if (channel === "compose:status" && payload) {
    const progress = payload.state === "converting" ? 0 :
      payload.state === "progress" ? Number(payload.percent) || 0 :
      payload.state === "complete" ? 100 : Number(byId("compose-progress").value);
    setCompositionProgress(
      progress,
      payload.message || (payload.state === "converting" ? "MP4変換中…" : "")
    );
  }
  if (channel === "timeshift:comments-progress" && payload) {
    const count = Number(payload.eventCount) || 0;
    const segments = Number(payload.segmentsFetched) || 0;
    setCaptureText("live-meta", "過去コメント取得中：" + count.toLocaleString("ja-JP") +
      "件 / " + segments + "セグメント");
    byId("capture-status-detail").textContent = "タイムシフトの映像録画を継続しながら、過去コメントを取得しています。";
  }
  if (channel === "comments:exports" && payload && Array.isArray(payload.paths)) {
    addMonitorActivity("コメント形式の追加ファイルを保存しました：" + payload.paths.join(" / "));
  }
  if (channel === "ollama:setup-progress" && payload) {
    const message = byId("ollama-status-message");
    if (message) {
      if (payload.stage === "installer") {
        const received = (Number(payload.received) || 0) / 1024 / 1024;
        const total = (Number(payload.total) || 0) / 1024 / 1024;
        message.textContent = "Ollamaインストーラーをダウンロード中… " + received.toFixed(1) + " MB" + (total ? " / " + total.toFixed(1) + " MB（" + (Number(payload.percent) || 0) + "%）" : "");
      } else if (payload.stage === "model") {
        const completed = Number(payload.completed) || 0;
        const total = Number(payload.total) || 0;
        message.textContent = "モデル " + payload.model + " を取得中… " + (payload.status || "準備中") + (total ? "（" + Math.round(completed / total * 100) + "%）" : "");
      }
    }
  }
  if (channel === "whisper:download-progress" && payload) {
    const status = byId("manual-article-whisper-download-status");
    const stage = payload.stage === "runtime" ? "Whisper.cpp実行ファイル" : payload.stage === "model" ? "日本語モデル（ggml-base.bin）" : "セットアップ";
    if (payload.stage === "complete") status.textContent = "ダウンロード・検証・配置が完了しました。";
    else {
      const received = (Number(payload.received) || 0) / 1024 / 1024;
      const total = (Number(payload.total) || 0) / 1024 / 1024;
      status.textContent = stage + "をダウンロード中… " + received.toFixed(1) + " MB" + (total ? " / " + total.toFixed(1) + " MB（" + (Number(payload.percent) || 0) + "%）" : "");
    }
  }
  if (channel === "update:state") renderUpdateState(payload);
  if (channel === "streamlink:update-state") renderStreamlinkUpdateState(payload);
  if (channel === "monitor:state") renderMonitorState(payload);
  if (channel === "monitor:target-status") {
    monitorStatuses.set(payload.userId, payload);
    renderMonitorTargets();
    void refreshLiveArticlePreviews();
  }
  if (channel === "monitor:live-detected") handleMonitorLiveDetected(payload);
  if (channel === "articles:live-state" && payload) {
    const status = byId("manual-article-live-status");
    const frameCount = Number(payload.frameCount) || 0;
    if (payload.state === "capturing") {
      status.textContent = "生放送中：映像フレーム " + frameCount + "枚を保持中（" + (payload.videoSource === "streamlink" ? "配信ストリーム直接取得" : "視聴ページから取得") + "）。" + (payload.audioCapturing ? " Whisper.cppで音声も逐次解析中。" : "");
    } else if (payload.state === "generating") {
      status.textContent = "生放送中：コメント " + "と映像 " + frameCount + " 枚を使って記事を更新しています…" + (payload.audioCapturing ? " 音声も取得中です。" : "");
    } else if (payload.state === "updated") {
      status.textContent = payload.generated
        ? "生放送中：記事を更新しました。映像フレーム " + frameCount + " 枚を保持中。次回も約2分後に更新します。"
        : "生放送中：記事の材料を取得中です。コメント・番組情報が揃うと記事を生成します。";
    } else if (payload.state === "capture-error") {
      status.textContent = "映像フレームの取得に失敗しました：" + (payload.message || "不明なエラー") + "。コメント取得は継続します。";
    } else if (payload.state === "video-capturing") {
      status.textContent = "配信映像を直接取得中（15秒ごと）。" +
        (payload.audioCapturing ? "音声もWhisper.cpp用に取り込み中。" : "Whisper未設定のため音声解析は省略。") +
        "コメントも受信中です。";
    } else if (payload.state === "video-error" || payload.state === "video-warning") {
      status.textContent = "配信映像取得の注意：" + (payload.message || "ストリームを確認しています。");
    } else if (payload.state === "audio-capturing") {
      status.textContent = "生放送中：音声を約25秒ごとに分割し、Whisper.cppで逐次文字起こししています。";
    } else if (payload.state === "audio-transcribing") {
      status.textContent = "生放送の音声をWhisper.cppで日本語文字起こししています。完了した区間から記事へ反映します…";
    } else if (payload.state === "audio-progress") {
      status.textContent = "生放送中：音声をリアルタイム文字起こし中（" + (Number(payload.segmentCount) || 0) + "区間）。コメントも受信時に保存し、記事へ反映します。";
    } else if (payload.state === "audio-finalizing") {
      status.textContent = "音声の最後の区間を文字起こししています…";
    } else if (payload.state === "audio-complete") {
      status.textContent = "Whisper.cppの音声文字起こしが完了しました（" + (Number(payload.segmentCount) || 0) + "区間）。最終記事へ反映します。";
    } else if (payload.state === "audio-disabled") {
      status.textContent = payload.message || "Whisper.cpp未設定のため、生放送の音声解析はスキップします。映像とコメントの取得は継続します。";
    } else if (payload.state === "audio-error") {
      status.textContent = "生放送の音声解析に失敗しました：" + (payload.message || "不明なエラー") + "。映像とコメントの記事生成は継続します。";
    } else if (payload.state === "error") {
      status.textContent = "記事更新エラー：" + (payload.message || "不明なエラー") + "。次回更新時に再試行します。";
    }
  }
  if (channel === "articles:analysis-state" && payload) {
    const status = byId("manual-article-status");
    const stages = {
      starting: "録画の記事解析を準備中…",
      video: "録画映像を全体から抽出しています…",
      audio: "録画の音声を2分ごとに分割して文字起こししています…",
      ai: "映像・音声・コメントをOllamaで照合して記事を生成中…",
      complete: "録画の映像・音声・コメントを使った記事生成が完了しました。"
    };
    if (payload.state === "audio-progress") {
      status.textContent = "録画音声を文字起こし中：" + (Number(payload.processed) || 0) +
        " / " + (Number(payload.total) || 0) + "区間";
    } else if (payload.state === "error") {
      status.textContent = "録画記事の解析に失敗：" + (payload.message || "不明なエラー");
      addMonitorActivity(status.textContent, "error");
    } else if (stages[payload.state]) {
      status.textContent = stages[payload.state];
      if (payload.state === "complete" && !byId("articles-panel").hidden) loadBroadcastArticles();
    }
  }
  if (channel === "articles:generated") {
    void refreshLiveArticlePreviews(true);
    if (!byId("articles-panel").hidden) loadBroadcastArticles();
    const article = payload && payload.article;
    addMonitorActivity("放送記事を生成しました：" + (article && (article.programTitle || article.liveId) || ""));
  }
  if (channel === "articles:skipped" && payload && payload.reason) {
    addMonitorActivity("放送記事は生成対象外です：" + payload.reason);
  }
  if (channel === "monitor:error") addMonitorActivity(
    (payload.name || payload.userId || "ユーザー") + " の状態確認エラー：" + (payload.error || ""),
    "error"
  );
  if (channel === "auth:status") renderAuthStatus(payload);
  if (channel === "auth:expired") {
    const warning = byId("auth-session-warning");
    if (warning) { warning.hidden = false; warning.textContent = payload.message || "ニコニコのセッションが無効です。再ログインしてください。"; }
    showToast("ニコニコのセッションが期限切れです。設定から再ログインしてください。", true);
  }
  if (channel === "app:error") showToast(String(payload || "エラーが発生しました。"), true);
  });
} catch (error) {
  console.error("Nico Live Message Recorder event bridge initialization failed:", error);
  showToast("アプリ内部のイベント接続に失敗しました。アプリを再起動してください: " + (error.message || error), true);
}

// Register primary capture controls even if event subscription fails. This prevents
// one preload/event-listener error from aborting all subsequent button bindings.
// Primary capture controls are registered at the top of this file.
byId("record-mode").addEventListener("change", () => {
  const timeshift = byId("record-mode").value === "timeshift";
  byId("record-mode-hint").textContent = timeshift
    ? "視聴期限内で、ログイン中アカウントに視聴権限があるタイムシフトを最初から映像・音声と過去コメントを取得します。コメントAPIが利用できない場合も映像録画は継続します。"
    : "配信中の放送は映像・音声とコメントを同時に保存します。コメントだけ保存する場合は「コメントのみ接続」を選んでください。";
  recordButton.textContent = timeshift
    ? "● 過去配信（映像＋コメント）を録画"
    : "● 接続して映像・音声＋コメントを録画";
});
// The stop control is bound with the other primary buttons before optional initialization.
byId("check-update-button").addEventListener("click", checkAppUpdates);
byId("retry-update-download-button").addEventListener("click", retryAppUpdateDownload);
byId("settings-retry-update-download-button").addEventListener("click", retryAppUpdateDownload);
byId("update-releases-button").addEventListener("click", () => api.openGitHubReleases());
byId("install-update-button").addEventListener("click", installAppUpdate);
byId("settings-check-update-button").addEventListener("click", checkAppUpdates);
byId("open-github-releases-button").addEventListener("click", async () => {
  try {
    await api.openGitHubReleases();
  } catch (error) {
    showToast(`GitHub Releasesを開けませんでした: ${error.message}`, true);
  }
});
byId("settings-install-update-button").addEventListener("click", installAppUpdate);
byId("settings-button").addEventListener("click", openSettings);
byId("close-settings-button").addEventListener("click", closeSettings);
byId("cancel-settings-button").addEventListener("click", closeSettings);
byId("save-settings-button").addEventListener("click", saveSettings);
byId("ollama-check-button").addEventListener("click", () => void checkOllamaStatus());
byId("ollama-install-button").addEventListener("click", async () => {
  const button = byId("ollama-install-button");
  const message = byId("ollama-status-message");
  button.disabled = true;
  if (message) message.textContent = "公式Ollamaインストーラーをダウンロードしています…";
  try {
    const result = await api.downloadOllamaInstaller();
    if (message) message.textContent = "インストーラーを起動しました。画面の案内に沿ってインストールし、完了後に「Ollama接続を確認」を押してください。";
    showToast("Ollamaインストーラーを起動しました。");
  } catch (error) {
    if (message) message.textContent = error.message || "Ollamaのダウンロードに失敗しました。";
    showToast(message.textContent, true);
  } finally { button.disabled = false; }
});
byId("ollama-pull-model-button").addEventListener("click", async () => {
  const button = byId("ollama-pull-model-button");
  const model = byId("setting-ai-article-model").value.trim() || "qwen2.5:3b";
  const message = byId("ollama-status-message");
  button.disabled = true;
  if (message) message.textContent = model + " をダウンロードしています…";
  try {
    await api.pullOllamaModel(model);
    if (message) message.textContent = model + " のダウンロードが完了しました。";
    await checkOllamaStatus();
    showToast(model + " をOllamaに追加しました。");
  } catch (error) {
    if (message) message.textContent = error.message || "モデルのダウンロードに失敗しました。";
    showToast(message.textContent, true);
  } finally { button.disabled = false; }
});
byId("settings-modal").addEventListener("click", (event) => {
  if (event.target === byId("settings-modal")) closeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("settings-modal").hidden) closeSettings();
});
byId("monitor-add-button").addEventListener("click", addMonitorTarget);
byId("monitor-user-id").addEventListener("keydown", (event) => {
  if (event.key === "Enter") addMonitorTarget();
});
byId("monitor-start-button").addEventListener("click", startMonitor);
byId("monitor-stop-button").addEventListener("click", stopMonitor);

byId("live-preview-open-button").addEventListener("click", openLivePreview);
byId("live-preview-close-button").addEventListener("click", closeLivePreview);

byId("open-watch-button").addEventListener("click", async () => {
  const liveId = normalizeId(liveInput.value);
  if (!liveId) return showToast("放送IDまたは視聴URLを入力してください。", true);
  try { await api.openWatch(liveId); } catch (error) { showToast(error.message, true); }
});

byId("save-user-session-button").addEventListener("click", saveUserSession);
byId("clear-user-session-button").addEventListener("click", clearUserSession);
byId("check-auth-status-button").addEventListener("click", refreshAuthStatus);

byId("login-button").addEventListener("click", async () => {
  try {
    await api.openLogin();
    showToast("ログイン画面を開きました。ログイン完了後に状態が更新されます。");
  } catch (error) {
    showToast(error.message || "ログイン画面を開けませんでした。", true);
  }
});

document.querySelectorAll("[data-page-target]").forEach((button) => {
  button.addEventListener("click", () => setActivePage(button.dataset.pageTarget));
});
byId("sidebar-settings-button").addEventListener("click", openSettings);
byId("settings-open-updates-button").addEventListener("click", () => {
  closeSettings();
  setActivePage("updates");
});
byId("settings-check-update-button").addEventListener("click", checkAppUpdates);
byId("settings-install-update-button").addEventListener("click", installAppUpdate);
setActivePage("dashboard");
byId("library-refresh-button").addEventListener("click", loadCaptureLibrary);
byId("library-search").addEventListener("input", renderCaptureLibrary);
byId("library-filter").addEventListener("change", renderCaptureLibrary);
byId("articles-refresh-button").addEventListener("click", loadBroadcastArticles);
byId("manual-article-generate-button").addEventListener("click", generateManualBroadcastArticle);
byId("manual-article-video-select-button").addEventListener("click", selectManualArticleVideo);
byId("manual-article-whisper-auto-button").addEventListener("click", downloadArticleWhisper);
byId("manual-article-whisper-cli-button").addEventListener("click", selectArticleWhisperCli);
byId("manual-article-whisper-model-button").addEventListener("click", selectArticleWhisperModel);
byId("manual-article-live-start-button").addEventListener("click", startLiveArticleSession);
byId("manual-article-live-stop-button").addEventListener("click", stopLiveArticleSession);
byId("manual-article-file").addEventListener("change", () => {
  const file = byId("manual-article-file").files?.[0];
  byId("manual-article-file-name").textContent = file ? file.name + "（" + formatLibraryBytes(file.size) + "）" : "ファイル未選択。番組情報だけでも記事を生成できます。";
});
byId("articles-search").addEventListener("input", renderBroadcastArticles);
byId("articles-status-filter").addEventListener("change", renderBroadcastArticles);
byId("articles-sort").addEventListener("change", renderBroadcastArticles);
byId("library-open-folder-button").addEventListener("click", async () => {
  try {
    const result = await api.openDataFolder();
    if (result.error) showToast(result.error, true);
  } catch (error) {
    showToast(error.message || "保存フォルダーを開けませんでした。", true);
  }
});

byId("test-ass-ng-button").addEventListener("click", async () => {
  const button = byId("test-ass-ng-button");
  const output = byId("ass-ng-test-result");
  button.disabled = true;
  output.dataset.state = "checking";
  output.textContent = "NGワードを判定中…";
  try {
    const result = await api.testAssNgRegex({
      ngRegex: byId("ass-ng-regex").value,
      sample: byId("ass-ng-test-comment").value
    });
    output.dataset.state = result.matched ? "match" : "pass";
    const details = Array.isArray(result.matches)
      ? result.matches.map(match => match.lineNumber + "行目「" + match.pattern + "」").join("、")
      : "";
    output.textContent = result.matched
      ? "NG対象：ASSには出力されません。（一致：" + details + "）"
      : "NG対象外：このコメントはASSに出力されます。" +
          (result.ruleCount ? "（適用ルール " + result.ruleCount + "件）" : "（NGルール未設定）");
  } catch (error) {
    output.dataset.state = "error";
    output.textContent = "NG判定エラー：" + (error.message || String(error));
  } finally {
    button.disabled = false;
  }
});

for (const prefix of ["ass-", "setting-ass-"]) {
  for (const [, id] of ASS_MOTION_FIELDS) {
    byId(prefix + id).addEventListener("input", () => refreshAssMotionLabels(prefix));
  }
  byId(prefix + "auto-motion").addEventListener("change", () => refreshAssMotionLabels(prefix));
  refreshAssMotionLabels(prefix);
}

byId("reset-ass-motion-button").addEventListener("click", () => {
  applyAssMotionInputs("ass-", {
    assAutoMotion: true,
    assScrollSpeed: 360,
    assEntryOffset: 0,
    assScrollLanes: 18,
    assFixedDuration: 5,
    assPreventOverlap: true
  });
  showToast("ニコ生風の自動調整をONに戻しました。保存する場合は「流れ方の設定を保存」を押してください。");
});

byId("save-ass-motion-button").addEventListener("click", async () => {
  const button = byId("save-ass-motion-button");
  button.disabled = true;
  try {
    applyMonitorState(await api.saveMonitorSettings(readAssMotionInputs("ass-")));
    applyAssMotionInputs("setting-ass-", monitorSettings);
    showToast("ASSの流れ方を保存しました。録画後の自動ASS作成にも適用します。");
  } catch (error) {
    showToast(error.message || "ASS表示設定を保存できませんでした。", true);
  } finally {
    button.disabled = false;
  }
});

byId("save-ass-ng-button").addEventListener("click", async () => {
  const button = byId("save-ass-ng-button");
  button.disabled = true;
  try {
    applyMonitorState(await api.saveMonitorSettings({
      assNgRegex: byId("ass-ng-regex").value
    }));
    byId("setting-ass-ng-regex").value = monitorSettings.assNgRegex || "";
    showToast("ASS用のNGワード（正規表現）を保存しました。自動ASS作成にも適用されます。");
  } catch (error) {
    showToast(error.message || "NGワード設定を保存できませんでした。", true);
  } finally {
    button.disabled = false;
  }
});

byId("export-ass-button").addEventListener("click", async () => {
  const button = byId("export-ass-button");
  button.disabled = true;
  try {
    const result = await api.exportAss({ ngRegex: byId("ass-ng-regex").value, ...readAssMotionInputs("ass-") });
    if (result.cancelled) return;
    const autoSummary = byId("ass-auto-motion").checked
      ? "、自動調整 " + (result.automaticallyAdjustedCount || 0) + "件" +
        ((result.automaticallyDeferredCount || 0) ? "（混雑による時間調整 " + result.automaticallyDeferredCount + "件）" : "")
      : "";
    showToast("ASSを書き出しました（" + result.commentCount + "件、NG除外 " +
      (result.filteredCount || 0) + "件" + autoSummary + "）: " + result.path);
  } catch (error) {
    showToast(error.message || "ASSを書き出せませんでした。", true);
  } finally {
    button.disabled = false;
  }
});

byId("export-button").addEventListener("click", async () => {
  try {
    const result = await api.exportCsv();
    if (result.cancelled) return;
    showToast("CSVを書き出しました: " + result.path);
  } catch (error) {
    showToast(error.message || "CSVを書き出せませんでした。", true);
  }
});

liveInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectLive();
});

(async function initialize() {
  try {
    const version = await api.getVersion();
    const text = "v" + version;
    byId("version").textContent = text;
    byId("build-version").textContent = version;
    byId("footer-version").textContent = text;
    byId("app-current-version").textContent = text;
  } catch (_) {}
  await loadReleaseHistory();
  await refreshAuthStatus();
  await refreshVideoTools();
  await refreshMonitorState();
  renderLiveBroadcasts();
  renderDashboardStats();
  setConnection("disconnected");
})();

window.setInterval(updateLiveElapsedLabels, 1000);

// ---------------------------------------------------------------------------
// Comment video composition (canvas overlay + browser MediaRecorder)
// ---------------------------------------------------------------------------

let cancelActiveComposition = null;

function compositionCommands(mail) {
  return String(mail || "").toLowerCase().split(/\s+/).filter(Boolean);
}

function reserveOverlayLane(lanes, startMs, durationMs, gapMs) {
  return window.nicoCommentComposition.reserveLane(lanes, startMs, durationMs, gapMs);
}

function createCommentOverlaySchedule(comments, context, width, height, options = {}) {
  const fontScale = Math.min(2, Math.max(0.5, Number(options.fontScale) || 1));
  const baseFontSize = Math.max(18, Math.min(96, Number(options.baseFontSize) || 64));
  const speed = Math.min(2.5, Math.max(0.3, Number(options.speed) || 1));
  const pixelsPerSecond = Math.max(80, Math.min(1000, Number(options.scrollSpeedPxPerSecond) || 330)) * speed;
  const marginPercent = Math.min(25, Math.max(4, Number(options.marginPercent) || 7));
  const displayMode = ["all", "scroll", "fixed", "top", "bottom"].includes(options.displayMode) ? options.displayMode : "all";
  const colorMode = ["original", "white", "green"].includes(options.colorMode) ? options.colorMode : "original";
  const outlineWidth = Math.max(0, Math.min(12, Number(options.outlineWidth) || 0));
  const baseSize = Math.max(12, Math.min(110,
    Math.round((height / 1080) * baseFontSize * fontScale)));
  const overlapProtection = options.overlapProtection !== false;
  const laneGapMs = Math.max(0, Math.min(500, Number(options.laneGapMs ?? 160)));
  const layout = window.nicoCommentComposition.calculateCommentLaneLayout({
    height,
    baseFontSize: baseSize,
    outlineWidth,
    marginPercent,
    rowLimit: options.rowLimit
  });
  const scrollLanes = Array(layout.scrollLaneCount).fill(0);
  const topLanes = Array(layout.fixedLaneCount).fill(0);
  const bottomLanes = Array(layout.fixedLaneCount).fill(0);
  let scrollSequence = 0;
  let topSequence = 0;
  let bottomSequence = 0;
  const allocateLane = (lanes, requestedStart, duration, sequence) => {
    if (overlapProtection) {
      return reserveOverlayLane(lanes, requestedStart, duration, laneGapMs);
    }
    const lane = sequence % lanes.length;
    return { lane, startMs: requestedStart, endMs: requestedStart + duration };
  };
  const fixedDurationMs = Number(options.durationSeconds) > 0
    ? Math.max(1000, Math.min(30000, Number(options.durationSeconds) * 1000))
    : 0;
  const schedule = [];

  for (const comment of comments) {
    const commands = compositionCommands(comment.mail);
    const isTop = commands.includes("ue") || commands.includes("top");
    const isBottom = commands.includes("shita") || commands.includes("bottom");
    const isFixed = isTop || isBottom;
    if (displayMode === "scroll" && isFixed) continue;
    if (displayMode === "fixed" && !isFixed) continue;
    if (displayMode === "top" && !isTop) continue;
    if (displayMode === "bottom" && !isBottom) continue;

    let fontSize = baseSize;
    if (commands.includes("big")) fontSize = Math.min(120, Math.round(baseSize * 1.22));
    if (commands.includes("small")) fontSize = Math.max(10, Math.round(baseSize * 0.78));

    const colorMap = {
      white: "#ffffff",
      red: "#ff0000",
      pink: "#ff8080",
      orange: "#ffcc00",
      yellow: "#ffff00",
      green: "#00ff00",
      cyan: "#00ffff",
      blue: "#0000ff",
      purple: "#cc00ff",
      black: "#000000",
      white2: "#cccc99",
      niconicowhite: "#cccc99",
      red2: "#cc0033",
      truered: "#cc0033",
      pink2: "#ff33cc",
      orange2: "#ff6600",
      passionorange: "#ff6600",
      yellow2: "#999900",
      madyellow: "#999900",
      green2: "#00cc66",
      elementalgreen: "#00cc66",
      cyan2: "#00cccc",
      blue2: "#33fffc",
      marineblue: "#33fffc",
      purple2: "#6633cc",
      nobleviolet: "#6633cc",
      black2: "#333333"
    };
    const explicitHex = commands.find((command) => /^#[0-9a-f]{6}$/i.test(command));
    const originalColor = explicitHex || commands.map((command) => colorMap[command]).find(Boolean) || "#ffffff";
    const color = colorMode === "green" ? "#55e58a" :
      colorMode === "white" ? "#ffffff" : originalColor;
    const fontFamily = ["ＭＳ Ｐゴシック", "Meiryo", "Yu Gothic UI", "BIZ UDPGothic", "Arial"].includes(options.fontFamily)
      ? options.fontFamily : "ＭＳ Ｐゴシック";
    context.font = "bold " + fontSize + "px \"" + fontFamily + "\", sans-serif";
    const displayText = window.nicoCommentComposition.normalizeCommentDisplayText(comment.text);
    if (!displayText) continue;
    const textWidth = Math.ceil(context.measureText(displayText).width) + 20;
    const startMs = comment.timeMs;

    if (isFixed) {
      const lanes = isTop ? topLanes : bottomLanes;
      const durationMs = fixedDurationMs || 3000;
      const reservation = allocateLane(lanes, startMs, durationMs, isTop ? topSequence++ : bottomSequence++);
      const lane = reservation.lane;
      const y = isTop ? layout.topLaneYs[lane] : layout.bottomLaneYs[lane];
      schedule.push({
        ...comment, text: displayText, startMs: reservation.startMs, endMs: reservation.endMs, fontSize, color,
        textWidth, mode: isTop ? "top" : "bottom", y
      });
      continue;
    }

    // Saccubus-style explicit pixel/second control keeps comment motion predictable.
    const durationMs = fixedDurationMs || Math.max(1500, Math.min(32000,
      ((width + textWidth) / pixelsPerSecond) * 1000));
    const headwayMs = window.nicoCommentComposition.calculateScrollCommentHeadway(
      width, textWidth, durationMs
    );
    const reservation = allocateLane(scrollLanes, startMs, headwayMs, scrollSequence++);
    const lane = reservation.lane;
    const y = layout.scrollLaneYs[lane];
    schedule.push({
      ...comment,
      text: displayText,
      startMs: reservation.startMs,
      endMs: reservation.startMs + durationMs,
      fontSize, color, textWidth, mode: "scroll", y
    });
  }

  return schedule.sort((a, b) => a.startMs - b.startMs);
}

function drawCommentOverlay(context, schedule, activeComments, videoTimeMs, width, height, options = {}) {
  // The base video frame has already been drawn to this canvas. Preserve it so the overlay stays transparent.
  context.globalAlpha = Math.min(1, Math.max(0.2, Number(options.opacity) || 1));
  const shadow = options.shadow !== false;
  const outlineWidth = Math.max(0, Math.min(12, Number(options.outlineWidth) || 0));
  const fontFamily = ["ＭＳ Ｐゴシック", "Meiryo", "Yu Gothic UI", "BIZ UDPGothic", "Arial"].includes(options.fontFamily)
    ? options.fontFamily : "ＭＳ Ｐゴシック";
  for (const comment of activeComments) {
    if (videoTimeMs < comment.startMs || videoTimeMs > comment.endMs) continue;
    const elapsed = videoTimeMs - comment.startMs;
    context.font = "bold " + comment.fontSize + "px \"" + fontFamily + "\", sans-serif";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = outlineWidth;
    context.strokeStyle = "rgba(0, 0, 0, 0.92)";
    context.fillStyle = comment.color;
    context.shadowColor = shadow ? "rgba(0, 0, 0, 0.65)" : "transparent";
    context.shadowBlur = shadow ? 3 : 0;

    let x;
    if (comment.mode === "scroll") {
      const ratio = Math.min(1, Math.max(0, elapsed / (comment.endMs - comment.startMs)));
      x = width - ratio * (width + comment.textWidth);
      context.textAlign = "left";
    } else {
      x = width / 2;
      context.textAlign = "center";
    }

    if (outlineWidth > 0) {
      context.strokeText(comment.text, x, comment.y, Math.max(width * 2, comment.textWidth + 40));
    }
    context.fillText(comment.text, x, comment.y, Math.max(width * 2, comment.textWidth + 40));
  }
  context.shadowBlur = 0;
  context.globalAlpha = 1;
}

function setComposePreviewStatus(message, isError = false) {
  const status = byId("compose-preview-status");
  if (status) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }
}

function calculateCompositionOutputSize(sourceWidth, sourceHeight, options = {}) {
  const width = Math.max(2, Number(sourceWidth) || 1920);
  const height = Math.max(2, Number(sourceHeight) || 1080);
  const customWidth = Math.max(0, Number(options.outputWidth) || 0);
  const customHeight = Math.max(0, Number(options.outputHeight) || 0);
  let outputWidth;
  let outputHeight;
  if (customWidth > 0 || customHeight > 0) {
    const requestedWidth = customWidth > 0 ? customWidth : width;
    const requestedHeight = customHeight > 0 ? customHeight : height;
    if (options.keepAspect !== false) {
      const scale = Math.min(requestedWidth / width, requestedHeight / height);
      outputWidth = Math.max(2, Math.round(width * scale / 2) * 2);
      outputHeight = Math.max(2, Math.round(height * scale / 2) * 2);
    } else {
      outputWidth = Math.max(2, Math.round(requestedWidth / 2) * 2);
      outputHeight = Math.max(2, Math.round(requestedHeight / 2) * 2);
    }
  } else {
    const targetHeight = options.resolution === "original" || !options.resolution ? height : Number(options.resolution);
    const scale = Math.min(1, targetHeight / height);
    outputWidth = Math.max(2, Math.round(width * scale / 2) * 2);
    outputHeight = Math.max(2, Math.round(height * scale / 2) * 2);
  }
  return { width: outputWidth, height: outputHeight };
}

function drawComposePreviewFrame() {
  const video = byId("compose-preview-video");
  const canvas = byId("compose-preview-canvas");
  if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
  const outputSize = calculateCompositionOutputSize(video.videoWidth, video.videoHeight, getCompositionEditorOptions());
  if (canvas.width !== outputSize.width || canvas.height !== outputSize.height) {
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const currentMs = video.currentTime * 1000;
  const active = composePreviewSchedule.filter(comment => comment.startMs <= currentMs && comment.endMs >= currentMs);
  drawCommentOverlay(context, composePreviewSchedule, active, currentMs, canvas.width, canvas.height, getCompositionEditorOptions());
}

async function refreshComposePreview() {
  const video = byId("compose-preview-video");
  const canvas = byId("compose-preview-canvas");
  const videoFile = byId("compose-video-input")?.files?.[0];
  const commentsFile = byId("compose-comments-input")?.files?.[0];
  composePreviewSchedule = [];
  if (!videoFile || !commentsFile || !video || !canvas || !video.videoWidth || !video.duration) {
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setComposePreviewStatus(!videoFile ? "動画を選択してください" : !commentsFile ? "コメントログを選択してください" : "プレビュー準備中");
    return;
  }
  try {
    const records = parseJsonlFile(await commentsFile.text());
    const timeline = window.nicoCommentComposition.prepareCommentTimeline(records, video.duration * 1000);
    const options = getCompositionEditorOptions();
    const adjusted = timeline.comments.map(comment => ({ ...comment, timeMs: comment.timeMs + options.offsetMs }))
      .filter(comment => comment.timeMs >= 0 && comment.timeMs <= video.duration * 1000)
      .filter(comment => !options.ngWords.some(word => word && String(comment.text || "").toLocaleLowerCase("ja-JP").includes(word)));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("プレビュー用キャンバスを作成できません。");
    const outputSize = calculateCompositionOutputSize(video.videoWidth, video.videoHeight, options);
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    composePreviewSchedule = createCommentOverlaySchedule(adjusted, context, canvas.width, canvas.height, options)
      .filter(comment => comment.startMs < video.duration * 1000 && comment.endMs > 0);
    drawComposePreviewFrame();
    setComposePreviewStatus(`${composePreviewSchedule.length.toLocaleString("ja-JP")}件のコメントをプレビュー中${timeline.usedFallbackOrigin ? "（開始時刻を推定）" : ""}`);
  } catch (error) {
    composePreviewSchedule = [];
    setComposePreviewStatus(error.message || "プレビューを作成できませんでした。", true);
  }
}

function scheduleComposePreviewRefresh() {
  window.clearTimeout(scheduleComposePreviewRefresh.timer);
  scheduleComposePreviewRefresh.timer = window.setTimeout(() => { void refreshComposePreview(); }, 120);
}

function setCompositionProgress(value, label) {
  const progress = byId("compose-progress");
  if (progress) progress.value = Math.max(0, Math.min(100, Number(value) || 0));
  const status = byId("compose-progress-label");
  if (status) status.textContent = label || "";
}

function parseJsonlFile(text) {
  const parser = window.nicoCommentComposition?.parseCommentJsonlText;
  if (typeof parser !== "function") {
    throw new Error("コメントログ読み込みモジュールを読み込めませんでした。");
  }
  const records = parser(text);
  if (!records.length) {
    throw new Error("コメントログから有効なJSONレコードを読み取れませんでした。JSONL形式のコメントファイルを選択してください。");
  }
  return records;
}

async function composeCommentVideo() {
  const videoFile = byId("compose-video-input").files[0];
  const commentsFile = byId("compose-comments-input").files[0];
  if (!videoFile || !commentsFile) {
    showToast("録画動画とコメントログの両方を選択してください。", true);
    return;
  }
  if (typeof window.nicoCommentComposition?.prepareCommentTimeline !== "function") {
    showToast("動画合成モジュールを読み込めませんでした。", true);
    return;
  }
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
    showToast("この環境では動画合成に対応していません。", true);
    return;
  }

  const composeOptions = getCompositionEditorOptions();
  const composeButton = byId("compose-button");
  const cancelButton = byId("compose-cancel-button");
  composeButton.disabled = true;
  cancelButton.disabled = true;
  setCompositionProgress(0, "素材を読み込み中…");

  let videoElement = null;
  let objectUrl = null;
  let canvasStream = null;
  let finalStream = null;
  let audioContext = null;
  let recorder = null;
  let animationFrame = 0;
  let outputStarted = false;
  let cancelRequested = false;
  let writeError = null;
  let chunkQueue = Promise.resolve();

  const cleanup = async () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (videoElement) {
      videoElement.pause();
      videoElement.removeAttribute("src");
      videoElement.load();
      videoElement.remove();
    }
    if (finalStream) finalStream.getTracks().forEach((track) => track.stop());
    if (canvasStream) canvasStream.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => {});
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    cancelActiveComposition = null;
    composeButton.disabled = false;
    cancelButton.disabled = true;
  };

  cancelActiveComposition = () => {
    cancelRequested = true;
    cancelButton.disabled = true;
    setCompositionProgress(
      Number(byId("compose-progress").value),
      "キャンセル処理中…"
    );
    if (videoElement) videoElement.pause();
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  try {
    const jsonl = await commentsFile.text();
    const records = parseJsonlFile(jsonl);

    videoElement = document.createElement("video");
    videoElement.preload = "auto";
    videoElement.playsInline = true;
    videoElement.style.position = "fixed";
    videoElement.style.left = "-10000px";
    videoElement.style.top = "0";
    videoElement.style.width = "2px";
    videoElement.style.height = "2px";
    videoElement.style.opacity = "0";
    document.body.appendChild(videoElement);

    objectUrl = URL.createObjectURL(videoFile);
    videoElement.src = objectUrl;

    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("動画ファイルの読み込みがタイムアウトしました。")), 30000);
      videoElement.addEventListener("loadedmetadata", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      videoElement.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("動画を読み込めません。WebMまたはMP4を選択してください。"));
      }, { once: true });
      videoElement.load();
    });

    const durationMs = Number.isFinite(videoElement.duration) ? videoElement.duration * 1000 : 0;
    if (durationMs <= 0) throw new Error("動画の長さを取得できませんでした。");

    const timeline = window.nicoCommentComposition.prepareCommentTimeline(records, durationMs);
    if (!timeline.comments.length) throw new Error("動画の時間範囲内に表示できるコメントがありません。");
    if (timeline.usedFallbackOrigin) {
      showToast("録画開始マーカーがないログです。最初のコメントを動画の0秒として扱います。", true);
    }

    const canvas = document.createElement("canvas");
    const sourceWidth = videoElement.videoWidth || 1920;
    const sourceHeight = videoElement.videoHeight || 1080;
    const outputSize = calculateCompositionOutputSize(sourceWidth, sourceHeight, composeOptions);
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("動画合成用キャンバスを作成できません。");
    const ngWords = composeOptions.ngWords;
    const adjustedComments = timeline.comments.map((comment) => ({
      ...comment,
      timeMs: comment.timeMs + composeOptions.offsetMs
    })).filter((comment) => {
      if (comment.timeMs > durationMs) return false;
      const text = String(comment.text || "").toLocaleLowerCase("ja-JP");
      return !ngWords.some((word) => word && text.includes(word));
    });
    const schedule = createCommentOverlaySchedule(
      adjustedComments, context, canvas.width, canvas.height, composeOptions
    ).filter(comment => comment.startMs < durationMs && comment.endMs > 0);
    if (!schedule.length) throw new Error("現在の表示設定に一致するコメントがありません。");

    canvasStream = canvas.captureStream(composeOptions.fps);
    const audioTracks = [];
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        audioContext = new AudioContextClass();
        const source = audioContext.createMediaElementSource(videoElement);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        await audioContext.resume();
        audioTracks.push(...destination.stream.getAudioTracks());
      } catch (audioError) {
        console.warn("Audio track composition unavailable:", audioError);
        if (audioContext && audioContext.state !== "closed") {
          await audioContext.close().catch(() => {});
        }
        audioContext = null;
        showToast("音声合成を利用できないため、映像のみで生成します。");
      }
    }

    finalStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks
    ]);
    if (!finalStream.getVideoTracks().length) throw new Error("合成動画の映像トラックを作成できません。");

    const mimeTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm"
    ];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("この環境で利用できるWebMエンコーダーがありません。");

    const output = await api.startCompose({
      format: composeOptions.outputFormat,
      quality: composeOptions.outputQuality,
      durationMs
    });
    if (output.cancelled) {
      setCompositionProgress(0, "保存先の選択をキャンセルしました");
      await cleanup();
      return;
    }
    outputStarted = true;

    let nextCommentIndex = 0;
    let activeComments = [];
    let lastProgressUpdate = 0;

    const drawFrame = () => {
      if (!videoElement || videoElement.readyState < 2) {
        animationFrame = requestAnimationFrame(drawFrame);
        return;
      }
      const currentMs = videoElement.currentTime * 1000;
      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

      while (nextCommentIndex < schedule.length && schedule[nextCommentIndex].startMs <= currentMs) {
        activeComments.push(schedule[nextCommentIndex]);
        nextCommentIndex += 1;
      }
      activeComments = activeComments.filter((comment) => comment.endMs >= currentMs);
      drawCommentOverlay(context, schedule, activeComments, currentMs, canvas.width, canvas.height, composeOptions);

      const now = Date.now();
      if (now - lastProgressUpdate >= 250) {
        const percent = Math.min(100, (currentMs / durationMs) * 100);
        setCompositionProgress(percent, "合成中 " + Math.floor(percent) + "%");
        lastProgressUpdate = now;
      }
      if (!videoElement.paused && !videoElement.ended && !cancelRequested) {
        animationFrame = requestAnimationFrame(drawFrame);
      }
    };

    const recorderOptions = { mimeType, videoBitsPerSecond: composeOptions.bitrate };
    if (audioTracks.length) recorderOptions.audioBitsPerSecond = 160000;
    recorder = new MediaRecorder(finalStream, recorderOptions);
    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      const chunk = event.data;
      chunkQueue = chunkQueue.then(async () => {
        await api.writeComposeChunk(await chunk.arrayBuffer());
      }).catch((error) => {
        writeError = error;
        cancelRequested = true;
        if (recorder && recorder.state !== "inactive") recorder.stop();
      });
    };

    const stopResultPromise = new Promise((resolve) => {
      recorder.onstop = async () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        cancelButton.disabled = true;
        try {
          await chunkQueue;
          if (writeError) throw writeError;
          if (cancelRequested) {
            await api.cancelCompose();
            resolve({ cancelled: true });
          } else {
            const saved = await api.finishCompose();
            resolve(saved);
          }
        } catch (error) {
          try { await api.cancelCompose(); } catch (_) {}
          resolve({ error });
        }
      };
    });

    recorder.onerror = (event) => {
      writeError = event.error || new Error("動画のエンコード中にエラーが発生しました。");
      cancelRequested = true;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };

    videoElement.addEventListener("ended", () => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    }, { once: true });

    recorder.start(1000);
    cancelButton.disabled = false;
    await videoElement.play();
    drawFrame();

    setCompositionProgress(0, "合成を開始しました");
    const stopResult = await stopResultPromise;
    outputStarted = false;

    if (stopResult.error) throw stopResult.error;
    if (stopResult.cancelled) {
      setCompositionProgress(0, "生成をキャンセルしました");
      showToast("コメント付き動画の生成をキャンセルしました。");
    } else if (stopResult.warning) {
      setCompositionProgress(100, "WebMで保存（MP4変換不可）");
      showToast("MP4変換ができなかったためWebMで保存しました: " + stopResult.path, true);
    } else {
      setCompositionProgress(100, stopResult.format === "mp4" ? "MP4生成完了" : "WebM生成完了");
      showToast((stopResult.format === "mp4" ? "MP4" : "WebM") + "のコメント付き動画を保存しました: " + stopResult.path);
    }
  } catch (error) {
    if (recorder && recorder.state !== "inactive") {
      cancelRequested = true;
      recorder.stop();
    }
    if (outputStarted) {
      await chunkQueue.catch(() => {});
      await api.cancelCompose().catch(() => {});
    }
    setCompositionProgress(0, "エラー");
    showToast(error.message || "コメント付き動画を生成できませんでした。", true);
  } finally {
    await cleanup();
  }
}

for (const id of ["compose-font-scale", "compose-font-size", "compose-speed", "compose-position", "compose-opacity", "compose-offset", "compose-outline", "compose-lane-gap"]) {
  byId(id).addEventListener("input", updateCompositionEditorLabels);
}
updateCompositionEditorLabels();

byId("compose-nico-preset").addEventListener("click", applyNicoCommentPreset);
byId("compose-video-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const video = byId("compose-preview-video");
  byId("compose-video-name").textContent = file ? file.name : "WebM / MP4動画を選択";
  if (composePreviewUrl) URL.revokeObjectURL(composePreviewUrl);
  composePreviewUrl = file ? URL.createObjectURL(file) : null;
  video.pause();
  video.removeAttribute("src");
  if (composePreviewUrl) video.src = composePreviewUrl;
  video.load();
  byId("compose-preview-empty").hidden = Boolean(file);
  scheduleComposePreviewRefresh();
});

byId("compose-comments-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("compose-comments-name").textContent = file ? file.name : "JSONLコメントログを選択";
  scheduleComposePreviewRefresh();
});

byId("compose-preview-video").addEventListener("loadedmetadata", scheduleComposePreviewRefresh);
byId("compose-preview-video").addEventListener("timeupdate", drawComposePreviewFrame);
byId("compose-preview-video").addEventListener("seeked", drawComposePreviewFrame);
byId("compose-preview-video").addEventListener("play", () => {
  const tick = () => {
    drawComposePreviewFrame();
    const video = byId("compose-preview-video");
    if (video && !video.paused && !video.ended) composePreviewFrame = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(composePreviewFrame);
  composePreviewFrame = requestAnimationFrame(tick);
});
byId("compose-preview-video").addEventListener("pause", () => cancelAnimationFrame(composePreviewFrame));
for (const id of ["compose-font-scale", "compose-font-size", "compose-speed", "compose-pixels-per-second", "compose-position", "compose-opacity", "compose-offset", "compose-outline", "compose-lane-gap", "compose-row-limit", "compose-duration", "compose-display-mode", "compose-font-family", "compose-color-mode", "compose-overlap-protection", "compose-shadow", "compose-ng-words", "compose-resolution", "compose-width", "compose-height", "compose-keep-aspect"]) {
  byId(id).addEventListener("input", scheduleComposePreviewRefresh);
  byId(id).addEventListener("change", scheduleComposePreviewRefresh);
}

byId("compose-button").addEventListener("click", composeCommentVideo);
byId("compose-cancel-button").addEventListener("click", () => {
  if (cancelActiveComposition) cancelActiveComposition();
});
