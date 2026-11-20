"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const composition = require("../composition.js");

test("video composer monitors video currentTime and prevents endless loading or decoder stalls", () => {
  assert.equal(typeof composition.isCompositionStalled, "function");
  assert.match(renderer, /const PLAYBACK_STALL_MS = 90000/);
  assert.match(renderer, /playbackWatchdog = window\.setInterval\(/);
  assert.match(renderer, /nicoCommentComposition\.isCompositionStalled\(/);
  assert.match(renderer, /videoElement\.currentTime/);
  assert.match(renderer, /lastPlaybackAdvanceAt = Date\.now\(\)/);
  assert.match(renderer, /videoElement\.ended \|\| current \* 1000 >= durationMs - 150/);
  assert.match(renderer, /videoElement\.addEventListener\("error"/);
  assert.match(renderer, /動画の再生位置が90秒以上進みませんでした/);
  assert.match(renderer, /動画の再生開始が30秒以上応答しませんでした/);
  assert.match(renderer, /clearInterval\(playbackWatchdog\)/);
});

test("MediaRecorder stop, chunk IPC and cleanup all have bounded waits and errors", () => {
  assert.match(renderer, /let recorderStopTimer = null/);
  assert.match(renderer, /recorder\.onstop = async/);
  assert.match(renderer, /recorderStopEntered = true/);
  assert.match(renderer, /動画エンコーダーが停止通知を返しませんでした/);
  assert.match(renderer, /pendingChunks > 32/);
  assert.match(renderer, /保存待ちデータが増えすぎました/);
  assert.match(renderer, /chunkQueue = chunkQueue\.then/);
  assert.match(renderer, /Promise\.race\(\[/);
  assert.match(renderer, /動画データの保存が120秒以上応答しません/);
  assert.match(renderer, /stopRecorder\(error\)/);
  assert.match(renderer, /await api\.cancelCompose\(\)\.catch/);
  assert.match(renderer, /await cleanup\(\)/);
});

test("Electron writer and FFmpeg conversion cannot wait indefinitely", () => {
  assert.match(main, /function finishCompositionWriter\(writer, timeoutMs = 120000\)/);
  assert.match(main, /writer\.once\("finish"/);
  assert.match(main, /writer\.once\("close"/);
  assert.match(main, /writer\.once\("error"/);
  assert.match(main, /await finishCompositionWriter\(writer\)/);
  assert.match(main, /if \(!written\.isFile\(\) \|\| written\.size <= 0\)/);
  assert.match(main, /writer\.destroy\(error\)/);
  assert.match(main, /isCompositionStalled\(lastAdvanceAt, Date\.now\(\), 180000\)/);
  assert.match(main, /child\.kill\("SIGKILL"\)/);
  assert.match(main, /lastOutputTime = outputTime/);
  assert.match(main, /MP4変換が3分間進みませんでした/);
  assert.match(main, /fallbackPath = makeWebmFallbackPath\(finalPath\)/);
  assert.match(main, /await fs\.promises\.rename\(savedPath, fallbackPath\)/);
});
