const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { patchNicoLivePluginSource } = require("../scripts/patch-nicolive.cjs");
const preparationScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "prepare-streamlink.ps1"), "utf8");
const { verifyStreamlinkPlugin } = require("../electron/streamlink-probe.cjs");
const {
  normalizeLiveId,
  normalizeQuality,
  findStreamlinkExecutable,
  findFfmpegExecutable,
  findBundledStreamlinkExecutable,
  findBundledFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs
} = require("../electron/streamlink.cjs");

test("Streamlink preflight confirms the nicolive plugin before starting a recording", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  let captured;
  const fakeSpawn = (executable, args, options) => {
    captured = { executable, args, options };
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit("close", 0, null));
    return child;
  };
  const result = await verifyStreamlinkPlugin("streamlink.exe", "lv123456789", "runtime/config", {
    spawnProcess: fakeSpawn
  });
  assert.equal(result.checked, true);
  assert.equal(captured.executable, "streamlink.exe");
  assert.deepEqual(captured.args, [
    "--config", "runtime/config",
    "--can-handle-url", "https://live.nicovideo.jp/watch/lv123456789"
  ]);
});

test("Streamlink preflight returns actionable plugin diagnostics", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stderr.write("No plugin can handle this URL");
      child.emit("close", 1, null);
    });
    return child;
  };
  await assert.rejects(
    verifyStreamlinkPlugin("streamlink.exe", "lv123456789", "runtime/config", { spawnProcess: fakeSpawn }),
    /ニコ生URLを処理できません.*No plugin can handle this URL/
  );
});

test("normalizeLiveId accepts IDs and watch URLs", () => {
  assert.equal(normalizeLiveId("lv123456789"), "lv123456789");
  assert.equal(normalizeLiveId("https://live.nicovideo.jp/watch/lv123456789"), "lv123456789");
  assert.throws(() => normalizeLiveId("not-a-live-id"));
});

test("timeshift mode requests the beginning of the Nico Live archive", () => {
  const args = buildStreamlinkArgs({
    configPath: "config",
    liveId: "lv123456789",
    quality: "best",
    outputPath: "capture.ts",
    timeshift: true
  });
  const offsetIndex = args.indexOf("--niconico-timeshift-offset");
  assert.ok(offsetIndex >= 0);
  assert.equal(args[offsetIndex + 1], "0");
  assert.equal(args.includes("https://live.nicovideo.jp/watch/lv123456789"), true);
  const liveArgs = buildStreamlinkArgs({
    configPath: "config", liveId: "lv123456789", quality: "best", outputPath: "live.ts"
  });
  assert.equal(liveArgs.includes("--niconico-timeshift-offset"), false);
});

test("quality is restricted to supported choices", () => {
  assert.equal(normalizeQuality("worst"), "worst");
  assert.equal(normalizeQuality("audio_only"), "best");
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
    runtime = createStreamlinkRuntime(root, "session-secret");
    const pluginConfig = fs.readFileSync(runtime.configPath + ".nicolive", "utf8");
    assert.equal(pluginConfig, "niconico-user-session=session-secret\n");
    assert.throws(() => createStreamlinkRuntime(root, "session-secret\ninjected=true"));
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


test("finds bundled Streamlink and FFmpeg inside a portable runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-bundled-tools-"));
  try {
    const streamlinkPath = path.join(root, "Streamlink", "bin", "streamlink.exe");
    const ffmpegPath = path.join(root, "Streamlink", "ffmpeg", "ffmpeg.exe");
    fs.mkdirSync(path.dirname(streamlinkPath), { recursive: true });
    fs.mkdirSync(path.dirname(ffmpegPath), { recursive: true });
    fs.writeFileSync(streamlinkPath, "");
    fs.writeFileSync(ffmpegPath, "");

    assert.equal(findBundledStreamlinkExecutable(root), streamlinkPath);
    assert.equal(findBundledFfmpegExecutable(root), ffmpegPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("returns null when the bundled runtime is missing", () => {
  assert.equal(findBundledStreamlinkExecutable(path.join(os.tmpdir(), "nlmr-does-not-exist")), null);
  assert.equal(findBundledFfmpegExecutable(path.join(os.tmpdir(), "nlmr-does-not-exist")), null);
});

test("NicoLive plugin timeout patch extends both connection waits to 30 seconds", () => {
  const original = [
    "class NicoLiveWsClient(WebsocketClient):",
    "    STREAM_OPENED_TIMEOUT = 6",
    "",
    "class NicoLive(Plugin):",
    "    STREAM_READY_TIMEOUT = 6"
  ].join("\n");
  const patched = patchNicoLivePluginSource(original);
  assert.match(patched, /STREAM_OPENED_TIMEOUT = 30/);
  assert.match(patched, /STREAM_READY_TIMEOUT = 30/);
  assert.equal(patchNicoLivePluginSource(patched), patched);
  const newerUpstreamDefaults = patchNicoLivePluginSource(
    original.replace("STREAM_READY_TIMEOUT = 6", "STREAM_READY_TIMEOUT = 10")
  );
  assert.match(newerUpstreamDefaults, /STREAM_READY_TIMEOUT = 30/);
  assert.throws(
    () => patchNicoLivePluginSource(original.replace("STREAM_READY_TIMEOUT = 6", "STREAM_READY_TIMEOUT = 999")),
    /安全な範囲外/
  );
});

test("Windows portable preparation pins the latest verified Streamlink 8.6.3-1 archive and patches nicolive.py", () => {
  assert.match(preparationScript, /\$version = "8\.6\.3-1"/);
  assert.match(preparationScript, /streamlink-8\.6\.3-1-py315-x86_64\.zip/);
  assert.match(preparationScript, /3b1f1470d4b135080a8107ca2917379ca3ff5acadbcdc215568b79eea1450497/);
  assert.match(preparationScript, /patch-nicolive\.cjs/);
  assert.match(preparationScript, /nicolive\.py/);
});


test("Niconico cookie filtering accepts root and subdomain cookies without leaking unrelated domains", () => {
  const { normalizeNicoCookies, getNicoUserSession } = require("../electron/nico-cookies.cjs");
  const cookies = [
    { name: "user_session", value: "session-root", domain: ".nicovideo.jp" },
    { name: "other", value: "subdomain-value", domain: "live.nicovideo.jp" },
    { name: "user_session", value: "wrong-domain", domain: ".example.com" },
    { name: "empty", value: "", domain: ".nicovideo.jp" }
  ];
  const normalized = normalizeNicoCookies(cookies);
  assert.equal(normalized.length, 2);
  assert.equal(getNicoUserSession(normalized), "session-root");
});

test("Niconico cookie normalization safely handles empty and invalid cookie collections", () => {
  const { normalizeNicoCookies, getNicoUserSession } = require("../electron/nico-cookies.cjs");
  assert.deepEqual(normalizeNicoCookies(null), []);
  assert.equal(getNicoUserSession([]), "");
});
