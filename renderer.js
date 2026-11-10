const api = window.nicoAPI;
const byId = (id) => document.getElementById(id);

const liveInput = byId("live-id");
const connectButton = byId("connect-button");
const disconnectButton = byId("disconnect-button");
const recordButton = byId("record-button");
const stopRecordButton = byId("stop-record-button");
const commentList = byId("comment-list");

let connected = false;
let videoRecorder = null;
let captureStream = null;
let recordStartedAt = 0;
let recordClock = null;
let currentLiveId = "";
let commentCount = 0;
let eventCount = 0;
let displayedComments = 0;
let videoChunkQueue = Promise.resolve();

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

function openCaptureSourcePicker(sources) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "capture-overlay";
    const panel = document.createElement("section");
    panel.className = "capture-dialog";
    const heading = document.createElement("div");
    heading.className = "capture-dialog-heading";
    heading.innerHTML = "<div><div class='eyebrow'>SELECT CAPTURE SOURCE</div><h2>録画する画面を選択</h2><p>ニコ生を表示しているブラウザーのウィンドウを選んでください。</p></div>";
    const grid = document.createElement("div");
    grid.className = "capture-source-grid";
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    for (const source of sources) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "capture-source";
      if (source.thumbnail) {
        const image = document.createElement("img");
        image.src = source.thumbnail;
        image.alt = "";
        button.appendChild(image);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "capture-source-placeholder";
        placeholder.textContent = "画面";
        button.appendChild(placeholder);
      }
      const name = document.createElement("span");
      name.textContent = source.name || "名前のないウィンドウ";
      button.appendChild(name);
      button.addEventListener("click", () => finish(source));
      grid.appendChild(button);
    }
    const actions = document.createElement("div");
    actions.className = "capture-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button button-outline";
    cancel.textContent = "キャンセル";
    cancel.addEventListener("click", () => finish(null));
    actions.appendChild(cancel);
    panel.append(heading, grid, actions);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
  });
}

async function handleCaptureSourceRequest() {
  try {
    const sources = await api.listVideoSources();
    if (!sources.length) {
      await api.cancelCaptureSource();
      showToast("録画できる画面・ウィンドウが見つかりません。", true);
      return;
    }
    const source = await openCaptureSourcePicker(sources);
    if (!source) {
      await api.cancelCaptureSource();
      showToast("画面録画をキャンセルしました。");
      return;
    }
    await api.selectVideoSource(source.id);
  } catch (error) {
    try { await api.cancelCaptureSource(); } catch (_) {}
    showToast(error.message || "録画元を選択できませんでした。", true);
  }
}

async function startVideoRecording() {
  const liveId = normalizeId(liveInput.value || currentLiveId);
  if (!liveId) {
    showToast("先に放送IDを入力してください。", true);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast("この環境では画面録画を利用できません。", true);
    return;
  }

  recordButton.disabled = true;
  try {
    // Request capture immediately from the button gesture. The main process
    // asks the user to select one specific window or screen before granting it.
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    });

    const result = await api.startVideo(liveId);
    const supportedTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));
    videoRecorder = new MediaRecorder(captureStream, mimeType ? { mimeType } : undefined);
    videoChunkQueue = Promise.resolve();

    videoRecorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const chunk = event.data;
      videoChunkQueue = videoChunkQueue.then(async () => {
        await api.writeVideoChunk(await chunk.arrayBuffer());
      }).catch((error) => {
        showToast("録画データを保存できません: " + error.message, true);
      });
    };

    videoRecorder.onerror = (event) => {
      showToast("画面録画でエラーが発生しました。", true);
      console.error(event);
      stopVideoRecording();
    };

    videoRecorder.onstop = async () => {
      try {
        await videoChunkQueue;
        const saved = await api.stopVideo();
        showToast(saved.path ? "映像を保存しました: " + saved.path : "録画を停止しました。");
        byId("video-file").textContent = saved.path ? "映像：" + saved.path : "保存先：未作成";
      } catch (error) {
        showToast(error.message || "録画ファイルを閉じられませんでした。", true);
      }
      if (captureStream) captureStream.getTracks().forEach((track) => track.stop());
      captureStream = null;
      videoRecorder = null;
      clearRecordClock();
      setVideoState(false);
    };

    videoRecorder.start(1000);
    recordStartedAt = Date.now();
    byId("video-file").textContent = "映像：" + result.path;
    setVideoState(true);
    recordClock = window.setInterval(() => {
      byId("record-timer").textContent = formatDuration(Date.now() - recordStartedAt);
    }, 500);

    const videoTrack = captureStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("ended", () => {
        if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
      }, { once: true });
    }
    showToast("画面録画を開始しました。");
  } catch (error) {
    try { await api.cancelCaptureSource(); } catch (_) {}
    if (captureStream) captureStream.getTracks().forEach((track) => track.stop());
    captureStream = null;
    try { await api.stopVideo(); } catch (_) {}
    recordButton.disabled = false;
    showToast(error.message || "画面録画を開始できませんでした。", true);
  }
}
function clearRecordClock() {
  if (recordClock) window.clearInterval(recordClock);
  recordClock = null;
  byId("record-timer").textContent = "00:00:00";
}

function setVideoState(recording) {
  byId("record-indicator").classList.toggle("recording", recording);
  byId("record-status").textContent = recording ? "録画中" : "録画していません";
  recordButton.disabled = recording;
  stopRecordButton.disabled = !recording;
}

function stopVideoRecording() {
  if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
}

api.onEvent(({ channel, payload }) => {
  if (channel === "video:choose-source") handleCaptureSourceRequest();
  if (channel === "live:event") renderEvent(payload);
  if (channel === "live:metadata") updateMetadata(payload);
  if (channel === "live:state") {
    const state = payload && payload.state ? payload.state : "disconnected";
    setConnection(state);
  }
  if (channel === "comments:file" && payload && payload.path) {
    byId("comment-file").textContent = "コメント：" + payload.path;
  }
  if (channel === "video:state" && payload && payload.path) {
    byId("video-file").textContent = "映像：" + payload.path;
  }
  if (channel === "auth:status") refreshAuthStatus();
  if (channel === "app:error") showToast(String(payload || "エラーが発生しました。"), true);
});

connectButton.addEventListener("click", connectLive);
disconnectButton.addEventListener("click", disconnectLive);
recordButton.addEventListener("click", startVideoRecording);
stopRecordButton.addEventListener("click", stopVideoRecording);

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
  setConnection("disconnected");
})();