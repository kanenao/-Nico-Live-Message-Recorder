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
