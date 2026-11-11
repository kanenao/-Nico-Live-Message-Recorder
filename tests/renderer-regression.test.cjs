const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "nicolive-recorder-release.yml"), "utf8");

test("comment overlay preserves the video frame drawn to the canvas", () => {
  const start = renderer.indexOf("function drawCommentOverlay(");
  const end = renderer.indexOf("function setCompositionProgress(", start);
  assert.ok(start >= 0 && end > start, "drawCommentOverlay must exist");
  const drawFunction = renderer.slice(start, end);
  assert.doesNotMatch(drawFunction, /clearRect\s*\(/);
  assert.match(renderer, /context\.drawImage\(videoElement, 0, 0, canvas\.width, canvas\.height\)/);
  assert.match(drawFunction, /context\.fillText\(/);
});

test("settings and broadcaster monitor controls are present in the Japanese UI", () => {
  for (const id of [
    "settings-button",
    "settings-modal",
    "setting-monitor-interval",
    "setting-monitor-quality",
    "setting-auto-record",
    "setting-auto-start",
    "monitor-user-id",
    "monitor-add-button",
    "monitor-start-button",
    "monitor-stop-button",
    "monitor-target-list"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing UI element: " + id);
  }
  assert.match(main, /ipcMain\.handle\("monitor:get-state"/);
  assert.match(main, /ipcMain\.handle\("monitor:add-target"/);
  assert.match(main, /ipcMain\.handle\("monitor:start"/);
  assert.match(main, /ipcMain\.handle\("monitor:stop"/);
  assert.match(main, /ipcMain\.handle\("monitor:retry-target"/);
});

test("saved monitor user IDs are validated with a numeric pattern", () => {
  assert.ok(main.includes("/^\\d{5,}$/"), "saved numeric user IDs must load after restart");
  assert.ok(!main.includes("/^\\\\d{5,}$/"), "the digit pattern must not match a literal backslash");
  assert.ok(main.includes("stopMonitor();"), "monitor timer must stop during app shutdown");
});

test("automatic monitor recording is queued instead of interrupting an active recording", () => {
  assert.match(renderer, /const monitorAutoQueue = \[\]/);
  assert.match(renderer, /if \(recordButton\.disabled \|\| recordStartedAt\) return/);
  assert.match(renderer, /monitorAutoQueue\.push\(payload\)/);
  assert.match(renderer, /monitorAutoProcessing = true;\s*recordButton\.disabled = true/);
  assert.match(renderer, /if \(!recordStartedAt && videoCaptureState !== "recording"\) \{\s*recordButton\.disabled = false/);
  assert.match(renderer, /api\.retryMonitorTarget\(/);
});


test("monitor prefers the authenticated follow-list API and retains public-history fallback", () => {
  assert.match(main, /fetchFollowingOnAirPrograms\(cookieHeader\)/);
  assert.match(main, /session\.fromPartition\("persist:nico-auth"\)/);
  assert.match(main, /const result = followedProgram \? null : await fetchUserBroadcastStatus/);
  assert.match(main, /isFollowerOnly: Boolean\(live && live\.isFollowerOnly\)/);
  assert.match(main, /\[15, 30, 60, 120, 300\]/);
  assert.match(html, /<option value="15">15秒（最速）<\/option>/);
});


test("broadcast connection and direct video/audio recording share one integrated panel", () => {
  const panelStart = html.indexOf('<section class="panel session-panel">');
  const panelEnd = html.indexOf("</section>", panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, "integrated session panel must exist");
  const panel = html.slice(panelStart, panelEnd);
  for (const id of [
    "live-id", "open-watch-button", "record-button", "connect-button",
    "disconnect-button", "stop-record-button", "record-quality",
    "streamlink-status", "ffmpeg-status", "comment-file", "video-file"
  ]) {
    assert.ok(panel.includes('id="' + id + '"'), "missing integrated control: " + id);
  }
  assert.match(panel, /接続して映像・音声＋コメントを録画/);
  assert.match(panel, /コメントのみ接続/);
  assert.match(panel, /コメント切断/);
  assert.match(preload, /startCapture:.*ipcRenderer\.invoke\("capture:start"/);
  assert.match(main, /ipcMain\.handle\("capture:start"/);
  assert.match(main, /Promise\.allSettled\(\[commentTask, videoTask\]\)/);
  assert.match(main, /connectPreparedCommentSession\(liveId\)/);
  assert.match(main, /startVideoInternal\(liveId, quality/);
  assert.match(renderer, /api\.startCapture\(liveId, quality, \{\}\)/);
  assert.match(renderer, /currentLiveId = liveId;\s*liveInput\.value = liveId/);
});

test("past broadcasts have an explicit timeshift video-only recording mode", () => {
  assert.match(html, /id="record-mode"/);
  assert.match(html, /過去配信（タイムシフト映像のみ）/);
  assert.match(renderer, /api\.startVideo\(liveId, quality, \{ timeshift: true \}\)/);
  assert.match(renderer, /タイムシフトの映像・音声録画を開始しました/);
  assert.match(main, /const timeshift = Boolean\(options && options\.timeshift\)/);
  assert.match(main, /timeshift\s*$/m);
});

test("videos and comments are organized by broadcaster display name", () => {
  assert.match(main, /function sanitizeFolderSegment/);
  assert.match(main, /function broadcasterFolderName/);
  assert.match(main, /path\.join\(dataRoot\(\), "videos", broadcasterFolderName/);
  assert.match(main, /path\.join\(dataRoot\(\), "comments",/);
  assert.match(main, /moveCommentLogToBroadcasterFolder/);
  assert.match(main, /fetchNicoUserName\(target\.userId\)/);
  assert.match(preload, /startCapture/);
});

test("comment output format and separate capture indicators are selectable", () => {
  for (const id of ["setting-comment-format", "capture-video-state", "capture-comment-state", "capture-video-dot", "capture-comment-dot"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing capture or format UI: " + id);
  }
  for (const value of ["jsonl", "csv", "ass", "all"]) {
    assert.ok(html.includes('<option value="' + value + '"'), "missing comment format: " + value);
  }
  assert.match(main, /function getCommentFormat/);
  assert.match(main, /async function exportCommentSidecars/);
  assert.match(main, /generateAssFromRecords\(records\)/);
  assert.match(renderer, /function updateCaptureIndicators/);
  assert.match(renderer, /videoCaptureState = stopping \? "stopping"/);
  assert.match(renderer, /commentCaptureState = \["connected", "connecting", "error"\]/);
});

test("recording library and Streamlink runtime updater controls are exposed", () => {
  for (const id of [
    "dashboard-nav-button", "open-folder-button", "library-panel", "library-search",
    "library-filter", "library-list", "library-refresh-button", "library-open-folder-button",
    "library-total", "library-video-count", "library-comment-count",
    "streamlink-update-status", "streamlink-update-check-button",
    "streamlink-update-install-button", "setting-auto-update-streamlink"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing library or updater UI: " + id);
  }
  assert.match(preload, /getCaptureLibrary:.*ipcRenderer\.invoke\("library:list"/);
  assert.match(preload, /openLibraryItem:.*ipcRenderer\.invoke\("library:open-item"/);
  assert.match(preload, /showLibraryItem:.*ipcRenderer\.invoke\("library:show-item"/);
  assert.match(preload, /checkStreamlinkUpdate:.*ipcRenderer\.invoke\("streamlink:update-check"/);
  assert.match(main, /ipcMain\.handle\("library:list"/);
  assert.match(main, /function listCaptureLibrary\(/);
  assert.match(main, /function resolveLibraryItemPath\(/);
  assert.match(main, /ipcMain\.handle\("streamlink:update-check"/);
  assert.match(main, /checkStreamlinkUpdateNow\(\{ autoInstall: true, silent: true \}\)/);
  assert.match(main, /24 \* 60 \* 60 \* 1000/);
  assert.match(renderer, /function setLibraryView\(/);
  assert.match(renderer, /function renderCaptureLibrary\(/);
  assert.match(renderer, /function renderStreamlinkUpdateState\(/);
});

test("comment video composer exposes timing, layout, appearance and quality controls", () => {
  for (const id of [
    "compose-font-scale", "compose-speed", "compose-offset", "compose-position",
    "compose-opacity", "compose-display-mode", "compose-color-mode",
    "compose-resolution", "compose-fps", "compose-bitrate", "compose-shadow"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing composer control: " + id);
  }
  assert.match(renderer, /offsetMs: number\("compose-offset"/);
  assert.match(renderer, /displayMode === "top"/);
  assert.match(renderer, /displayMode === "bottom"/);
  assert.match(renderer, /context\.globalAlpha =/);
  assert.match(renderer, /canvas\.captureStream\(composeOptions\.fps\)/);
  assert.match(renderer, /videoBitsPerSecond: composeOptions\.bitrate/);
  assert.match(renderer, /comment\.timeMs \+ composeOptions\.offsetMs/);
});


test("successful main-branch Windows builds automatically publish a beta update once", () => {
  assert.match(releaseWorkflow, /workflow_run:/);
  assert.match(releaseWorkflow, /Build Nico Live Message Recorder/);
  assert.match(releaseWorkflow, /conclusion == 'success'/);
  assert.match(releaseWorkflow, /gh release view/);
  assert.match(releaseWorkflow, /dist:win:release/);
  assert.match(releaseWorkflow, /beta update metadata/);
});

test("unsupported app update packages show their specific reason", () => {
  assert.match(renderer, /message: result\.reason \|\|/);
  assert.match(renderer, /Windowsインストーラー版をご利用ください/);
});
