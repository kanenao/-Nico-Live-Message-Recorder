const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const monitor = fs.readFileSync(path.join(root, "electron", "monitor.cjs"), "utf8");
const composition = fs.readFileSync(path.join(root, "composition.js"), "utf8");
const ass = fs.readFileSync(path.join(root, "electron", "ass.cjs"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "nicolive-recorder-release.yml"), "utf8");
const buildWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "nicolive-recorder-build.yml"), "utf8");
const packageConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const composeExport = require(path.join(root, "electron", "composition-export.cjs"));

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
  const panelStart = html.indexOf('<section class="panel session-panel"');
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
  assert.match(renderer, /api\.startCapture\(liveId, quality, selectedTarget \? \{/);
  assert.match(renderer, /currentLiveId = liveId;\s*liveInput\.value = liveId/);
});

test("past broadcasts support timeshift video and archived comments", () => {
  assert.match(html, /id="record-mode"/);
  assert.match(html, /過去配信（タイムシフト映像＋コメント）/);
  assert.match(renderer, /api\.startVideo\(liveId, quality, \{ timeshift: true \}\)/);
  assert.match(renderer, /archive\.commentCount/);
  assert.match(renderer, /過去コメント /);
  assert.match(renderer, /件の保存を開始しました/);
  assert.match(main, /const timeshift = Boolean\(options && options\.timeshift\)/);
  assert.match(main, /fetchTimeshiftArchive\(page\.webSocketUrl, cookieHeader/);
  assert.match(main, /videoOriginAt: options && options\.timeshiftOriginAt/);
  assert.match(preload, /deleteLibraryVideo/);
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
    "streamlink-update-status", "setting-auto-update-streamlink"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing library or updater UI: " + id);
  }
  assert.match(preload, /getCaptureLibrary:.*ipcRenderer\.invoke\("library:list"/);
  assert.match(preload, /openLibraryItem:.*ipcRenderer\.invoke\("library:open-item"/);
  assert.match(preload, /showLibraryItem:.*ipcRenderer\.invoke\("library:show-item"/);
  assert.match(main, /ipcMain\.handle\("library:list"/);
  assert.match(main, /function listCaptureLibrary\(/);
  assert.match(main, /function resolveLibraryItemPath\(/);
  assert.match(main, /checkStreamlinkUpdateNow\(\{ autoInstall: true, silent: true \}\)/);
  assert.match(main, /6 \* 60 \* 60 \* 1000/);
  assert.match(main, /setTimeout\(runAutomaticStreamlinkUpdate, 12000\)/);
  assert.match(main, /autoUpdateStreamlink: true/);
  assert.match(main, /if \(!current\.autoUpdateStreamlink && process\.platform === "win32"\)/);
  assert.doesNotMatch(html, /streamlink-update-check-button|streamlink-update-install-button/);
  assert.doesNotMatch(preload, /checkStreamlinkUpdate|installStreamlinkUpdate/);
  assert.match(renderer, /function setActivePage\(/);
  assert.match(renderer, /function renderCaptureLibrary\(/);
  assert.match(renderer, /function renderStreamlinkUpdateState\(/);
  assert.match(renderer, /自動ダウンロード・SHA-256検証中/);
  assert.match(renderer, /次回の確認時に再試行します/);
});

test("comment video composer exposes timing, layout, appearance and quality controls", () => {
  for (const id of [
    "compose-font-scale", "compose-speed", "compose-offset", "compose-position",
    "compose-opacity", "compose-display-mode", "compose-color-mode",
    "compose-resolution", "compose-fps", "compose-bitrate", "compose-shadow",
    "compose-row-limit", "compose-duration", "compose-font-family", "compose-outline",
    "compose-ng-words", "compose-width", "compose-height", "compose-keep-aspect",
    "compose-output-format", "compose-output-quality"
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
  assert.match(renderer, /rowLimit: number\("compose-row-limit"/);
  assert.match(renderer, /durationSeconds/);
  assert.match(renderer, /composeOptions\.ngWords/);
  assert.match(renderer, /outlineWidth/);
  assert.match(renderer, /const fontFamily = \["Meiryo", "Yu Gothic UI", "BIZ UDPGothic", "Arial"\]/);
  assert.match(renderer, /api\.startCompose\(\{[\s\S]*?format: composeOptions\.outputFormat/);
  assert.match(main, /transcodeCompositionToMp4/);
  assert.match(main, /makeWebmFallbackPath/);
  assert.match(preload, /startCompose: \(options\) => ipcRenderer\.invoke\("compose:start", options\)/);
  assert.match(html, /WebMはそのまま保存し、MP4を選ぶ/);
  assert.match(css, /\.compose-editor-field-full/);
});


test("comment video export presets normalize WebM/MP4 format and build safe H.264/AAC arguments", () => {
  assert.equal(composeExport.normalizeCompositionFormat("MP4"), "mp4");
  assert.equal(composeExport.normalizeCompositionFormat("unknown"), "webm");
  assert.equal(composeExport.normalizeCompositionQuality("invalid"), "standard");
  const args = composeExport.buildMp4TranscodeArgs("input path.webm", "output path.mp4", "high");
  for (const value of ["input path.webm", "output path.mp4", "libx264", "aac", "yuv420p", "slow", "18", "0:a:0?"]) {
    assert.ok(args.includes(value), "missing FFmpeg argument: " + value);
  }
  assert.throws(() => composeExport.buildMp4TranscodeArgs("", "out.mp4", "standard"));
});

test("release preflight treats an HTTP 404 as unpublished and surfaces other GitHub API errors", () => {
  assert.match(releaseWorkflow, /Invoke-RestMethod/);
  assert.match(releaseWorkflow, /StatusCode/);
  assert.match(releaseWorkflow, /statusCode -eq 404/);
  assert.match(releaseWorkflow, /Unable to check GitHub Release/);
  assert.doesNotMatch(releaseWorkflow, /gh release view/);
});

test("successful main-branch Windows builds automatically publish a beta update once", () => {
  assert.match(releaseWorkflow, /workflow_run:/);
  assert.match(releaseWorkflow, /Build Nico Live Message Recorder/);
  assert.match(releaseWorkflow, /conclusion == 'success'/);
  assert.match(releaseWorkflow, /Invoke-RestMethod/);
  assert.match(releaseWorkflow, /dist:win:release/);
  assert.match(releaseWorkflow, /beta update metadata/);
});

test("unsupported app update packages show their specific reason", () => {
  assert.match(renderer, /message: result\.reason \|\|/);
  assert.match(renderer, /Windowsインストーラー版をご利用ください/);
});


test("recording watch preview opens in a separate authenticated window and can be closed without stopping capture", () => {
  for (const id of ["live-preview-open-button", "live-preview-close-button", "live-preview-status"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing preview control: " + id);
  }
  assert.match(main, /ipcMain\.handle\("preview:open"/);
  assert.match(main, /ipcMain\.handle\("preview:close"/);
  assert.match(main, /partition: "persist:nico-auth"/);
  assert.match(main, /https:\/\/live\.nicovideo\.jp\/watch\//);
  assert.match(main, /function closeLivePreview\(/);
  assert.match(main, /send\("preview:state", \{ state: "closed" \}\)/);
  assert.match(preload, /openLivePreview:.*ipcRenderer\.invoke\("preview:open"/);
  assert.match(preload, /closeLivePreview:.*ipcRenderer\.invoke\("preview:close"/);
  assert.match(renderer, /function renderLivePreviewState\(/);
  assert.match(renderer, /if \(channel === "preview:state"\)/);
  assert.match(html, /見ないときは「閉じる」でプレビューだけ終了でき、録画は継続します/);
});


test("Kick-inspired dashboard lists live broadcaster metadata and elapsed time", () => {
  for (const id of [
    "dashboard-target-count", "dashboard-live-count", "dashboard-recording-count",
    "dashboard-monitor-status", "live-broadcast-count", "live-broadcast-list"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing dashboard field: " + id);
  }
  assert.match(renderer, /function renderLiveBroadcasts\(/);
  assert.match(renderer, /function formatBroadcastStart\(/);
  assert.match(renderer, /function formatBroadcastElapsed\(/);
  assert.match(renderer, /window\.setInterval\(updateLiveElapsedLabels, 1000\)/);
  assert.match(main, /startedAt,\s*endedAt,/);
  assert.match(main, /watchPageUrl:/);
  assert.match(main, /normalizeMonitorDate\(live\.beginTime/);
  assert.match(html, /LIVE一覧から録画も直接開始できます/);
});


test("LIVE dashboard cards can start synchronized recording for their selected broadcaster", () => {
  assert.match(renderer, /async function startVideoRecording\(target = null\)/);
  assert.match(renderer, /startVideoRecording\(\{\s*liveId: status\.liveId/);
  assert.match(renderer, /api\.startCapture\(liveId, quality, selectedTarget \? \{/);
  assert.match(renderer, /displayName: selectedTarget\.name/);
  assert.match(renderer, /broadcasterId: selectedTarget\.userId/);
  assert.match(renderer, /recordButton\.disabled \|\| recordStartedAt \|\| monitorAutoProcessing/);
  assert.match(renderer, /live-broadcast-record-button/);
  assert.match(css, /\.live-broadcast-actions/);
  assert.match(html, /LIVE一覧から録画も直接開始できます/);
  assert.match(renderer, /renderLiveBroadcasts\(\);\s*if \(monitorAutoQueue\.length > 0/);
});

test("dashboard timestamps accept numeric and ISO dates and display a full start date", () => {
  assert.match(monitor, /function normalizeMonitorDate\(/);
  assert.match(monitor, /Array\.from\(raw\)\.every/);
  assert.match(renderer, /const isEpoch = raw\.length >= 10/);
  assert.match(renderer, /month: "2-digit", day: "2-digit"/);
  assert.match(main, /normalizeMonitorDate, fetchUserBroadcastStatus/);
  assert.match(css, /--accent: #53df9b/);
  assert.match(css, /\.live-broadcast-card/);
  assert.ok(html.includes(packageConfig.version));
});


test("video deletion is limited to saved videos and requires a native confirmation", () => {
  assert.match(main, /ipcMain\.handle\("library:delete-video"/);
  assert.match(main, /const videosRoot = path\.resolve\(dataRoot\(\), "videos"\)/);
  assert.match(main, /streamlinkOutputPath/);
  assert.match(main, /streamlinkFinalOutputPath/);
  assert.match(main, /activeRecordingPaths/);
  assert.match(main, /streamlinkProcess \|\| streamlinkFinalizePromise/);
  assert.match(main, /dialog\.showMessageBox\(mainWindow/);
  assert.match(main, /削除した動画は元に戻せません/);
  assert.match(preload, /deleteLibraryVideo:.*ipcRenderer\.invoke\("library:delete-video"/);
  assert.match(renderer, /api\.deleteLibraryVideo\(item\.path\)/);
  assert.match(renderer, /deleteButton\.textContent = "削除"/);
});

test("package, UI and CI artifact versions are kept in sync", () => {
  assert.equal(packageConfig.version, "0.1.0-beta.26");
  assert.ok(html.includes(packageConfig.version));
  const betaNumber = packageConfig.version.split(".").pop();
  assert.ok(betaNumber, "package version must be a beta release");
  assert.ok(buildWorkflow.includes("Nico-Live-Message-Recorder-beta" + betaNumber + "-Windows"));
});

test("past timeshift comments are fetched through NDGR previous and backward segments and aligned to archive start", () => {
  const handlerStart = main.indexOf('ipcMain.handle("video:start"');
  const lockAt = main.indexOf("timeshiftCommentFetchActive = true;", handlerStart);
  const pageFetchAt = main.indexOf("fetchTimeshiftProgramPage(liveId, cookieHeader)", handlerStart);
  assert.ok(lockAt > handlerStart && lockAt < pageFetchAt, "timeshift lock must be acquired before network requests");
  assert.match(main, /別の過去配信コメントを取得中です/);
  const captureStart = main.indexOf('ipcMain.handle("capture:start"');
  const captureLock = main.indexOf("if (timeshiftCommentFetchActive)", captureStart);
  assert.ok(captureStart > handlerStart && captureLock > captureStart, "live capture must be blocked during timeshift comment fetch");
  assert.match(main, /fetchTimeshiftArchive\(page\.webSocketUrl, cookieHeader/);
  assert.match(main, /appendMarker\("timeshiftOrigin"/);
  assert.match(main, /record\.isHistory = true/);
  assert.match(composition, /videoOriginAt/);
  assert.match(composition, /timeshiftOrigin && timeshiftOrigin\.originAt/);
  assert.match(ass, /timeshiftOrigin && timeshiftOrigin\.originAt/);
  assert.match(renderer, /過去コメント取得中/);
  assert.match(html, /タイムシフト映像＋コメント/);
});

test("editing menus and clipboard shortcuts support cut copy and paste", () => {
  assert.match(main, /contents\.on\("context-menu"/);
  assert.match(main, /contents\.on\("before-input-event"/);
  assert.match(main, /actions = \{ x: "cut", c: "copy", v: "paste", a: "selectAll"/);
  assert.match(main, /Menu\.buildFromTemplate\(template\)/);
  assert.match(css, /user-select:\s*text/);
});


test("timeshift comment retrieval does not restore recording state after the video ended", () => {
  assert.match(renderer, /Do not overwrite a completed video:state event/);
  assert.match(renderer, /if \(!timeshift \|\| videoCaptureState === "recording"\)/);
});


test("timeshift without a comment endpoint replaces and closes the previous comment session", () => {
  const branchStart = main.indexOf('if (!page || !page.webSocketUrl)');
  const branchEnd = main.indexOf('let video = null;', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  const fallback = main.slice(branchStart, branchEnd);
  assert.match(fallback, /await prepareCommentSession\(/);
  assert.match(fallback, /await startVideoInternal\(/);
  assert.match(fallback, /await closeCommentWriter\(\)/);
  const handlerStart = main.indexOf('ipcMain.handle("video:start"');
  const handlerEnd = main.indexOf('ipcMain.handle("capture:start"', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);
  assert.match(handler, /finally\s*\{\s*timeshiftCommentFetchActive = false;\s*\}/);
});


test("comment video output confirms when the selected extension changes the destination", () => {
  assert.match(main, /normalizeCompositionOutputPath\(selectedPath, format\)/);
  assert.match(main, /pathWasNormalized/);
  assert.match(main, /fs\.existsSync\(finalPath\)/);
  assert.match(main, /変更後の保存先/);
  assert.match(main, /confirmation\.response !== 1/);
});


test("MP4 comment video conversion reports progress and uses a unique intermediate file", () => {
  assert.ok(main.includes("createMp4IntermediatePath(finalPath, randomUUID())"));
  assert.ok(main.includes('flags: format === "mp4" ? "wx" : "w"'));
  assert.ok(!main.includes("unlink(workingPath)"));
  assert.ok(main.includes("calculateTranscodeProgressPercent(match[1], durationMs)"));
  assert.ok(main.includes('state: "progress"'));
  assert.ok(renderer.includes("durationMs"));
  assert.ok(renderer.includes('payload.state === "progress" ? Number(payload.percent)'));
});


test("feature navigation is grouped and every feature page has a dedicated view", () => {
  for (const id of [
    "dashboard-nav-button",
    "monitor-nav-button",
    "record-nav-button",
    "comments-nav-button",
    "compose-nav-button",
    "open-folder-button",
    "sidebar-settings-button"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing navigation control: ${id}`);
  }

  for (const page of ["dashboard", "monitor", "record", "comments", "compose", "library"]) {
    assert.match(html, new RegExp(`data-page="${page}"`), `missing page view: ${page}`);
    assert.match(html, new RegExp(`data-page-target="${page}"`), `missing page navigation: ${page}`);
  }

  assert.match(renderer, /function setActivePage\(page\)/);
  assert.match(renderer, /button\.dataset\.pageTarget/);
  assert.match(renderer, /if \(activePage === "library"\) loadCaptureLibrary\(\)/);
  assert.match(css, /\.content > \.page-hidden/);
  assert.doesNotMatch(renderer, /setLibraryView/);
});
