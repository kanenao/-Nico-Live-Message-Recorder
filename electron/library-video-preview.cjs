"use strict";

function parseVideoDuration(stderr) {
  const match = String(stderr || "").match(/\bDuration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/i);
  if (!match) return 0;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 +
    Number(match[3]) + Number("0." + (match[4] || "0"));
  return Number.isFinite(seconds) && seconds > 0 && seconds < 60 * 60 * 24 * 30 ? seconds : 0;
}

function videoPreviewTimes(durationSeconds, maxCount = 5) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  // For a very short clip a large strip of almost identical frames is misleading.
  const count = Math.max(1, Math.min(30, Math.floor(Number(maxCount) || 5),
    Math.floor(duration / 4) || 1));
  const times = [];
  for (let i = 0; i < count; i++) {
    const fraction = count === 1 ? 0.35 : 0.05 + (i / (count - 1)) * 0.9;
    times.push(Math.round(Math.max(0, Math.min(duration - 0.1, duration * fraction)) * 10) / 10);
  }
  return [...new Set(times)];
}

function formatVideoTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  const remaining = whole % 60;
  const pad = value => String(value).padStart(2, "0");
  return hours ? hours + ":" + pad(minutes) + ":" + pad(remaining)
    : pad(minutes) + ":" + pad(remaining);
}

module.exports = { parseVideoDuration, videoPreviewTimes, formatVideoTime };
