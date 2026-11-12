"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  QUALITY_PROFILES,
  normalizeCompositionFormat,
  normalizeCompositionQuality,
  normalizeCompositionOutputPath,
  createMp4IntermediatePath,
  calculateTranscodeProgressPercent,
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
  for (const value of ["-i", "C:\\Videos\\input.webm", "C:\\Videos\\output.mp4", "libx264", "aac", "yuv420p", "medium", "21", "0:a:0?", "-progress", "pipe:2", "-nostats"]) {
    assert.ok(args.includes(value), "missing FFmpeg argument: " + value);
  }
  assert.ok(!args.some((value) => value.includes("&&") || value.includes(";")));
});

test("rejects missing input/output paths", () => {
  assert.throws(() => buildMp4TranscodeArgs("", "output.mp4", "fast"), TypeError);
});


test("normalizes the save extension to the selected format", () => {
  const requestedPath = path.join("videos", "commented.webm");
  assert.equal(normalizeCompositionOutputPath(requestedPath, "mp4"), path.join("videos", "commented.mp4"));
  assert.equal(normalizeCompositionOutputPath(path.join("videos", "commented"), "mp4"), path.join("videos", "commented.mp4"));
  assert.equal(normalizeCompositionOutputPath(path.join("videos", "commented.mp4"), "mp4"), path.join("videos", "commented.mp4"));
  assert.throws(() => normalizeCompositionOutputPath("", "mp4"), TypeError);
});


test("creates a unique exclusive intermediate WebM path without replacing old files", () => {
  const output = path.join("videos", "commented.mp4");
  assert.equal(createMp4IntermediatePath(output, "session-001"), output + ".session-001.partial.webm");
  assert.notEqual(
    createMp4IntermediatePath(output, "session-001"),
    createMp4IntermediatePath(output, "session-002")
  );
  assert.throws(() => createMp4IntermediatePath(path.join("videos", "commented.webm"), "session"), TypeError);
  assert.throws(() => createMp4IntermediatePath(output, "../session"), TypeError);
});

test("converts FFmpeg out_time microseconds into a bounded progress percentage", () => {
  assert.equal(calculateTranscodeProgressPercent(30000000, 60000), 50);
  assert.equal(calculateTranscodeProgressPercent(100000000, 60000), 99);
  assert.equal(calculateTranscodeProgressPercent(-1, 60000), 0);
  assert.equal(calculateTranscodeProgressPercent(1000, 0), 0);
});
