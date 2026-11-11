const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseReleaseVersion,
  compareReleaseVersions,
  selectWindowsPortableAsset,
  getActiveManagedRuntime,
  getManagedRuntimeDirectory
} = require("../electron/streamlink-update.cjs");

function makeRelease(version, assetName, digest = "sha256:" + "a".repeat(64)) {
  return {
    tag_name: version,
    assets: [{
      name: assetName,
      digest,
      size: 123456,
      browser_download_url: "https://github.com/streamlink/windows-builds/releases/download/" + version + "/" + assetName
    }]
  };
}

test("Streamlink release versions compare numeric components and reject invalid tags", () => {
  assert.deepEqual(parseReleaseVersion("8.6.3-1"), [8, 6, 3, 1]);
  assert.equal(compareReleaseVersions("8.6.3-1", "8.6.2-1"), 1);
  assert.equal(compareReleaseVersions("8.6.3-2", "8.6.3-1"), 1);
  assert.equal(compareReleaseVersions("8.6.3-1", "8.6.3-1"), 0);
  assert.equal(parseReleaseVersion("latest"), null);
  assert.throws(() => compareReleaseVersions("8.6.3", "8.6.2-1"));
});

test("official Windows portable asset selection accepts Python-tagged ZIPs with SHA-256", () => {
  const release = makeRelease("8.6.3-1", "streamlink-8.6.3-1-py315-x86_64.zip");
  assert.deepEqual(selectWindowsPortableAsset(release), {
    version: "8.6.3-1",
    name: "streamlink-8.6.3-1-py315-x86_64.zip",
    url: release.assets[0].browser_download_url,
    sha256: "a".repeat(64),
    size: 123456
  });
  const py316 = makeRelease("8.6.4-1", "streamlink-8.6.4-1-py316-x86_64.zip");
  assert.equal(selectWindowsPortableAsset(py316).name, "streamlink-8.6.4-1-py316-x86_64.zip");
});

test("portable asset selection rejects unknown URLs and missing digest metadata", () => {
  assert.throws(
    () => selectWindowsPortableAsset(makeRelease("8.6.3-1", "streamlink-8.6.3-1-py315-x86_64.exe")),
    /検証可能なWindows x64 Portable ZIP/
  );
  assert.throws(
    () => selectWindowsPortableAsset(makeRelease("8.6.3-1", "streamlink-8.6.3-1-py315-x86_64.zip", "")),
    /検証可能なWindows x64 Portable ZIP/
  );
});

test("active managed runtime is selected only when manifest and executables are valid", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nlmr-streamlink-active-"));
  try {
    const root = getManagedRuntimeDirectory(userData);
    const runtime = path.join(root, "8.6.3-1");
    const streamlink = path.join(runtime, "Streamlink", "bin", "streamlink.exe");
    const ffmpeg = path.join(runtime, "Streamlink", "ffmpeg", "ffmpeg.exe");
    fs.mkdirSync(path.dirname(streamlink), { recursive: true });
    fs.mkdirSync(path.dirname(ffmpeg), { recursive: true });
    fs.writeFileSync(streamlink, "");
    fs.writeFileSync(ffmpeg, "");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({ version: "8.6.3-1" }));
    const active = getActiveManagedRuntime(userData);
    assert.equal(active.version, "8.6.3-1");
    assert.equal(active.streamlinkPath, streamlink);
    assert.equal(active.ffmpegPath, ffmpeg);
    fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({ version: "../../outside" }));
    assert.equal(getActiveManagedRuntime(userData), null);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
