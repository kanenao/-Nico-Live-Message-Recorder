"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const renderer = fs.readFileSync(path.join(__dirname, "../renderer.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

const compose = renderer.slice(
  renderer.indexOf("async function composeCommentVideo()"),
  renderer.indexOf("for (const id of [\"compose-font-scale\"", renderer.indexOf("async function composeCommentVideo()"))
);

test("silent MediaRecorder inactive state cannot leave comment-video generation pending forever", () => {
  assert.match(compose, /if \(recorder\.state === "inactive"\) \{\s*stopRecorder\(new Error\(/);
  assert.match(compose, /recordingStopRequestedAt/);
  assert.match(compose, /recorderStopTimer = window\.setTimeout/);
  assert.match(compose, /resolveStopFailure\(\{ error:/);
  assert.match(compose, /recorderStopEntered = true/);
});

test("Blob conversion, IPC writes, final flush and cancellation have deadlines", () => {
  assert.match(compose, /withDeadline\(\(\) => chunk\.arrayBuffer\(\), 45000/);
  assert.match(compose, /withDeadline\(\(\) => audioContext\.resume\(\), 15000/);
  assert.match(compose, /withDeadline\(\(\) => audioContext\.close\(\), 15000/);
  assert.match(compose, /withDeadline\(\(\) => api\.writeComposeChunk\(buffer\), SAVE_STALL_MS/);
  assert.match(compose, /withDeadline\(\(\) => chunkQueue, SAVE_STALL_MS/);
  assert.match(compose, /withDeadline\(\(\) => api\.cancelCompose\(\), SAVE_STALL_MS/);
  assert.match(compose, /if \(pendingChunks > 32\)/);
  assert.match(compose, /PLAYBACK_STALL_MS = 45000/);
});

test("long FFmpeg encoding waits for progress instead of using a fixed video-duration timeout", () => {
  assert.match(renderer, /lastCompositionBackendStatusAt = Date\.now\(\)/);
  assert.match(compose, /withBackendProgressDeadline\(\(\) => api\.finishCompose\(\)\)/);
  assert.match(compose, /Date\.now\(\) - lastCompositionBackendStatusAt > stallMs/);
  assert.match(main, /const stallWatchdog = setInterval\(/);
  assert.match(main, /lastAdvanceAt = Date\.now\(\)/);
  assert.match(main, /state: "progress"/);
  assert.doesNotMatch(compose, /15 \* 60 \* 1000, "動画の保存とMP4変換"/);
});

test("composition UI distinguishes real-time rendering, remaining playback, and MP4 conversion", () => {
  assert.match(compose, /映像とコメントを合成中/);
  assert.match(compose, /残り約/);
  assert.match(compose, /保存・MP4変換/);
  assert.match(renderer, /if \(channel === "compose:status" && payload\)/);
});

test("canvas draw exceptions are bounded instead of silently stopping the render loop", () => {
  const vm = require("node:vm");
  const start = compose.indexOf("const drawFrame = () => {");
  const end = compose.indexOf("\n    const recorderOptions =", start);
  assert.ok(start >= 0 && end > start, "drawFrame must be extractable");
  let queued = 0;
  const errors = [];
  const sandbox = {
    cancelRequested: false,
    videoElement: { ended: false, readyState: 4, currentTime: 1, paused: false },
    lastPlaybackTime: 0,
    lastPlaybackAdvanceAt: Date.now(),
    lastRenderedFrameAt: Date.now(),
    consecutiveFrameErrors: 0,
    context: { drawImage() { throw new Error("GPU unavailable"); } },
    canvas: { width: 1280, height: 720 },
    nextCommentIndex: 0,
    activeComments: [],
    schedule: [],
    drawCommentOverlay() {},
    composeOptions: {},
    durationMs: 10000,
    lastProgressUpdate: 0,
    animationFrame: 0,
    requestAnimationFrame() { queued += 1; return queued; },
    scheduleNextFrame() { queued += 1; },
    stopRecorder(error) { errors.push(error); },
    setCompositionProgress() {}
  };
  const drawFrame = vm.runInNewContext(compose.slice(start, end) + "\ndrawFrame", sandbox);
  drawFrame();
  assert.equal(queued, 1, "a transient canvas error should schedule a retry");
  assert.equal(errors.length, 0);
  for (let i = 0; i < 4; i++) drawFrame();
  assert.equal(errors.length, 1, "five consecutive failures must stop the recorder");
  assert.match(errors[0].message, /映像フレームを5回連続で描画できませんでした/);
  assert.equal(queued, 4, "the failure threshold should not queue another frame");
});

test("frame rendering failure is monitored separately from playback progress", () => {
  assert.match(compose, /let lastRenderedFrameAt = Date\.now\(\)/);
  assert.match(compose, /const FRAME_STALL_MS = 45000/);
  assert.match(compose, /lastRenderedFrameAt = Date\.now\(\)/);
  assert.match(compose, /isCompositionStalled\(\s*lastRenderedFrameAt, Date\.now\(\), FRAME_STALL_MS\)/);
  assert.match(compose, /映像の描画が45秒以上更新されませんでした/);
  // Keep both checks so moving timestamps cannot mask an unresponsive canvas.
  assert.match(compose, /isCompositionStalled\(\s*lastPlaybackAdvanceAt, Date\.now\(\), PLAYBACK_STALL_MS\)/);
});
