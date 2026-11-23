"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { supportedCompositionMimeTypes, compositionEncoderCandidates,
  isUnexpectedCompositionStop } = require("../composition.js");

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
  assert.match(compose, /compositionEncoderCandidates\(/);
  assert.match(compose, /for \(let index = 0; index < encoderCandidates\.length; index \+= 1\)/);
  assert.match(compose, /for \(let index = selectedCandidateIndex; index < encoderCandidates\.length; index \+= 1\)/);
  assert.match(compose, /candidateRecorder\.start\(1000\)/);
  assert.match(compose, /candidateRecorder\.onstop = recorderHandlers\.onstop/);
  assert.match(compose, /candidateRecorder\.onstop = null/);
  assert.match(compose, /if \(!encoderStarted\)/);
});

test("composition preserves the cause of an error on the screen after a toast disappears", () => {
  assert.match(compose, /setCompositionProgress\(0, "生成エラー：" \+ message\)/);
  assert.match(compose, /showToast\(message, true\)/);
});

test("retries a start-time codec failure in an executable mock", () => {
  const from = compose.indexOf("    const recorderHandlers = {");
  const to = compose.indexOf("    cancelButton.disabled = false;", from);
  assert.ok(from >= 0 && to > from);
  const created = [];
  class FakeMediaRecorder {
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.state = "inactive";
      created.push(this);
    }
    start() {
      if (this.mimeType === "vp8") throw new Error("driver refused VP8");
      this.state = "recording";
    }
    stop() { this.state = "inactive"; }
  }
  const first = new FakeMediaRecorder({}, { mimeType: "vp8" });
  first.ondataavailable = () => {};
  first.onstop = () => {};
  first.onerror = () => {};
  const sandbox = {
    recorder: first, MediaRecorder: FakeMediaRecorder,
    selectedCandidateIndex: 0, encoderCandidates: [{ mimeType: "vp8", videoBitsPerSecond: 6000000 }, { mimeType: "vp9", videoBitsPerSecond: 6000000 }],
    finalStream: {}, recorderOptions: {}, composeOptions: { bitrate: 6000000 }, showToast() {}, cancelButton: { disabled: true }
  };
  vm.runInNewContext(compose.slice(from, to), sandbox);
  assert.equal(sandbox.recorder.mimeType, "vp9");
  assert.equal(sandbox.recorder.state, "recording");
  assert.equal(first.ondataavailable, null);
  assert.equal(first.onstop, null);
  assert.equal(first.onerror, null);
  assert.equal(created.length, 2);
});

test("reports failure when every supported encoder rejects the start call", () => {
  const from = compose.indexOf("    const recorderHandlers = {");
  const to = compose.indexOf("    cancelButton.disabled = false;", from);
  class BrokenMediaRecorder {
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; }
    start() { throw new Error("encoder unavailable"); }
  }
  const first = new BrokenMediaRecorder({}, { mimeType: "vp8" });
  const sandbox = {
    recorder: first, MediaRecorder: BrokenMediaRecorder,
    selectedCandidateIndex: 0, encoderCandidates: [{ mimeType: "vp8", videoBitsPerSecond: 6000000 }, { mimeType: "vp9", videoBitsPerSecond: 6000000 }],
    finalStream: {}, recorderOptions: {}, composeOptions: { bitrate: 6000000 }, showToast() {}, cancelButton: { disabled: true }
  };
  assert.throws(
    () => vm.runInNewContext(compose.slice(from, to), sandbox),
    /動画のWebMエンコーダーを開始できませんでした/
  );
  assert.equal(sandbox.recorder, null);
});

test("encoder bitrate candidates favor requested quality and then safe lower profiles", () => {
  const profiles = compositionEncoderCandidates(
    ["video/webm;codecs=vp8,opus", "video/webm"], 8000000, 160000
  );
  assert.deepEqual(profiles.map((x) => x.videoBitsPerSecond),
    [8000000, 8000000, 4000000, 4000000, 2000000, 2000000, 1000000, 1000000]);
  assert.ok(profiles.every((x) => x.audioBitsPerSecond === 160000));
  assert.deepEqual(compositionEncoderCandidates(["video/webm"], 1000000).map(x => x.videoBitsPerSecond), [1000000]);
  assert.deepEqual(compositionEncoderCandidates([], 6000000), []);
});

test("encoder falls back to lower bitrate if a supported codec refuses start()", () => {
  const from = compose.indexOf("    const recorderHandlers = {");
  const to = compose.indexOf("    if (selectedEncoderOptions.videoBitsPerSecond", from);
  assert.ok(from >= 0 && to > from);
  const encoderCandidates = compositionEncoderCandidates(["video/webm;codecs=vp8"], 6000000);
  class LimitedRecorder {
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.videoBitsPerSecond = options.videoBitsPerSecond;
      this.state = "inactive";
    }
    start() {
      if (this.videoBitsPerSecond > 4000000) throw Error("bitrate unsupported");
      this.state = "recording";
    }
    stop() { this.state = "inactive"; }
  }
  const first = new LimitedRecorder({}, encoderCandidates[0]);
  const sandbox = {
    MediaRecorder: LimitedRecorder, recorder: first, selectedCandidateIndex: 0,
    encoderCandidates, finalStream: {}, cancelButton: { disabled: true }
  };
  vm.runInNewContext(compose.slice(from, to), sandbox);
  assert.equal(sandbox.recorder.videoBitsPerSecond, 4000000);
  assert.equal(sandbox.recorder.state, "recording");
  assert.equal(first.onstop, null);
});

test("stops unexpectedly before the end cannot be mistaken for successful output", () => {
  assert.equal(isUnexpectedCompositionStop(0, false, 15, 60000), true);
  assert.equal(isUnexpectedCompositionStop(0, false, 59.8, 60000), false);
  assert.equal(isUnexpectedCompositionStop(Date.now(), false, 15, 60000), false);
  assert.equal(isUnexpectedCompositionStop(0, true, 15, 60000), false);
  assert.match(compose, /isUnexpectedCompositionStop\(/);
  assert.match(compose, /不完全な動画を保存せず中断しました/);
});
