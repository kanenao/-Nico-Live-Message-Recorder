const api = window.nicoAPI;
const byId = (id) => document.getElementById(id);

const liveInput = byId("live-id");
const connectButton = byId("connect-button");
const disconnectButton = byId("disconnect-button");
const recordButton = byId("record-button");
const stopRecordButton = byId("stop-record-button");
const commentList = byId("comment-list");

let connected = false;
let recordStartedAt = 0;
let recordClock = null;
let currentLiveId = "";
let currentProgramMetadata = {};
let currentCaptureTarget = null;
let commentCaptureState = "disconnected";
let videoCaptureState = "idle";
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
const monitorHandledDetections = new Set();
let monitorIsRunning = false;
const monitorAutoQueue = [];
let monitorAutoProcessing = false;
let captureLibraryItems = [];

function showToast(message, isError) {
  const toast = byId("toast");
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
  badge.classList.remove("online", "busy", "failed");
  commentCaptureState = ["connected", "connecting", "error"].includes(state) ? state : "disconnected";
  if (state === "connected") {
    badge.classList.add("online");
    text.textContent = "コメント受信中";
    connected = true;
  } else if (state === "connecting") {
    badge.classList.add("busy");
    text.textContent = "接続中";
    connected = false;
  } else if (state === "error") {
    badge.classList.add("failed");
    text.textContent = "接続エラー";
    connected = false;
  } else {
    text.textContent = label || "未接続";
    connected = false;
  }
  connectButton.disabled = state === "connecting" || state === "connected";
  disconnectButton.disabled = state !== "connected" && state !== "connecting";
  updateCaptureIndicators();
}

function normalizeId(value) {
  const match = String(value || "").trim().match(/(?:lv)?(\d{5,})/i);
  return match ? "lv" + match[1] : "";
}

