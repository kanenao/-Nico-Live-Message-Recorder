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
const articleExport = require(path.join(root, "electron", "article-export.cjs"));
const ollamaSource = fs.readFileSync(path.join(root, "electron", "ollama.cjs"), "utf8");
const audioTranscription = fs.readFileSync(path.join(root, "electron", "audio-transcription.cjs"), "utf8");

test("comment overlay preserves the video frame drawn to the canvas", () => {
  const start = renderer.indexOf("function drawCommentOverlay(");
  const end = renderer.indexOf("function setComposePreviewStatus(", start);
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
    "setting-run-at-startup",
    "setting-close-to-tray",
    "setting-keep-awake",
    "setting-notify-on-live",
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
  assert.match(main, /app\.setLoginItemSettings/);
  assert.match(main, /new Tray\(/);
  assert.match(main, /prevent-app-suspension/);
  assert.match(main, /scheduleNextMonitorCheck/);
  assert.match(main, /mapWithConcurrency\(historyTargets, 4/);
  assert.match(main, /isLegacyMonitorSettings && storedIntervalSeconds === 60/);
  assert.match(html, /<option value="10"(?: selected)?>10秒（最速・推奨）<\/option>/);
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
  assert.match(renderer, /recordStartInProgress \|\| recordStartedAt \|\| videoCaptureState === "recording"/);
  assert.ok(renderer.includes("finally {"));
  assert.ok(renderer.includes("recordStartInProgress = false;"));
  assert.ok(renderer.includes("processMonitorAutoQueue();"));
  assert.ok(renderer.includes('recordButton.disabled = videoCaptureState === "recording"'));
  assert.match(renderer, /api\.retryMonitorTarget\(/);
});


test("monitor prefers the authenticated follow-list API and retains public-history fallback", () => {
  assert.match(main, /fetchFollowingOnAirPrograms\(cookieHeader\)/);
  assert.match(main, /session\.fromPartition\("persist:nico-auth"\)/);
  assert.match(main, /const historyTargets = enabledTargets\.filter\(\(target\) => !followedLiveByUser\.has\(target\.userId\)\)/);
  assert.match(main, /fetchUserBroadcastStatus\(target\.userId\)/);
  assert.match(main, /const history = followedProgram \? null : historyByUser\.get\(target\.userId\)/);
  assert.match(main, /isFollowerOnly: Boolean\(live && live\.isFollowerOnly\)/);
  assert.match(main, /\[10, 15, 30, 60, 120, 300\]/);
  assert.match(html, /<option value="10"(?: selected)?>10秒（最速・推奨）<\/option>/);
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
  assert.match(renderer, /api\.startCapture\(liveId, quality, \{/);
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
  assert.match(renderer, /const groups = new Map\(\)/);
  assert.match(renderer, /api\.getLibraryThumbnail\(thumbnailItem\.path\)/);
  assert.match(main, /ipcMain\.handle\("library:thumbnail"/);
  assert.match(preload, /getLibraryThumbnail:.*ipcRenderer\.invoke\("library:thumbnail"/);
  assert.match(renderer, /function renderStreamlinkUpdateState\(/);
  assert.match(renderer, /自動ダウンロード・SHA-256検証中/);
  assert.match(renderer, /次回の確認時に再試行します/);
});

test("NicoNico standard comment preset applies classic font, size, speed and outline", () => {
  assert.match(renderer, /function applyNicoCommentPreset\(/);
  assert.match(renderer, /"compose-font-size": 75/);
  assert.match(renderer, /"compose-pixels-per-second": 450/);
  assert.match(renderer, /"compose-outline": 5/);
  assert.match(renderer, /compose-nico-preset.*addEventListener/);
  assert.match(html, /id="compose-nico-preset">ニコ生標準にする/);
});

test("comment video composer exposes timing, layout, appearance and quality controls", () => {
  for (const id of [
    "compose-nico-preset", "compose-font-scale", "compose-speed", "compose-offset", "compose-position",
    "compose-opacity", "compose-display-mode", "compose-color-mode",
    "compose-resolution", "compose-fps", "compose-bitrate", "compose-shadow",
    "compose-row-limit", "compose-duration", "compose-font-family", "compose-outline",
    "compose-ng-words", "compose-width", "compose-height", "compose-keep-aspect",
    "compose-preview-video", "compose-preview-canvas", "compose-preview-status",
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
  assert.match(renderer, /const fontFamily = \["ＭＳ Ｐゴシック", "Meiryo", "Yu Gothic UI", "BIZ UDPGothic", "Arial"\]/);
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
  assert.match(renderer, /api\.startCapture\(liveId, quality, \{/);
  assert.match(renderer, /displayName: selectedTarget && selectedTarget\.name \|\| currentProgramMetadata\.broadcasterName/);
  assert.match(renderer, /broadcasterId: selectedTarget && \(selectedTarget\.broadcasterId \|\| selectedTarget\.userId\)/);
  assert.match(renderer, /recordStartInProgress \|\| recordStartedAt \|\| videoCaptureState === "recording"/);
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
  assert.ok(html.includes("v" + packageConfig.version));
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
  assert.match(packageConfig.version, /^0\.1\.0-beta\.\d+$/);
  assert.ok(html.includes("v" + packageConfig.version));
  const betaNumber = packageConfig.version.split(".").pop();
  assert.ok(betaNumber, "package version must be a beta release");
  assert.ok(buildWorkflow.includes("Nico-Live-Message-Recorder-${{ steps.app-version.outputs.version }}-Windows"));
  assert.match(buildWorkflow, /Get-Content package\\.json -Raw \\| ConvertFrom-Json/);
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
    "articles-nav-button",
    "sidebar-settings-button"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing navigation control: ${id}`);
  }

  for (const page of ["dashboard", "monitor", "record", "comments", "compose", "library", "articles"]) {
    assert.match(html, new RegExp(`data-page="${page}"`), `missing page view: ${page}`);
    assert.match(html, new RegExp(`data-page-target="${page}"`), `missing page navigation: ${page}`);
  }

  assert.match(renderer, /function setActivePage\(page\)/);
  assert.match(renderer, /button\.dataset\.pageTarget/);
  assert.match(renderer, /if \(activePage === "library"\) loadCaptureLibrary\(\)/);
  assert.match(css, /\.content > \.page-hidden/);
  assert.doesNotMatch(renderer, /setLibraryView/);
});


test("monitor resumes detection when a stream is still live after an app restart", () => {
  assert.match(main, /const monitorObservedLiveIds = new Map\(\)/);
  assert.match(main, /const previouslyObservedLiveId = monitorObservedLiveIds\.get\(target\.userId\)/);
  assert.match(main, /previouslyObservedLiveId !== live\.liveId/);
  assert.doesNotMatch(main, /live && target\.lastProgramId !== live\.liveId/);
  assert.match(main, /pendingDetections: monitorPendingDetections\.splice/);
  assert.match(renderer, /result\.pendingDetections\.forEach\(handleMonitorLiveDetected\)/);
  assert.match(renderer, /monitorHandledDetections/);
});

test("automatic capture failure clears the live detection gate for retry", () => {
  assert.match(main, /if \(target\) monitorObservedLiveIds\.delete\(userId\)/);
  assert.match(renderer, /monitorHandledDetections\.delete\(String\(target\.userId/);
  assert.match(renderer, /api\.startCapture\(liveId, monitorSettings\.quality/);
});


test("broadcaster profile lookup never blocks live detection and immediate automatic capture", () => {
  assert.doesNotMatch(main, /const displayName = await resolveMonitorUserName/);
  assert.match(main, /void resolveMonitorUserName\(target, followedProgram, latest\)\.then/);
  assert.match(main, /queueMonitorDetection\(/);
});


test("application settings are grouped by capture, comments, and app behavior", () => {
  const settingsStart = html.indexOf('<div class="settings-sections">');
  const settingsEnd = html.indexOf('<div class="settings-actions">', settingsStart);
  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, "grouped settings dialog must exist");
  const settings = html.slice(settingsStart, settingsEnd);
  for (const heading of ["配信監視・自動録画", "コメント保存", "アプリ動作・更新"]) {
    assert.ok(settings.includes(heading), "missing settings group: " + heading);
  }
  for (const id of [
    "setting-monitor-interval", "setting-monitor-quality", "setting-auto-record",
    "setting-auto-start", "setting-comment-format", "setting-run-at-startup",
    "setting-close-to-tray", "setting-keep-awake", "setting-auto-update-streamlink",
    "setting-notify-on-live"
  ]) {
    assert.ok(settings.includes('id="' + id + '"'), "settings control not grouped: " + id);
  }
});

test("comment video generation controls are separated into three clear groups", () => {
  const groupsStart = html.indexOf('<div class="compose-editor-grid">');
  const groupsEnd = html.indexOf('<p class="hint">NicoConvAss', groupsStart);
  assert.ok(groupsStart >= 0 && groupsEnd > groupsStart, "composition setting groups must exist");
  const groups = html.slice(groupsStart, groupsEnd);
  for (const heading of ["コメント表示", "文字スタイル", "同期・出力"]) {
    assert.ok(groups.includes(heading), "missing composition group: " + heading);
  }
  for (const id of [
    "compose-font-scale", "compose-font-size", "compose-speed", "compose-row-limit", "compose-duration",
    "compose-overlap-protection", "compose-lane-gap",
    "compose-font-family", "compose-color-mode", "compose-ng-words", "compose-offset",
    "compose-resolution", "compose-output-format", "compose-output-quality"
  ]) {
    assert.ok(groups.includes('id="' + id + '"'), "composition control not grouped: " + id);
  }
  assert.match(css, /\.compose-settings-group-grid/);
  assert.match(renderer, /function refreshComposePreview\(\)/);
  assert.match(renderer, /drawCommentOverlay\(context, composePreviewSchedule, active/);
  assert.match(renderer, /scheduleComposePreviewRefresh/);
  assert.match(html, /リアルタイムプレビュー/);
  assert.match(css, /\.compose-preview-stage/);
});


test("grouped settings explanatory text closes before the dialog actions", () => {
  const noteStart = html.indexOf('<p class="hint settings-note">');
  const noteEnd = html.indexOf("</p>", noteStart);
  assert.ok(noteStart >= 0 && noteEnd > noteStart, "settings note must be present and closed");
  const afterNote = html.slice(noteEnd + 4).trimStart();
  assert.ok(afterNote.startsWith('<div class="settings-actions">'), "settings actions must follow a balanced note");
  assert.doesNotMatch(html, /<\/p>ログイン中はフォロー中番組API/);
});


test("Windows notifications report detected LIVE and automatic recording results", () => {
  assert.match(main, /Notification,?\s*\} = require\("electron"\)/);
  assert.match(main, /app\.setAppUserModelId\("jp\.kanenao\.nicolive\.recorder"\)/);
  assert.match(main, /function showDesktopNotification\(/);
  assert.match(main, /Notification\.isSupported\(\)/);
  assert.match(main, /function queueMonitorDetection\([\s\S]*showDesktopNotification\("配信開始を検知しました"/);
  assert.match(main, /function notifyMonitorRecordingResult\(/);
  assert.match(main, /failure-already-notified/);
  assert.match(main, /ipcMain\.handle\("monitor:notify-recording-result"/);
  assert.match(preload, /notifyMonitorRecordingResult:.*ipcRenderer\.invoke\("monitor:notify-recording-result"/);
  assert.match(renderer, /api\.notifyMonitorRecordingResult\(\{\s*status: "started"/);
  assert.match(renderer, /api\.notifyMonitorRecordingResult\(\{\s*status: "failed"/);
  assert.match(main, /notifyOnLive: stored\.notifyOnLive !== false/);
  assert.match(main, /notifyOnLive: candidate\.notifyOnLive !== false/);
  assert.match(main, /notifyOnLive: true/);
});


test("registered broadcaster broadcast articles are stored locally and available in a dedicated page", () => {
  assert.match(main, /require\("\.\/articles\.cjs"\)/);
  assert.match(main, /generateBroadcastArticle\(/);
  assert.match(main, /function createAndSaveBroadcastArticle\(/);
  assert.match(main, /function listBroadcastArticles\(/);
  assert.match(main, /path\.join\(dataRoot\(\), "articles"/);
  assert.match(main, /ipcMain\.handle\("articles:list"/);
  assert.match(main, /ipcMain\.handle\("articles:generate-from-comment"/);
  assert.match(preload, /getBroadcastArticles:.*ipcRenderer\.invoke\("articles:list"/);
  assert.match(preload, /generateBroadcastArticle:.*ipcRenderer\.invoke\("articles:generate-from-comment"/);
  assert.match(renderer, /function renderBroadcastArticles\(/);
  assert.match(renderer, /api\.getBroadcastArticles\(\)/);
  assert.match(renderer, /api\.generateBroadcastArticle\(item\.path\)/);
  assert.match(main, /await createAndSaveBroadcastArticle/);
  assert.match(html, /data-page-target="articles"/);
  assert.match(html, /id="articles-panel"[^>]*data-page="articles"/);
  assert.match(html, /id="articles-search"/);
});

test("live article stop generates a final ended-state article before closing the comment log", () => {
  const stopStart = main.indexOf("async function stopLiveArticleSession()");
  const stopEnd = main.indexOf('ipcMain.handle("articles:live-stop"', stopStart);
  const stopHandler = main.slice(stopStart, stopEnd);
  assert.match(stopHandler, /while \(articleUpdateInProgress\)/);
  assert.match(stopHandler, /refreshLiveBroadcastArticle\(\{ finalize: true \}\)/);
  assert.ok(stopHandler.indexOf("refreshLiveBroadcastArticle") < stopHandler.indexOf("await closeCommentWriter"));
  assert.match(main, /liveStatus: options\.finalize \? "ended" : "live"/);
  assert.match(main, /state: options\.finalize \? "finalized" : "updated"/);
});

test("articles are refreshed after recording and comment logs are closed", () => {
  assert.match(main, /await appendMarkerAndWait\("videoStop"/);
  assert.match(main, /await createAndSaveBroadcastArticle\(commentFilePath,\s*\{/);
  assert.match(main, /await createAndSaveBroadcastArticle\(commentFilePath, articleContext, \{/);
  assert.match(renderer, /channel === "articles:generated"/);
  assert.match(renderer, /if \(activePage === "articles"\) loadBroadcastArticles\(\)/);
});

test("article page explains local comment-based summaries and does not claim speech transcription", () => {
  assert.match(html, /記事はこのPC内に保存されます/);
  assert.match(html, /文字起こししたものではありません/);
  assert.match(css, /\.broadcast-article-card/);
});


test("app settings expose the current version and a synchronized automatic update panel", () => {
  for (const id of [
    "app-current-version",
    "settings-update-badge",
    "settings-update-status",
    "settings-update-progress",
    "settings-latest-version-row",
    "settings-latest-version",
    "settings-check-update-button",
    "settings-install-update-button"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing app update field: " + id);
  }
  assert.match(renderer, /settingsStatus\.textContent = status\.textContent/);
  assert.match(renderer, /settingsProgress\.value = progress\.value/);
  assert.match(renderer, /settingsCheckButton\.disabled = checkButton\.disabled/);
  assert.match(renderer, /const latestVersion = payload\.version \|\| latestVersionLabel\.textContent\.replace/);
  assert.match(renderer, /byId\("settings-check-update-button"\)\.addEventListener\("click", checkAppUpdates\)/);
  assert.match(renderer, /byId\("settings-install-update-button"\)\.addEventListener\("click", installAppUpdate\)/);
  assert.match(renderer, /byId\("app-current-version"\)\.textContent = text/);
  assert.match(css, /\.app-update-settings/);
  assert.match(css, /\.update-state-badge\[data-state="downloaded"\]/);
});


test("dedicated version update page shows the current version, updater controls, and bundled release history", () => {
  assert.match(html, /data-page-target="updates"/);
  assert.match(html, /id="updates-panel"[^>]*data-page="updates"/);
  for (const id of ["app-current-version", "settings-update-badge", "settings-update-status",
    "settings-update-progress", "settings-latest-version", "settings-check-update-button",
    "settings-install-update-button", "release-history-list", "settings-open-updates-button", "open-github-releases-button"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing version page field: " + id);
  }
  assert.match(renderer, /"articles", "updates"/);
  assert.match(renderer, /function parseReleaseHistory\(/);
  assert.match(renderer, /function renderReleaseHistory\(/);
  assert.match(renderer, /api\.getChangelog\(\)/);
  assert.match(preload, /getChangelog:.*ipcRenderer\.invoke\("app:changelog"/);
  assert.match(preload, /openGitHubReleases:.*ipcRenderer\.invoke\("app:open-releases"/);
  assert.match(main, /ipcMain\.handle\("app:open-releases"/);
  assert.match(main, /shell\.openExternal\(releasesUrl\)/);
  assert.match(renderer, /api\.openGitHubReleases\(\)/);
  assert.match(main, /ipcMain\.handle\("app:changelog"/);
  assert.ok(packageConfig.build.files.includes("CHANGELOG.md"));
  assert.match(css, /\.release-history-item/);
});

test("dashboard live count retains registered-target count after manual capture cards are merged", () => {
  assert.match(renderer, /function renderDashboardStats\(\) \{\s*const targets = Array\.isArray\(monitorSettings\.targets\)/);
  assert.match(renderer, /record\.title = status\.isRecording[\s\S]*この配信は現在録画中です/);
});

test("a live article is generated immediately when program metadata is already available", () => {
  assert.match(main, /if \(currentProgramInfo\.programTitle \|\| currentProgramInfo\.description\) \{\s*void refreshLiveBroadcastArticle\(\);\s*\}/);
});


test("comment video composition uses a Nico-style font, adjustable pixel size, and collision-safe lanes", () => {
  for (const id of [
    "compose-font-size",
    "compose-font-size-value",
    "compose-overlap-protection",
    "compose-lane-gap",
    "compose-lane-gap-value",
    "compose-pixels-per-second"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing comment style control: " + id);
  }
  assert.match(html, /<option value="ＭＳ Ｐゴシック" selected>ニコ生風/);
  assert.match(renderer, /baseFontSize: number\("compose-font-size", 64, 18, 96\)/);
  assert.match(renderer, /overlapProtection: byId\("compose-overlap-protection"\)\.checked/);
  assert.match(renderer, /laneGapMs: number\("compose-lane-gap", 80, 0, 500\)/);
  assert.match(renderer, /scrollSpeedPxPerSecond: number\("compose-pixels-per-second", 330, 80, 1000\)/);
  assert.match(renderer, /function calculateCompositionOutputSize\(/);
  assert.match(renderer, /calculateCompositionOutputSize\(video\.videoWidth, video\.videoHeight, options\)/);
  assert.match(renderer, /calculateCompositionOutputSize\(sourceWidth, sourceHeight, composeOptions\)/);
  assert.match(renderer, /"compose-pixels-per-second"[\s\S]*"compose-resolution"[\s\S]*"compose-keep-aspect"/);
  assert.match(renderer, /\(\(width \+ textWidth\) \/ pixelsPerSecond\) \* 1000/);
  assert.match(renderer, /calculateCommentLaneLayout\(/);
  assert.match(renderer, /layout\.scrollLaneYs\[lane\]/);
  assert.match(renderer, /layout\.topLaneYs\[lane\]/);
  assert.match(renderer, /layout\.bottomLaneYs\[lane\]/);
  assert.match(composition, /function calculateCommentLaneLayout\(/);
  assert.match(composition, /const lineHeight = Math\.max\(24/);
  assert.match(composition, /function calculateScrollCommentHeadway\(/);
  assert.match(renderer, /calculateScrollCommentHeadway\(/);
  assert.match(renderer, /red2: "#cc0033"/);
});

test("standalone article generation is available without monitor registration and accepts optional JSONL comments and video frames", () => {
  assert.match(main, /function generateStandaloneBroadcastArticle\(/);
  assert.match(main, /async function enhanceBroadcastArticleWithOllama\(/);
  assert.match(main, /ipcMain\.handle\("articles:generate-manual"/);
  assert.match(preload, /generateManualBroadcastArticle:.*ipcRenderer\.invoke\("articles:generate-manual"/);
  assert.match(renderer, /function generateManualBroadcastArticle\(/);
  assert.match(renderer, /api\.generateManualBroadcastArticle\(/);
  assert.match(html, /id="manual-article-generate-button"/);
  assert.match(html, /id="manual-article-file"/);
  assert.match(main, /force: true/);
  assert.match(main, /articles", "_manual"/);
  assert.match(main, /async function extractArticleVideoFrames\(/);
  assert.match(main, /const frameRate = \(targetFrames \/ durationSeconds\)/);
  assert.match(main, /articles:select-video/);
  assert.match(main, /async function startLiveArticleSession\(/);
  assert.match(main, /async function stopLiveArticleSession\(/);
  assert.match(main, /capturePage\(\)/);
  assert.match(main, /LIVE_ARTICLE_REFRESH_INTERVAL_MS = 2 \* 60 \* 1000/);
  assert.match(main, /LIVE_ARTICLE_FRAME_INTERVAL_MS = 15 \* 1000/);
  assert.match(main, /LIVE_ARTICLE_MAX_FRAMES = 16/);
  assert.match(main, /void refreshLiveBroadcastArticle\(\);/);
  assert.match(main, /articleRefreshPending = true/);
  assert.match(main, /state: "error", liveId/);
  assert.match(renderer, /channel === "articles:live-state"/);
  assert.match(renderer, /15秒ごとに取得します/);
  assert.match(preload, /startLiveArticleSession:.*ipcRenderer\.invoke\("articles:live-start"/);
  assert.match(preload, /stopLiveArticleSession:.*ipcRenderer\.invoke\("articles:live-stop"/);
  assert.match(renderer, /api\.startLiveArticleSession\(/);
  assert.match(renderer, /api\.stopLiveArticleSession\(/);
  assert.match(html, /id="manual-article-live-start-button"/);
  assert.match(html, /id="manual-article-live-stop-button"/);
  assert.match(preload, /selectArticleVideo:.*ipcRenderer\.invoke\("articles:select-video"/);
  assert.match(renderer, /api\.selectArticleVideo\(\)/);
  assert.match(html, /id="manual-article-video-select-button"/);
  assert.match(ollamaSource, /images: imageFrames.map/);
  assert.match(main, /item.name === "qwen2.5vl:3b"/);
  assert.ok(main.includes("capturedAt: new Date().toISOString()"));
  assert.match(ollamaSource, /frameTimeline/);
  assert.ok(ollamaSource.includes('frame => typeof frame === "string" ? frame : String(frame && frame.image'));
});

test("manual article generation can combine Whisper audio transcript, video frames, and Nico comments", () => {
  assert.match(main, /require\("\.\/audio-transcription\.cjs"\)/);
  assert.match(main, /transcribeVideoAudio\(/);
  assert.match(main, /audioTranscript: audioTranscript \? audioTranscript\.text : ""/);
  assert.match(main, /article\.audioTranscript = String\(options\.audioTranscript\)/);
  assert.match(main, /articles:select-whisper-cli/);
  assert.match(main, /articles:select-whisper-model/);
  assert.match(preload, /selectArticleWhisperCli/);
  assert.match(preload, /selectArticleWhisperModel/);
  assert.match(preload, /downloadArticleWhisper/);
  assert.match(main, /installWhisperAutomatically/);
  assert.match(main, /runtimeSha256/);
  assert.match(main, /modelSha1/);
  assert.match(main, /whisper:download-progress/);
  assert.match(html, /manual-article-whisper-auto-button/);
  assert.match(renderer, /downloadArticleWhisper/);
  assert.match(renderer, /selectArticleWhisperCli/);
  assert.match(renderer, /selectArticleWhisperModel/);
  assert.match(html, /manual-article-whisper-cli-button/);
  assert.match(html, /manual-article-whisper-model-button/);
  assert.match(ollamaSource, /音声認識テキスト/);
  assert.match(ollamaSource, /映像・音声・コメントの情報源を混同しない/);
  assert.match(audioTranscription, /"-ac", "1", "-ar", "16000"/);
  assert.match(audioTranscription, /"-l", "ja"/);
  assert.match(audioTranscription, /parseWhisperJson/);
});


test("AI article cards render a newspaper-style lead, highlights, timeline, and audience reaction", () => {
  assert.match(renderer, /broadcast-article-lead/);
  assert.match(renderer, /broadcast-article-highlights/);
  assert.match(renderer, /broadcast-article-timeline/);
  assert.match(renderer, /broadcast-article-reaction/);
  assert.match(renderer, /articles-status-filter/);
  assert.match(renderer, /articles-sort/);
  assert.match(renderer, /broadcast-article-tags/);
  assert.match(renderer, /broadcast-article-topics/);
  assert.match(renderer, /article\.summary, article\.note, article\.aiAudienceReaction/);
  assert.match(main, /aiCommentSampleCount/);
  assert.match(main, /aiCommentTotalCount/);
  assert.match(ollamaSource, /selectRepresentativeComments/);
  assert.match(ollamaSource, /放送時間全体に分散/);
  assert.match(ollamaSource, /highlights/);
  assert.match(ollamaSource, /audienceReaction/);
  assert.match(main, /capturedAt: timestamp/);
});


test("live broadcast article session integrates Whisper.cpp audio capture and final transcription", () => {
  assert.match(main, /startLiveArticleAudioCapture\(liveId\)/);
  assert.match(main, /stopLiveArticleAudioCapture\(currentLiveId\)/);
  assert.match(main, /audioTranscript: liveArticleAudioTranscript/);
  assert.match(main, /audio-transcribing/);
  assert.match(main, /audioCapturing: Boolean\(liveArticleAudioProcess\)/);
  assert.match(renderer, /audio-capturing/);
  assert.match(renderer, /Whisper\.cpp/);
  assert.match(html, /音声解析用データは一時保存し、終了後に削除/);
});


test("Ollama setup downloads the official Windows installer and pulls the selected model through the local API", () => {
  const setup = fs.readFileSync(path.join(root, "electron", "ollama-setup.cjs"), "utf8");
  assert.match(main, /ollama:download-installer/);
  assert.match(main, /ollama:pull-model/);
  assert.match(preload, /downloadOllamaInstaller/);
  assert.match(preload, /pullOllamaModel/);
  assert.match(renderer, /ollama-install-button/);
  assert.match(renderer, /ollama-pull-model-button/);
  assert.match(html, /id="ollama-install-button"/);
  assert.match(html, /id="ollama-pull-model-button"/);
  assert.ok(setup.includes("https://ollama.com/download/OllamaSetup.exe"));
  assert.match(setup, /\/api\/pull/);
  assert.match(main, /ollama:setup-progress/);
  assert.match(setup, /onProgress/);
});


test("article summaries are attached to capture library videos and article deletion preserves source recordings", () => {
  assert.match(main, /const savedArticles = listBroadcastArticles\(\)\.items/);
  assert.match(main, /ipcMain\.handle\("articles:delete"/);
  assert.match(main, /録画動画・コメントログは削除されません/);
  assert.match(preload, /deleteBroadcastArticle/);
  assert.match(renderer, /library-article-summary/);
  assert.match(renderer, /api\.deleteBroadcastArticle\(article\.articlePath\)/);
  assert.match(main, /article\.articlePath = fullPath/);
});
test("Streamlink waits for media bytes and preserves stderr when capture startup fails", () => {
  assert.match(main, /const startupDeadline = Date\.now\(\) \+ 25000/);
  assert.match(main, /fs\.statSync\(outputPath\)\.size > 0/);
  assert.match(main, /streamlinkStderr = \(streamlinkStderr \+ chunk\.toString/);
  assert.match(main, /Streamlink詳細:/);
});
test("duplicate library IDs are removed and package version is displayed in the UI", () => {
  assert.equal((html.match(/id="library-list"/g) || []).length, 1);
  assert.ok(html.includes(packageConfig.version));
});


test("article HTML export escapes untrusted text and includes analysis sections", () => {
  const html = articleExport.renderArticleHtml({
    title: '<script>alert("x")</script>',
    summary: "概要",
    paragraphs: ["本文の段落"],
    aiHighlights: ["注目点"],
    aiTimeline: [{ time: "00:01:02", detail: "場面の説明" }],
    topics: ["ゲーム"],
    audioTranscript: "文字起こし"
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  for (const value of ["概要", "本文の段落", "注目点", "00:01:02", "場面の説明", "ゲーム", "文字起こし"]) {
    assert.ok(html.includes(value), "missing exported article content: " + value);
  }
});
test("article export is exposed through a save dialog and preload bridge", () => {
  assert.match(main, /ipcMain\.handle\("articles:export-html"/);
  assert.match(main, /dialog\.showSaveDialog/);
  assert.match(main, /articleExport\.renderArticleHtml/);
  assert.match(preload, /exportBroadcastArticleHtml:.*ipcRenderer\.invoke\("articles:export-html"/);
  assert.match(renderer, /api\.exportBroadcastArticleHtml\(article\)/);
});


test("live article capture uses a hidden window and does not open the visible watch preview", () => {
  assert.match(main, /async function openHiddenLiveArticleCapture/);
  assert.match(main, /show:\s*false/);
  assert.match(main, /offscreen:\s*true/);
  assert.match(main, /async function shutdownGracefully[\s\S]*closeHiddenLiveArticleCapture/);
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.match(main, /captureLiveArticleFrame[\s\S]*liveArticleCaptureWindow\.webContents\.capturePage/);
  assert.match(main, /await openHiddenLiveArticleCapture\(liveId\)/);
  assert.doesNotMatch(main.match(/async function startLiveArticleSession[\s\S]*?\n}\n/)?.[0] || "", /openLivePreview/);
  assert.match(main, /function safeLiveId[\s\S]*allowedHosts/);
  assert.match(html, /manual-article-live-id[^>]*maxlength="2048"/);
  assert.match(html, /視聴ページは画面に表示せず/);
});

test("AI broadcast article prompt follows the Kick editorial structure while preserving source checks", () => {
  const ollama = fs.readFileSync(path.join(root, "electron", "ollama.cjs"), "utf8");
  assert.match(ollama, /Kick-Live-Message-RecorderのAI記事のように/);
  assert.match(ollama, /summaryは結論と重要点を含むリード文/);
  assert.match(ollama, /highlights/);
  assert.match(ollama, /audienceReaction/);
  assert.match(ollama, /映像・音声・コメントの情報源を混同しない/);
});


test("primary recording controls remain bound when Electron event subscription fails", () => {
  const eventSubscription = renderer.indexOf("try {\\n  if (!api || typeof api.onEvent !== \\"function\\")");
  const primaryBindings = renderer.indexOf('connectButton.addEventListener("click", connectLive)');
  assert.ok(eventSubscription >= 0, "event subscription is guarded");
  assert.ok(primaryBindings > eventSubscription, "primary controls are bound after guarded event subscription");
  assert.match(renderer, /Electron preload bridge のイベントAPIを利用できません/);
  assert.match(renderer, /event bridge initialization failed/);
  assert.match(preload, /connectLive: \\(liveId\\) => ipcRenderer\\.invoke\\("live:connect"/);
  assert.match(preload, /startCapture: \\(liveId, quality, options\\) => ipcRenderer\\.invoke\\("capture:start"/);
  assert.match(preload, /startVideo: \\(liveId, quality, options\\) => ipcRenderer\\.invoke\\("video:start"/);
  assert.match(main, /ipcMain\\.handle\\("live:connect"/);
  assert.match(main, /ipcMain\\.handle\\("capture:start"/);
  assert.match(main, /ipcMain\\.handle\\("video:start"/);
});
