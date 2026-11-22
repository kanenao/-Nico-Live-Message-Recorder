"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { videoPreviewTimes, formatVideoTime } = require("./library-video-preview.cjs");

const MAX_STORYBOARD_FRAMES = 30;
const MAX_JPEG_BYTES = 420000;

function storyboardFrameCount(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  const desired = duration < 1800 ? 12 : duration < 7200 ? 20 : 30;
  return Math.max(1, Math.min(MAX_STORYBOARD_FRAMES, desired, Math.floor(duration / 4) || 1));
}

function storyboardPositions(durationSeconds) {
  return videoPreviewTimes(durationSeconds, storyboardFrameCount(durationSeconds));
}

function storyboardCacheId(videoPath, stat) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([path.resolve(videoPath), stat.size, stat.mtimeMs]))
    .digest("hex").slice(0, 28);
}

function validJpeg(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 100 && bytes.length <= MAX_JPEG_BYTES &&
    bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function imageToBytes(value) {
  const prefix = "data:image/jpeg;base64,";
  if (typeof value !== "string" || !value.startsWith(prefix) ||
      value.length > Math.ceil(MAX_JPEG_BYTES * 4 / 3) + prefix.length + 4) return null;
  const bytes = Buffer.from(value.slice(prefix.length), "base64");
  return validJpeg(bytes) ? bytes : null;
}

// Cache generated images *outside* the original recording directories.
// Callers supply only internally validated video paths, never arbitrary
// manifest paths from untrusted JSON. A changed video creates a new cache key.
async function getOrCreateVideoStoryboard(options) {
  const { videoPath, stat, durationSeconds, cacheRoot, extractFrame } = options;
  const positions = storyboardPositions(durationSeconds);
  const cacheId = storyboardCacheId(videoPath, stat);
  const directory = path.join(cacheRoot, cacheId);
  const manifestPath = path.join(directory, "storyboard.json");
  const toFrame = (seconds, index, bytes) => ({
    seconds, label: formatVideoTime(seconds),
    imageUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
    index
  });
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion === 1 && manifest.cacheId === cacheId &&
        JSON.stringify(manifest.positions) === JSON.stringify(positions)) {
      const loaded = [];
      for (let index = 0; index < positions.length; index++) {
        const bytes = await fs.promises.readFile(path.join(directory, "frame-" +
          String(index + 1).padStart(2, "0") + ".jpg"));
        if (!validJpeg(bytes)) throw new Error("Invalid cached JPEG");
        loaded.push(toFrame(positions[index], index, bytes));
      }
      return { durationSeconds, frames: loaded, fromCache: true };
    }
  } catch (_) {
    // A missing or interrupted cache may be regenerated without changing
    // the saved recording or article.
  }
  await fs.promises.mkdir(directory, { recursive: true });
  const frames = [];
  for (let index = 0; index < positions.length; index++) {
    const seconds = positions[index];
    const dataUri = await extractFrame(seconds);
    const bytes = imageToBytes(dataUri);
    if (!bytes) continue;
    const name = "frame-" + String(index + 1).padStart(2, "0") + ".jpg";
    await fs.promises.writeFile(path.join(directory, name), bytes);
    frames.push(toFrame(seconds, index, bytes));
  }
  // Never publish an incomplete manifest. Cache failures are recoverable,
  // while video and comment originals are never touched.
  if (frames.length === positions.length) {
    const tmp = manifestPath + ".partial";
    await fs.promises.writeFile(tmp, JSON.stringify({
      schemaVersion: 1, cacheId, durationSeconds, positions
    }), "utf8");
    await fs.promises.rename(tmp, manifestPath);
  }
  return { durationSeconds, frames, fromCache: false };
}

module.exports = {
  MAX_STORYBOARD_FRAMES, storyboardFrameCount, storyboardPositions,
  storyboardCacheId, validJpeg, imageToBytes, getOrCreateVideoStoryboard
};
