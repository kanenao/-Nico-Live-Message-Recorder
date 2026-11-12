"use strict";

const path = require("node:path");

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

function normalizeCompositionOutputPath(filePath, format) {
  const requestedPath = String(filePath || "").trim();
  if (!requestedPath) throw new TypeError("保存先のファイルパスを指定してください。");
  const extension = "." + normalizeCompositionFormat(format);
  const parsed = path.parse(requestedPath);
  if (parsed.ext.toLowerCase() === extension) return requestedPath;
  const baseName = parsed.name || parsed.base || "NicoLiveMessage";
  return path.join(parsed.dir, baseName + extension);
}

function createMp4IntermediatePath(outputPath, uniqueToken) {
  const target = String(outputPath || "").trim();
  const token = String(uniqueToken || "").trim();
  if (!target || path.extname(target).toLowerCase() !== ".mp4") {
    throw new TypeError("MP4の出力先を指定してください。");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
    throw new TypeError("一時ファイル識別子が正しくありません。");
  }
  return target + "." + token + ".partial.webm";
}

function calculateTranscodeProgressPercent(outTimeMicroseconds, durationMilliseconds) {
  const elapsed = Number(outTimeMicroseconds);
  const duration = Number(durationMilliseconds);
  if (!Number.isFinite(elapsed) || elapsed <= 0 || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(99, Math.max(0, (elapsed / 1000 / duration) * 100));
}

function buildMp4TranscodeArgs(inputPath, outputPath, quality) {
  if (!inputPath || !outputPath) throw new TypeError("変換元と出力先を指定してください。");
  const profile = QUALITY_PROFILES[normalizeCompositionQuality(quality)];
  return [
    "-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-nostats", "-y",
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
  normalizeCompositionOutputPath,
  createMp4IntermediatePath,
  calculateTranscodeProgressPercent,
  buildMp4TranscodeArgs
};
