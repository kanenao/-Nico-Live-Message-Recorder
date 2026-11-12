"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  QUALITY_PROFILES,
  normalizeCompositionFormat,
  normalizeCompositionQuality,
  buildMp4TranscodeArgs
} = require("../electron/composition-export.cjs");

test("normalizes only supported container and quality values", () => {
  assert.equal(normalizeCompositionFormat("mp4"), "mp4");
  assert.equal(normalizeCompositionFormat("webm"), "webm");
  assert.equal(normalizeCompositionFormat("mkv"), "webm");
  assert.equal(normalizeCompositionQuality("fast"), "fast");
  assert.equal(normalizeCompositionQuality("high"), "high");
  assert.equal(normalizeCompositionQuality("unknown"), "standard");
});

test("provides increasing H.264 quality profiles", () => {
  assert.equal(QUALITY_PROFILES.fast.crf, 24);
  assert.equal(QUALITY_PROFILES.standard.crf, 21);
  assert.equal(QUALITY_PROFILES.high.crf, 18);
});

test("builds shell-free FFmpeg arguments with optional audio mapping and H.264/AAC", () => {
  const args = buildMp4TranscodeArgs("C:\\Videos\\input.webm", "C:\\Videos\\output.mp4", "standard");
  for (const value of ["-i", "C:\\Videos\\input.webm", "C:\\Videos\\output.mp4", "libx264", "aac", "yuv420p", "medium", "21", "0:a:0?"]) {
    assert.ok(args.includes(value), "missing FFmpeg argument: " + value);
  }
  assert.ok(!args.some((value) => value.includes("&&") || value.includes(";")));
});

test("rejects missing input/output paths", () => {
  assert.throws(() => buildMp4TranscodeArgs("", "output.mp4", "fast"), TypeError);
});
