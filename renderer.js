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
let commentCount = 0;
let eventCount = 0;
let displayedComments = 0;

function showToast(message, isError) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = "toast visible" + (isError ? " error" : "");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.className = "toast";
  }, 4200);
}

function setConnection(state, label) {
  const badge = byId("connection-badge");
  const text = byId("connection-label");
  badge.classList.remove("online", "busy", "failed");
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
  try {
    const quality = byId("record-quality")?.value || "best";
    const result = await api.startVideo(liveId, quality);
    byId("video-file").textContent = "保存先：" + result.path;
    recordStartedAt = result.startedAt ? new Date(result.startedAt).getTime() : Date.now();
    setVideoState(true);
    startRecordClock();
    showToast("配信ストリームの直接録画を開始しました。");
  } catch (error) {
    setVideoState(false);
    showToast(error.message || "直接録画を開始できませんでした。", true);
  }
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
  byId("record-indicator").classList.toggle("recording", recording);
  byId("record-status").textContent = stopping
    ? "録画停止中…"
    : recording ? "録画中（直接取得）" : "録画していません";
  recordButton.disabled = recording || stopping;
  stopRecordButton.disabled = !recording || stopping;
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
}

async function refreshVideoTools() {
  try {
    const status = await api.getVideoToolStatus();
    const streamlinkLabel = byId("streamlink-status");
    const ffmpegLabel = byId("ffmpeg-status");
    streamlinkLabel.textContent = status.streamlinkAvailable
      ? "Streamlink：設定済み（" + status.streamlinkPath.replace(/^.*[\\/]/, "") + "）"
      : "Streamlink：未設定";
    ffmpegLabel.textContent = status.ffmpegAvailable
      ? "FFmpeg：設定済み（MP4変換可能）"
      : "FFmpeg：未設定（録画はTS形式）";
  } catch (_) {
    byId("streamlink-status").textContent = "Streamlink：状態を確認できません";
    byId("ffmpeg-status").textContent = "FFmpeg：状態を確認できません";
  }
}

async function configureStreamlink() {
  try {
    const result = await api.selectStreamlink();
    if (!result.cancelled) showToast("Streamlinkを設定しました。");
    await refreshVideoTools();
  } catch (error) {
    showToast(error.message || "Streamlinkを設定できませんでした。", true);
  }
}

async function configureFfmpeg() {
  try {
    const result = await api.selectFfmpeg();
    if (!result.cancelled) showToast("FFmpegを設定しました。録画終了後にMP4へ変換します。");
    await refreshVideoTools();
  } catch (error) {
    showToast(error.message || "FFmpegを設定できませんでした。", true);
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
  if (channel === "auth:status") refreshAuthStatus();
  if (channel === "app:error") showToast(String(payload || "エラーが発生しました。"), true);
});

connectButton.addEventListener("click", connectLive);
disconnectButton.addEventListener("click", disconnectLive);
recordButton.addEventListener("click", startVideoRecording);
stopRecordButton.addEventListener("click", stopVideoRecording);
byId("configure-streamlink-button").addEventListener("click", configureStreamlink);
byId("configure-ffmpeg-button").addEventListener("click", configureFfmpeg);
byId("download-streamlink-button").addEventListener("click", async () => {
  try { await api.openStreamlinkDownload(); }
  catch (error) { showToast(error.message || "配布ページを開けませんでした。", true); }
});

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
  context.clearRect(0, 0, width, height);
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
