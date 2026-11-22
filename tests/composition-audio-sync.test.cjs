"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const mainExport = fs.readFileSync(path.join(root, "electron", "composition-export.cjs"), "utf8");
const start = renderer.indexOf("async function composeCommentVideo()");
const end = renderer.indexOf('for (const id of ["compose-font-scale"', start);
const compose = renderer.slice(start, end);

test("uses original media-element audio as the primary synchronized audio source", () => {
  assert.ok(start >= 0 && end > start);
  assert.match(compose, /sourceMediaStream = videoElement\.captureStream\(\)/);
  assert.match(compose, /sourceMediaStream\.getAudioTracks\(\)/);
  assert.match(compose, /audioTracks\.push\(sourceAudioTrack\)/);
  assert.match(compose, /videoElement\.muted = true/);
  assert.match(compose, /videoElement\.volume = 0/);
  assert.match(compose, /sourceMediaStream\.getVideoTracks\(\)\.forEach/);
  assert.match(compose, /元動画の音声トラックを使用して映像・コメントを同期中/);
});

test("uses Web Audio only as a compatibility fallback", () => {
  const directStart = compose.indexOf('if (typeof videoElement.captureStream === "function")');
  const fallbackStart = compose.indexOf("if (!audioTracks.length && useAudioContextFallback)");
  const finalStreamStart = compose.indexOf("finalStream = new MediaStream([");
  assert.ok(directStart >= 0 && fallbackStart > directStart && finalStreamStart > fallbackStart);
  const fallback = compose.slice(fallbackStart, finalStreamStart);
  assert.match(fallback, /createMediaElementSource/);
  assert.match(fallback, /互換音声モード/);
});

test("uses decoded video-frame callbacks for canvas rendering when available", () => {
  assert.match(compose, /videoElement\.requestVideoFrameCallback/);
  assert.match(compose, /videoElement\.cancelVideoFrameCallback/);
  assert.match(compose, /scheduleNextFrame\(\)/);
  assert.match(compose, /requestAnimationFrame\(drawFrame\)/);
});

test("releases source media tracks and fixes playback rate to normal speed", () => {
  assert.match(compose, /if \(sourceMediaStream\) sourceMediaStream\.getTracks\(\)\.forEach/);
  assert.match(compose, /videoElement\.playbackRate = 1/);
});

test("MP4 conversion preserves the captured video frame timestamps", () => {
  assert.match(mainExport, /"-fps_mode:v", "passthrough"/);
});
