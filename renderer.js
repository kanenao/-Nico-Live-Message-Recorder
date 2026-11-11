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
let commentCaptureState = "disconnected";
let videoCaptureState = "idle";
let commentCount = 0;
let eventCount = 0;
let displayedComments = 0;
let monitorSettings = {
  intervalSeconds: 60,
  autoRecord: true,
  autoStart: true,
  quality: "best",
  commentFormat: "jsonl",
  targets: []
};
const monitorStatuses = new Map();
const monitorAutoQueue = [];
let monitorAutoProcessing = false;

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

function updateMetadata(metadata) {
  if (!metadata) return;
  byId("live-title").textContent = metadata.title || "番組タイトルを取得できませんでした";
  const broadcaster = metadata.broadcasterName || "放送者情報なし";
  const status = metadata.status || "";
  byId("live-meta").textContent = broadcaster + (status ? " ・ " + status : "");
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

  currentLiveId = liveId;
  liveInput.value = liveId;
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

async function startVideoRecording() {
  const liveId = normalizeId(liveInput.value || currentLiveId);
  if (!liveId) {
    showToast("先に放送IDを入力してください。", true);
    return;
  }

  recordButton.disabled = true;
  if (!(connected && currentLiveId === liveId)) setConnection("connecting");
  try {
    const quality = byId("record-quality")?.value || "best";
    const result = await api.startCapture(liveId, quality, {});
    if (result.comment && result.comment.metadata) updateMetadata(result.comment.metadata);
    if (result.comment && result.comment.commentFile) {
      byId("comment-file").textContent = "コメント：" + result.comment.commentFile;
    }
    if (result.commentsConnected) {
      setConnection("connected");
    } else {
      setConnection("error");
    }

    const video = result.video || {};
    byId("video-file").textContent = "保存先：" + (video.path || "");
    recordStartedAt = video.startedAt ? new Date(video.startedAt).getTime() : Date.now();
    setVideoState(true);
    startRecordClock();
    if (result.commentError) {
      showToast("映像録画は開始しましたが、コメント取得に失敗しました: " + result.commentError, true);
    } else {
      showToast("映像録画とコメント取得を同時に開始しました。");
    }
  } catch (error) {
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
  byId("record-indicator").classList.toggle("recording", recording);
  byId("record-status").textContent = stopping
    ? "録画停止中…"
    : recording ? "録画中（直接取得）" : "録画していません";
  recordButton.disabled = recording || stopping;
  stopRecordButton.disabled = !recording || stopping;
  updateCaptureIndicators();
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
  setVideoState(false);
  processMonitorAutoQueue();
}

async function refreshVideoTools() {
  try {
    const status = await api.getVideoToolStatus();
    const streamlinkLabel = byId("streamlink-status");
    const ffmpegLabel = byId("ffmpeg-status");
    streamlinkLabel.textContent = status.streamlinkBundled
      ? "Streamlink：" + (status.streamlinkVersion || "同梱版") + "（自動セットアップ済み）"
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


function renderMonitorState(payload) {
  if (!payload) return;
  const state = byId("monitor-state");
  const startButton = byId("monitor-start-button");
  const stopButton = byId("monitor-stop-button");
  const running = Boolean(payload.running);
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
    main.append(name, id);

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
    speed: number("compose-speed", 100, 50, 200) / 100,
    marginPercent: number("compose-position", 7, 4, 25),
    opacity: number("compose-opacity", 100, 20, 100) / 100,
    displayMode: byId("compose-display-mode").value,
    colorMode: byId("compose-color-mode").value,
    resolution: byId("compose-resolution").value,
    fps: number("compose-fps", 30, 30, 60),
    bitrate: number("compose-bitrate", 6000000, 1000000, 20000000),
    shadow: byId("compose-shadow").checked
  };
}

function updateCompositionEditorLabels() {
  for (const [inputId, outputId, suffix] of [
    ["compose-font-scale", "compose-font-value", "%"],
    ["compose-speed", "compose-speed-value", "%"],
    ["compose-position", "compose-position-value", "%"],
    ["compose-opacity", "compose-opacity-value", "%"]
  ]) {
    const input = byId(inputId);
    const output = byId(outputId);
    if (input && output) output.textContent = input.value + suffix;
  }
}

function openSettings() {
  byId("setting-monitor-interval").value = String(monitorSettings.intervalSeconds || 60);
  byId("setting-monitor-quality").value = monitorSettings.quality === "worst" ? "worst" : "best";
  byId("setting-comment-format").value = ["jsonl", "csv", "ass", "all"].includes(monitorSettings.commentFormat) ? monitorSettings.commentFormat : "jsonl";
  byId("setting-auto-record").checked = monitorSettings.autoRecord !== false;
  byId("setting-auto-start").checked = monitorSettings.autoStart !== false;
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
    autoStart: byId("setting-auto-start").checked
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

  try {
    const liveId = normalizeId(target.liveId);
    if (!liveId) throw new Error("監視で検出した放送IDが正しくありません。");

    currentLiveId = liveId;
    liveInput.value = liveId;
    clearComments();
    setConnection("connecting");
    byId("live-title").textContent = target.title || "番組情報を取得中…";
    byId("live-meta").textContent = "配信監視から自動録画を開始しています";

    setConnection("connecting");
    const capture = await api.startCapture(liveId, monitorSettings.quality || "best", {
      displayName: target.displayName || target.name || "",
      broadcasterId: target.broadcasterId || target.userId || ""
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
  } catch (error) {
    setConnection("error");
    await api.retryMonitorTarget({
      userId: target.userId,
      liveId: target.liveId
    }).catch(() => {});
    addMonitorActivity(
      (target.liveId || "") + " の自動録画に失敗。次回の監視確認で再試行します：" + (error.message || String(error)),
      "error"
    );
    showToast(error.message || "監視対象の自動録画に失敗しました。", true);
  } finally {
    monitorAutoProcessing = false;
    if (monitorAutoQueue.length > 0 && !recordButton.disabled) {
      window.setTimeout(processMonitorAutoQueue, 1500);
    }
  }
}


function formatUpdateBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderUpdateState(payload) {
  if (!payload) return;
  const panel = byId("update-panel");
  const status = byId("update-status");
  const progress = byId("update-progress");
  const installButton = byId("install-update-button");
  const checkButton = byId("check-update-button");
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
      status.textContent = "自動アップデートはWindowsのインストーラー版で利用できます。";
      break;
    case "error":
      status.textContent = "更新を確認できませんでした: " + (payload.message || "通信エラー");
      break;
    default:
      status.textContent = "更新状態を確認できません。";
  }
}

async function checkAppUpdates() {
  const checkButton = byId("check-update-button");
  checkButton.disabled = true;
  renderUpdateState({ state: "checking" });
  try {
    const result = await api.checkForUpdates();
    if (result && result.supported === false) {
      renderUpdateState({ state: "unsupported" });
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
  button.disabled = true;
  try {
    byId("update-status").textContent = "録画とコメントログを安全に保存してから更新します…";
    await api.installUpdate();
  } catch (error) {
    button.disabled = false;
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
  if (channel === "capture:state" && payload && payload.commentError) {
    byId("capture-status-detail").textContent = "映像録画は開始しましたが、コメント取得に失敗しました: " + payload.commentError;
  }
  if (channel === "comments:exports" && payload && Array.isArray(payload.paths)) {
    addMonitorActivity("コメント形式の追加ファイルを保存しました：" + payload.paths.join(" / "));
  }
  if (channel === "update:state") renderUpdateState(payload);
  if (channel === "monitor:state") renderMonitorState(payload);
  if (channel === "monitor:target-status") {
    monitorStatuses.set(payload.userId, payload);
    renderMonitorTargets();
  }
  if (channel === "monitor:live-detected") handleMonitorLiveDetected(payload);
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
stopRecordButton.addEventListener("click", stopVideoRecording);
byId("check-update-button").addEventListener("click", checkAppUpdates);
byId("install-update-button").addEventListener("click", installAppUpdate);
byId("settings-button").addEventListener("click", openSettings);
byId("close-settings-button").addEventListener("click", closeSettings);
byId("cancel-settings-button").addEventListener("click", closeSettings);
byId("save-settings-button").addEventListener("click", saveSettings);
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

byId("open-folder-button").addEventListener("click", async () => {
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
  } catch (_) {}
  await refreshAuthStatus();
  await refreshVideoTools();
  await refreshMonitorState();
  setConnection("disconnected");
})();

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

function createCommentOverlaySchedule(comments, context, width, height) {
  const baseSize = Math.max(24, Math.min(58, Math.round(height * 0.045)));
  const scrollLanes = Array(18).fill(0);
  const topLanes = Array(5).fill(0);
  const bottomLanes = Array(5).fill(0);
  const schedule = [];

  for (const comment of comments) {
    const commands = compositionCommands(comment.mail);
    let fontSize = baseSize;
    if (commands.includes("big")) fontSize = Math.min(76, baseSize + 12);
    if (commands.includes("small")) fontSize = Math.max(20, baseSize - 10);

    const colorMap = {
      red: "#ff5050",
      blue: "#60aaff",
      green: "#55e58a",
      yellow: "#ffe45c",
      pink: "#ff83d2",
      cyan: "#64eaff",
      orange: "#ffad58",
      white: "#ffffff"
    };
    const color = commands.map((command) => colorMap[command]).find(Boolean) || "#ffffff";
    context.font = "bold " + fontSize + "px Meiryo, Yu Gothic, sans-serif";
    const textWidth = Math.ceil(context.measureText(comment.text).width) + 20;
    const isTop = commands.includes("ue") || commands.includes("top");
    const isBottom = commands.includes("shita") || commands.includes("bottom");
    const startMs = comment.timeMs;

    if (isTop || isBottom) {
      const lanes = isTop ? topLanes : bottomLanes;
      const durationMs = 5000;
      const reservation = reserveOverlayLane(lanes, startMs, durationMs, 150);
      const lane = reservation.lane;
      const y = isTop
        ? Math.round(height * 0.06) + lane * Math.round(fontSize * 1.16)
        : height - Math.round(height * 0.07) - lane * Math.round(fontSize * 1.16);
      schedule.push({
        ...comment, startMs: reservation.startMs, endMs: reservation.endMs, fontSize, color,
        textWidth, mode: isTop ? "top" : "bottom", y
      });
      continue;
    }

    const durationMs = Math.max(4000, Math.min(16000,
      ((width + textWidth) / 330) * 1000));
    const reservation = reserveOverlayLane(scrollLanes, startMs, durationMs, 180);
    const lane = reservation.lane;
    const y = Math.round(height * 0.07) + lane * Math.round(fontSize * 1.18);
    schedule.push({
      ...comment, startMs: reservation.startMs, endMs: reservation.endMs, fontSize, color,
      textWidth, mode: "scroll", y
    });
  }

  return schedule.sort((a, b) => a.startMs - b.startMs);
}

function drawCommentOverlay(context, schedule, activeComments, videoTimeMs, width, height) {
  // The base video frame has already been drawn to this canvas. Do not clear it:
  // clearing here used to erase the video and leave only a black background + comments.
  for (const comment of activeComments) {
    if (videoTimeMs < comment.startMs || videoTimeMs > comment.endMs) continue;
    const elapsed = videoTimeMs - comment.startMs;
    context.font = "bold " + comment.fontSize + "px Meiryo, Yu Gothic, sans-serif";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = Math.max(3, comment.fontSize * 0.11);
    context.strokeStyle = "rgba(0, 0, 0, 0.92)";
    context.fillStyle = comment.color;
    context.shadowColor = "rgba(0, 0, 0, 0.65)";
    context.shadowBlur = 3;

    let x;
    if (comment.mode === "scroll") {
      const ratio = Math.min(1, Math.max(0, elapsed / (comment.endMs - comment.startMs)));
      x = width - ratio * (width + comment.textWidth);
      context.textAlign = "left";
    } else {
      x = width / 2;
      context.textAlign = "center";
    }

    context.strokeText(comment.text, x, comment.y, Math.max(width * 2, comment.textWidth + 40));
    context.fillText(comment.text, x, comment.y, Math.max(width * 2, comment.textWidth + 40));
  }
  context.shadowBlur = 0;
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
    canvas.width = videoElement.videoWidth || 1920;
    canvas.height = videoElement.videoHeight || 1080;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("動画合成用キャンバスを作成できません。");
    const schedule = createCommentOverlaySchedule(
      timeline.comments, context, canvas.width, canvas.height
    );

    canvasStream = canvas.captureStream(30);
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

    const output = await api.startCompose();
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
      drawCommentOverlay(context, schedule, activeComments, currentMs, canvas.width, canvas.height);

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

    const recorderOptions = { mimeType, videoBitsPerSecond: 6000000 };
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
        try {
          await chunkQueue;
          if (writeError) throw writeError;
          if (cancelRequested) {
            await api.cancelCompose();
            resolve({ cancelled: true });
          } else {
            const saved = await api.finishCompose();
            resolve({ path: saved.path });
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
    } else {
      setCompositionProgress(100, "生成完了");
      showToast("コメント付き動画を保存しました: " + stopResult.path);
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

byId("compose-video-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("compose-video-name").textContent = file ? file.name : "WebM / MP4動画を選択";
});

byId("compose-comments-input").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("compose-comments-name").textContent = file ? file.name : "JSONLコメントログを選択";
});

byId("compose-button").addEventListener("click", composeCommentVideo);
byId("compose-cancel-button").addEventListener("click", () => {
  if (cancelActiveComposition) cancelActiveComposition();
});