function clearComments() {
  commentList.replaceChildren();
  commentCount = 0;
  eventCount = 0;
  displayedComments = 0;
  byId("comment-count").textContent = "0";
  byId("event-count").textContent = "0";
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
  byId("event-count").textContent = eventCount.toLocaleString("ja-JP");
  if (record.type === "comment") {
    commentCount += 1;
    byId("comment-count").textContent = commentCount.toLocaleString("ja-JP");
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
  commentList.appendChild(row);
  displayedComments += 1;

  if (displayedComments > 1500) {
    commentList.firstElementChild.remove();
    displayedComments -= 1;
  }
  commentList.scrollTop = commentList.scrollHeight;
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

  byId("session-current-title").textContent = title || (liveId
    ? "番組情報を取得しています…"
    : "放送IDを入力すると番組情報が表示されます");
  byId("session-current-broadcaster").textContent = "配信者：" + (broadcaster || "未取得");
  byId("session-current-live-id").textContent = "放送ID：" + (liveId || "未入力");
  byId("session-current-started-at").textContent = "開始：" + (startedAt ? formatBroadcastStart(startedAt) : "未取得");
  byId("session-current-viewers").textContent = "来場者：" +
    (viewerCount == null || !Number.isFinite(Number(viewerCount)) ? "未取得" : Number(viewerCount).toLocaleString("ja-JP"));
  byId("session-current-status").textContent = captureState;
  byId("session-current-status").dataset.state = videoCaptureState;
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
  const viewerCount = readValue(["viewerCount", "viewers", "watchCount", "currentViewers", "totalViewers"]);
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
  byId("live-title").textContent = currentProgramMetadata.title || "番組タイトルを取得できませんでした";
  const status = String(readValue(["status"]) || "").trim();
  byId("live-meta").textContent = (currentProgramMetadata.broadcasterName || "放送者情報なし") +
    (status ? " ・ " + status : "");
  renderSessionProgramInfo();
  renderLiveBroadcasts();
}

async function refreshAuthStatus() {
  try {
    const status = await api.getAuthStatus();
    byId("login-state").textContent = status.loggedIn ? "ログイン済み" : "未ログイン";
    byId("login-state").className = "login-state " + (status.loggedIn ? "is-logged-in" : "");
  } catch (_) {
    byId("login-state").textContent = "状態を確認できません";
  }
}

async function connectLive() {
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
  byId("live-title").textContent = "番組情報を取得中…";
  byId("live-meta").textContent = "コメントサーバーに接続しています";
  try {
    const result = await api.connectLive(liveId);
    updateMetadata(result.metadata);
    byId("comment-file").textContent = "コメント：" + result.commentFile;
    setConnection("connected");
    showToast("コメント取得を開始しました。");
  } catch (error) {
    setConnection("error");
    showToast(error.message || "コメント接続に失敗しました。", true);
  }
}

async function disconnectLive() {
  try {
    await api.disconnectLive();
    setConnection("disconnected");
    showToast("コメント取得を停止しました。");
  } catch (error) {
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
  if (recordButton.disabled || recordStartedAt || monitorAutoProcessing) {
    showToast("別の配信を録画中、または録画準備中です。終了後に開始してください。", true);
    return;
  }
  const liveId = normalizeId(selectedTarget ? selectedTarget.liveId : (liveInput.value || currentLiveId));
  if (!liveId) {
    showToast("先に放送IDを入力してください。", true);
    return;
  }

  const timeshift = !selectedTarget && byId("record-mode")?.value === "timeshift";
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
    byId("live-title").textContent = selectedTarget.title || "番組情報を取得中…";
    byId("live-meta").textContent = (selectedTarget.name || "登録配信者") +
      " · " + liveId + " · LIVE一覧から録画開始";
  }
  renderSessionProgramInfo();
  recordButton.disabled = true;
  renderLiveBroadcasts();
  if (!(connected && currentLiveId === liveId)) setConnection("connecting");
  try {
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
      result = await api.startCapture(liveId, quality, selectedTarget ? {
        displayName: selectedTarget.name || "",
        broadcasterId: selectedTarget.userId || ""
      } : {});
    }
    if (result.comment && result.comment.metadata) updateMetadata(result.comment.metadata);
    if (result.comment && result.comment.commentFile) {
      byId("comment-file").textContent = "コメント：" + result.comment.commentFile;
    }
    if (result.commentsConnected) {
      setConnection("connected");
    } else if (!timeshift) {
      setConnection("error");
    }

    const video = result.video || {};
    byId("video-file").textContent = "保存先：" + (video.path || "");
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
    } else if (result.commentError) {
      showToast("映像録画は開始しましたが、コメント取得に失敗しました: " + result.commentError, true);
    } else {
      showToast("映像録画とコメント取得を同時に開始しました。");
    }
  } catch (error) {
    currentCaptureTarget = null;
    renderSessionProgramInfo();
    setVideoState(false);
    if (!connected) setConnection("error");
    showToast(error.message || "録画・コメントの同時開始に失敗しました。", true);
  }
  processMonitorAutoQueue();
}

function startRecordClock() {
  if (recordClock) return;
  if (!recordStartedAt) recordStartedAt = Date.now();
  recordClock = window.setInterval(() => {
    byId("record-timer").textContent = formatDuration(Date.now() - recordStartedAt);
  }, 500);
}

function clearRecordClock() {
  if (recordClock) window.clearInterval(recordClock);
  recordClock = null;
  recordStartedAt = 0;
  byId("record-timer").textContent = "00:00:00";
}

function setVideoState(recording, stopping = false) {
  videoCaptureState = stopping ? "stopping" : (recording ? "recording" : "idle");
  renderSessionProgramInfo();
  byId("record-indicator").classList.toggle("recording", recording);
  byId("record-status").textContent = stopping
    ? "録画停止中…"
    : recording ? "録画中（直接取得）" : "録画していません";
  recordButton.disabled = recording || stopping;
  stopRecordButton.disabled = !recording || stopping;
  updateCaptureIndicators();
  renderDashboardStats();
  renderLiveBroadcasts();
}

