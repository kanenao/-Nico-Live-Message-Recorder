"use strict";

const QUALITY_PROFILES = Object.freeze({
  fast: Object.freeze({ preset: "veryfast", crf: 24 }),
  standard: Object.freeze({ preset: "medium", crf: 21 }),
  high: Object.freeze({ preset: "slow", crf: 18 })
});

function normalizeCompositionFormat(value) {
  return String(value || "").toLowerCase() === "mp4" ? "mp4" : "webm";
}

function normalizeCompositionQuality(value) {
  const key = String(value || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(QUALITY_PROFILES, key) ? key : "standard";
}

function buildMp4TranscodeArgs(inputPath, outputPath, quality) {
  if (!inputPath || !outputPath) throw new TypeError("変換元と出力先を指定してください。");
  const profile = QUALITY_PROFILES[normalizeCompositionQuality(quality)];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", String(inputPath),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", profile.preset,
    "-crf", String(profile.crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    String(outputPath)
  ];
}

module.exports = {
  QUALITY_PROFILES,
  normalizeCompositionFormat,
  normalizeCompositionQuality,
  buildMp4TranscodeArgs
};
