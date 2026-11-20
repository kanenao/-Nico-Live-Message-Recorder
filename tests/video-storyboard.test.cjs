"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_STORYBOARD_FRAMES, storyboardFrameCount, storyboardPositions,
  storyboardCacheId, validJpeg, imageToBytes, getOrCreateVideoStoryboard
} = require("../electron/video-storyboard.cjs");

test("storyboard sampling scales from short clips to long Nico broadcasts and never exceeds 30", () => {
  assert.equal(storyboardFrameCount(2), 1);
  assert.equal(storyboardFrameCount(400), 12);
  assert.equal(storyboardFrameCount(3600), 20);
  assert.equal(storyboardFrameCount(10800), 30);
  assert.equal(MAX_STORYBOARD_FRAMES, 30);
  for (const seconds of [2, 400, 3600, 10800, 24 * 3600]) {
    const positions = storyboardPositions(seconds);
    assert.equal(positions.length, storyboardFrameCount(seconds));
    assert.ok(positions.every((position, index) =>
      position >= 0 && position < seconds &&
      (index === 0 || position > positions[index - 1])));
  }
});

test("storyboard storage accepts only bounded, complete JPEG frames", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.alloc(132, 0x12), Buffer.from([0xff, 0xd9])
  ]);
  const data = "data:image/jpeg;base64," + bytes.toString("base64");
  assert.equal(validJpeg(bytes), true);
  assert.deepEqual(imageToBytes(data), bytes);
  assert.equal(imageToBytes("data:image/png;base64," + bytes.toString("base64")), null);
  assert.equal(validJpeg(Buffer.from("not a jpeg")), false);
});

test("storyboard caches scenes under the app cache without touching saved recordings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nico-storyboard-"));
  const videoPath = path.join(root, "saved-video.mp4");
  const cacheRoot = path.join(root, "app-cache");
  const source = Buffer.from("original video marker");
  fs.writeFileSync(videoPath, source);
  const stat = fs.statSync(videoPath);
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.alloc(152, 0x11), Buffer.from([0xff, 0xd9])
  ]);
  let extracts = 0;
  const options = {
    videoPath, stat, durationSeconds: 401, cacheRoot,
    extractFrame: async () => { extracts += 1; return "data:image/jpeg;base64," + bytes.toString("base64"); }
  };
  try {
    const first = await getOrCreateVideoStoryboard(options);
    assert.equal(first.frames.length, 12);
    assert.equal(first.fromCache, false);
    assert.equal(extracts, 12);
    const second = await getOrCreateVideoStoryboard({
      ...options, extractFrame: async () => { throw new Error("should use cache"); }
    });
    assert.equal(second.fromCache, true);
    assert.deepEqual(second.frames, first.frames);
    const folder = path.join(cacheRoot, storyboardCacheId(videoPath, stat));
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "storyboard.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.positions.length, 12);
    assert.deepEqual(fs.readFileSync(videoPath), source);
    // A new source size or mtime invalidates the existing cache.
    const changed = await getOrCreateVideoStoryboard({
      ...options, stat: { ...stat, size: stat.size + 1 }
    });
    assert.equal(changed.fromCache, false);
    assert.equal(changed.frames.length, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid cache frames cause regeneration; failed capture never produces a complete manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nico-storyboard-invalid-"));
  const videoPath = path.join(root, "recording.mp4");
  fs.writeFileSync(videoPath, "file");
  const stat = fs.statSync(videoPath);
  const cacheRoot = path.join(root, "cache");
  const directory = path.join(cacheRoot, storyboardCacheId(videoPath, stat));
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.alloc(120, 0x11), Buffer.from([0xff, 0xd9])
  ]);
  try {
    const options = {
      videoPath, stat, cacheRoot, durationSeconds: 14,
      extractFrame: async seconds => seconds > 6 ? "" :
        "data:image/jpeg;base64," + bytes.toString("base64")
    };
    const partial = await getOrCreateVideoStoryboard(options);
    assert.ok(partial.frames.length < storyboardFrameCount(14));
    assert.equal(fs.existsSync(path.join(directory, "storyboard.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