async function stopVideoRecording() {
  if (!stopRecordButton.disabled) {
    setVideoState(true, true);
    try {
      const result = await api.stopVideo();
      if (result.path) {
        byId("video-file").textContent = "映像：" + result.path;
      }
    } catch (error) {
      setVideoState(true);
      showToast(error.message || "録画を停止できませんでした。", true);
    }
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
    if (payload.path) byId("video-file").textContent = "映像：" + payload.path;
    recordStartedAt = payload.startedAt ? new Date(payload.startedAt).getTime() : (recordStartedAt || Date.now());
    setVideoState(true);
    startRecordClock();
    return;
  }

  if (payload.path) {
    byId("video-file").textContent = "映像：" + payload.path;
    showToast(payload.converted
      ? "録画を保存しました（MP4変換済み）: " + payload.path
      : "録画を保存しました（TS形式）: " + payload.path);
  } else if (payload.exitCode !== undefined) {
    showToast("録画データがありません。配信の状態と視聴権限を確認してください。", true);
  }
  clearRecordClock();
  currentCaptureTarget = null;
  renderSessionProgramInfo();
  setVideoState(false);
  processMonitorAutoQueue();
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
    (recordButton.disabled || Boolean(recordStartedAt) ||
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
    const recordingBusy = !status.isRecording && (recordButton.disabled || Boolean(recordStartedAt) ||
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

    card.append(top, broadcaster, title, meta, footer);
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

function applyMonitorState(result) {
  if (!result) return;
  if (result.settings) monitorSettings = result.settings;
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
  const button = byId("save-settings-button");
  button.disabled = true;
  try {
    applyMonitorState(await api.saveMonitorSettings(values));
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
  if (recordButton.disabled || recordStartedAt) return;

  const target = monitorAutoQueue.shift();
  if (!target || !target.liveId) return;
  monitorAutoProcessing = true;
  recordButton.disabled = true;
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
    liveInput.value = liveId;
    renderSessionProgramInfo();
    clearComments();
    setConnection("connecting");
    byId("live-title").textContent = target.title || "番組情報を取得中…";
    byId("live-meta").textContent = "配信監視から自動録画を開始しています";

    setConnection("connecting");
    const capture = await api.startCapture(liveId, monitorSettings.quality || "best", {
      displayName: target.displayName || target.name || "",
      broadcasterId: target.broadcasterId || target.userId || "",
      programTitle: target.title || "",
      startedAt: target.startedAt || ""
    });
    if (capture.comment && capture.comment.metadata) updateMetadata(capture.comment.metadata);
    if (capture.comment && capture.comment.commentFile) {
      byId("comment-file").textContent = "コメント：" + capture.comment.commentFile;
    }
    setConnection(capture.commentsConnected ? "connected" : "error");

    const result = capture.video || {};
    byId("video-file").textContent = "保存先：" + (result.path || "");
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
      recordButton.disabled = false;
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
    const searchable = [item.fileName, item.broadcaster, item.liveId, item.extension].join(" ").toLowerCase();
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

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "library-row";
    const file = document.createElement("div");
    file.className = "library-file-cell";
    file.appendChild(createLibraryText("library-file-name", item.fileName));
    file.appendChild(createLibraryText("library-file-meta", item.liveId || item.extension));
    row.appendChild(file);
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
    row.appendChild(actions);
    list.appendChild(row);
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
    const result = await api.getCaptureLibrary();
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

function renderBroadcastArticles() {
  const list = byId("articles-list");
  if (!list) return;
  list.replaceChildren();
  const query = String(byId("articles-search").value || "").trim().toLowerCase();
  const items = broadcastArticles.filter((article) => {
    const searchable = [
      article.broadcasterName, article.programTitle, article.title, article.liveId,
      ...(article.topics || []).map((topic) => topic.term)
    ].join(" ").toLowerCase();
    return !query || searchable.includes(query);
  });

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "article-empty";
    empty.textContent = broadcastArticles.length
      ? "検索条件に一致する記事がありません。"
      : "まだ放送記事がありません。配信の録画終了またはコメント切断時に自動生成されます。過去のJSONLログは録画ライブラリから記事化できます。";
    list.appendChild(empty);
    return;
  }

  for (const article of items) {
    const card = document.createElement("article");
    card.className = "broadcast-article-card";
    const heading = document.createElement("div");
    heading.className = "broadcast-article-heading";
    const title = document.createElement("h3");
    title.textContent = article.title || article.programTitle || article.liveId || "放送記事";
    const meta = document.createElement("p");
    meta.className = "broadcast-article-meta";
    meta.textContent = [
      article.broadcasterName || "配信者名未取得",
      formatLibraryDate(article.startedAt || article.generatedAt),
      article.liveId || ""
    ].filter(Boolean).join(" · ");
    if (article.liveStatus === "live" || article.isLive) {
      const liveBadge = document.createElement("span");
      liveBadge.className = "broadcast-article-live-badge";
      liveBadge.textContent = "● LIVE 配信中・記事更新中";
      heading.append(liveBadge);
    }
    heading.append(title, meta);

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
    for (const paragraph of Array.isArray(article.paragraphs) ? article.paragraphs : []) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      body.appendChild(p);
    }
    const note = document.createElement("p");
    note.className = "broadcast-article-note";
    note.textContent = article.note || "番組情報と保存済みコメントから自動生成された記事です。";
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

    if (article.generatedAt) {
      const updated = document.createElement("p");
      updated.className = "broadcast-article-updated";
      updated.textContent = "最終更新：" + formatLibraryDate(article.generatedAt);
      body.appendChild(updated);
    }
    card.append(heading, stats, body, actions);
    list.appendChild(card);
  }
}

let broadcastArticles = [];

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
      status.textContent = version + " のダウンロードが完了しました。再起動して更新できます。";
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
      status.textContent = "更新を確認できませんでした: " + (payload.message || "通信エラー");
      break;
    default:
      status.textContent = "更新状態を確認できません。";
  }

  settingsStatus.textContent = status.textContent;
  settingsProgress.hidden = progress.hidden;
  settingsProgress.value = progress.value;
  settingsInstallButton.hidden = installButton.hidden;
  settingsInstallButton.disabled = installButton.disabled;
  settingsCheckButton.disabled = checkButton.disabled;

  const badgeLabels = {
    checking: "確認中",
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

api.onEvent(({ channel, payload }) => {
  if (channel === "live:event") renderEvent(payload);
  if (channel === "live:metadata") updateMetadata(payload);
  if (channel === "live:state") {
    const state = payload && payload.state ? payload.state : "disconnected";
    setConnection(state);
  }
  if (channel === "comments:file" && payload && payload.path) {
    byId("comment-file").textContent = "コメント：" + payload.path;
  }
  if (channel === "video:state") handleVideoState(payload);
  if (channel === "preview:state") renderLivePreviewState(payload);
  if (channel === "capture:state" && payload && payload.commentError) {
    byId("capture-status-detail").textContent = "映像録画は開始しましたが、コメント取得に失敗しました: " + payload.commentError;
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
    byId("live-meta").textContent = "過去コメント取得中：" + count.toLocaleString("ja-JP") +
      "件 / " + segments + "セグメント";
    byId("capture-status-detail").textContent = "タイムシフトの映像録画を継続しながら、過去コメントを取得しています。";
  }
  if (channel === "comments:exports" && payload && Array.isArray(payload.paths)) {
    addMonitorActivity("コメント形式の追加ファイルを保存しました：" + payload.paths.join(" / "));
  }
  if (channel === "update:state") renderUpdateState(payload);
  if (channel === "streamlink:update-state") renderStreamlinkUpdateState(payload);
  if (channel === "monitor:state") renderMonitorState(payload);
  if (channel === "monitor:target-status") {
    monitorStatuses.set(payload.userId, payload);
    renderMonitorTargets();
  }
  if (channel === "monitor:live-detected") handleMonitorLiveDetected(payload);
  if (channel === "articles:generated") {
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
  if (channel === "auth:status") refreshAuthStatus();
  if (channel === "app:error") showToast(String(payload || "エラーが発生しました。"), true);
});

connectButton.addEventListener("click", connectLive);
disconnectButton.addEventListener("click", disconnectLive);
recordButton.addEventListener("click", startVideoRecording);
byId("record-mode").addEventListener("change", () => {
  const timeshift = byId("record-mode").value === "timeshift";
  byId("record-mode-hint").textContent = timeshift
    ? "視聴期限内で、ログイン中アカウントに視聴権限があるタイムシフトを最初から映像・音声と過去コメントを取得します。コメントAPIが利用できない場合も映像録画は継続します。"
    : "配信中の放送は映像・音声とコメントを同時に保存します。コメントだけ保存する場合は「コメントのみ接続」を選んでください。";
  recordButton.textContent = timeshift
    ? "● 過去配信（映像＋コメント）を録画"
    : "● 接続して映像・音声＋コメントを録画";
});
stopRecordButton.addEventListener("click", stopVideoRecording);
byId("check-update-button").addEventListener("click", checkAppUpdates);
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
byId("articles-search").addEventListener("input", renderBroadcastArticles);
byId("library-open-folder-button").addEventListener("click", async () => {
  try {
    const result = await api.openDataFolder();
    if (result.error) showToast(result.error, true);
  } catch (error) {
    showToast(error.message || "保存フォルダーを開けませんでした。", true);
  }
});

byId("export-ass-button").addEventListener("click", async () => {
  try {
    const result = await api.exportAss();
    if (result.cancelled) return;
    showToast("ASSを書き出しました（" + result.commentCount + "件）: " + result.path);
  } catch (error) {
    showToast(error.message || "ASSを書き出せませんでした。", true);
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
    const textWidth = Math.ceil(context.measureText(comment.text).width) + 20;
    const startMs = comment.timeMs;

    if (isFixed) {
      const lanes = isTop ? topLanes : bottomLanes;
      const durationMs = fixedDurationMs || 3000;
      const reservation = allocateLane(lanes, startMs, durationMs, isTop ? topSequence++ : bottomSequence++);
      const lane = reservation.lane;
      const y = isTop ? layout.topLaneYs[lane] : layout.bottomLaneYs[lane];
      schedule.push({
        ...comment, startMs: reservation.startMs, endMs: reservation.endMs, fontSize, color,
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
      startMs: reservation.startMs,
      endMs: reservation.startMs + durationMs,
      fontSize, color, textWidth, mode: "scroll", y
    });
  }

  return schedule.sort((a, b) => a.startMs - b.startMs);
}

function drawCommentOverlay(context, schedule, activeComments, videoTimeMs, width, height, options = {}) {
  // The base video frame has already been drawn to this canvas. Do not clear it:
  // clearing here used to erase the video and leave only a black background + comments.
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
  const records = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error("コメントログの" + (index + 1) + "行目を読み取れません: " + error.message);
    }
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
for (const id of ["compose-font-scale", "compose-font-size", "compose-speed", "compose-position", "compose-opacity", "compose-offset", "compose-outline", "compose-lane-gap", "compose-row-limit", "compose-duration", "compose-display-mode", "compose-font-family", "compose-color-mode", "compose-overlap-protection", "compose-shadow", "compose-ng-words"]) {
  byId(id).addEventListener("input", scheduleComposePreviewRefresh);
  byId(id).addEventListener("change", scheduleComposePreviewRefresh);
}

byId("compose-button").addEventListener("click", composeCommentVideo);
byId("compose-cancel-button").addEventListener("click", () => {
  if (cancelActiveComposition) cancelActiveComposition();
});
