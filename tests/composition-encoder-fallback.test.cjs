"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { supportedCompositionMimeTypes } = require("../composition.js");

const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
const start = renderer.indexOf("async function composeCommentVideo()");
const end = renderer.indexOf('for (const id of ["compose-font-scale"', start);
const compose = renderer.slice(start, end);

test("audio capture prefers broadly compatible VP8/Opus before VP9/Opus", () => {
  const supported = supportedCompositionMimeTypes({
    isTypeSupported(type) { return type.startsWith("video/webm"); }
  }, true);
  assert.equal(supported[0], "video/webm;codecs=vp8,opus");
  assert.ok(supported.indexOf("video/webm;codecs=vp9,opus") > 0);
  assert.ok(supported.includes("video/webm"));
});

test("silent video prefers VP8 without requiring an Opus audio encoder", () => {
  const supported = supportedCompositionMimeTypes({
    isTypeSupported(type) { return type === "video/webm;codecs=vp8"; }
  }, false);
  assert.deepEqual(supported, ["video/webm;codecs=vp8"]);
});

test("codec capability probe tolerates unavailable APIs and throwing drivers", () => {
  assert.deepEqual(supportedCompositionMimeTypes(null, true), []);
  assert.deepEqual(supportedCompositionMimeTypes({}, true), []);
  const supported = supportedCompositionMimeTypes({
    isTypeSupported(type) {
      if (type.includes("vp8")) throw new Error("driver exception");
      return type === "video/webm;codecs=vp9,opus";
    }
  }, true);
  assert.deepEqual(supported, ["video/webm;codecs=vp9,opus"]);
});

test("rendering retries another codec when MediaRecorder constructor or start fails", () => {
  assert.ok(start >= 0 && end > start);
  assert.match(compose, /supportedCompositionMimeTypes\(\s*MediaRecorder, audioTracks\.length > 0/);
  assert.match(compose, /for \(let index = 0; index < supportedMimeTypes\.length; index \+= 1\)/);
  assert.match(compose, /for \(let index = selectedMimeIndex; index < supportedMimeTypes\.length; index \+= 1\)/);
  assert.match(compose, /candidateRecorder\.start\(1000\)/);
  assert.match(compose, /candidateRecorder\.onstop = recorderHandlers\.onstop/);
  assert.match(compose, /candidateRecorder\.onstop = null/);
  assert.match(compose, /if \(!encoderStarted\)/);
});

test("composition preserves the cause of an error on the screen after a toast disappears", () => {
  assert.match(compose, /setCompositionProgress\(0, "生成エラー：" \+ message\)/);
  assert.match(compose, /showToast\(message, true\)/);
});
