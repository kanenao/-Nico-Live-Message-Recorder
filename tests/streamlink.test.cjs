const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeLiveId,
  normalizeQuality,
  findStreamlinkExecutable,
  findFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs
} = require("../electron/streamlink.cjs");

test("normalizeLiveId accepts IDs and watch URLs", () => {
  assert.equal(normalizeLiveId("lv123456789"), "lv123456789");
  assert.equal(normalizeLiveId("https://live.nicovideo.jp/watch/lv123456789"), "lv123456789");
  assert.throws(() => normalizeLiveId("not-a-live-id"));
});

test("quality is restricted to supported choices", () => {
  assert.equal(normalizeQuality("worst"), "worst");
  assert.equal(normalizeQuality("audio_only"), "audio_only");
  assert.equal(normalizeQuality("unknown"), "best");
});

test("Streamlink executable detection uses custom path and PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-bin-test-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const executable = path.join(bin, "streamlink.exe");
    fs.writeFileSync(executable, "");
    assert.equal(findStreamlinkExecutable({
      customPath: executable,
      env: { PATH: "" },
      platform: "win32"
    }), executable);
    assert.equal(findStreamlinkExecutable({
      env: { PATH: bin },
      platform: "win32"
    }), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FFmpeg can be discovered beside Streamlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-ffmpeg-test-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const streamlink = path.join(bin, "streamlink.exe");
    const ffmpeg = path.join(bin, "ffmpeg.exe");
    fs.writeFileSync(streamlink, "");
    fs.writeFileSync(ffmpeg, "");
    assert.equal(findFfmpegExecutable({
      streamlinkPath: streamlink,
      env: { PATH: "" },
      platform: "win32"
    }), ffmpeg);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session token is written only to the temporary plugin config, not process args", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-runtime-test-"));
  let runtime;
  try {
    runtime = createStreamlinkRuntime(root, "session-secret\r\ninjected=true");
    const pluginConfig = fs.readFileSync(runtime.configPath + ".nicolive", "utf8");
    assert.equal(pluginConfig, "niconico-user-session=session-secretinjected=true\n");
    const args = buildStreamlinkArgs({
      configPath: runtime.configPath,
      liveId: "lv123456789",
      quality: "best",
      outputPath: path.join(root, "capture.ts")
    });
    assert.equal(args.includes("session-secret"), false);
    assert.equal(args.includes("https://live.nicovideo.jp/watch/lv123456789"), true);
    assert.equal(args.at(-1), "best");
  } finally {
    if (runtime) fs.rmSync(runtime.runtimeDirectory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
