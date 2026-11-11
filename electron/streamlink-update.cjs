"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { patchNicoLivePluginFile } = require("../scripts/patch-nicolive.cjs");

const RELEASES_API = "https://api.github.com/repos/streamlink/windows-builds/releases/latest";
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function parseReleaseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)-(\d+)$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error("Streamlinkのバージョン形式が正しくありません。");
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function selectWindowsPortableAsset(release) {
  const version = String(release && release.tag_name || "");
  if (!parseReleaseVersion(version)) {
    throw new Error("公式Windowsリリースのバージョン形式を確認できません。");
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) =>
    item &&
    item.name === "streamlink-" + version + "-py315-x86_64.zip" &&
    /^sha256:[0-9a-f]{64}$/i.test(String(item.digest || "")) &&
    /^https:\/\/github\.com\/streamlink\/windows-builds\/releases\/download\//.test(String(item.browser_download_url || ""))
  );
  if (!asset) {
    throw new Error("Streamlink " + version + " の検証可能なWindows x64 Portable ZIPがありません。");
  }
  return {
    version,
    name: asset.name,
    url: asset.browser_download_url,
    sha256: asset.digest.slice("sha256:".length).toLowerCase(),
    size: Number(asset.size) || 0
  };
}

async function fetchLatestWindowsRelease(fetchImpl = global.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");
  const response = await fetchImpl(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Nico-Live-Message-Recorder"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error("Streamlink公式リリースの確認に失敗しました（HTTP " + response.status + "）。");
  const release = await response.json();
  const asset = selectWindowsPortableAsset(release);
  return { release, asset };
}

function getManagedRuntimeDirectory(userDataDirectory) {
  return path.join(userDataDirectory, "streamlink-runtime");
}

function getActiveManagedRuntime(userDataDirectory) {
  if (!userDataDirectory) return null;
  const root = getManagedRuntimeDirectory(userDataDirectory);
  const manifestPath = path.join(root, "active.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const version = String(manifest.version || "");
    if (!parseReleaseVersion(version)) return null;
    const versionDirectory = path.resolve(root, version);
    const relative = path.relative(path.resolve(root), versionDirectory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!fs.statSync(versionDirectory).isDirectory()) return null;
    const streamlinkPath = findNamedFile(versionDirectory, "streamlink.exe");
    const ffmpegPath = findNamedFile(versionDirectory, "ffmpeg.exe");
    if (!streamlinkPath || !ffmpegPath) return null;
    return { version, root: versionDirectory, streamlinkPath, ffmpegPath, managed: true };
  } catch (_) {
    return null;
  }
}

function findNamedFile(root, targetName) {
  const queue = [root];
  const ignored = new Set(["__pycache__", ".git", "cache", "caches"]);
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) return fullPath;
      if (entry.isDirectory() && !ignored.has(entry.name.toLowerCase())) queue.push(fullPath);
    }
  }
  return null;
}

function findNicoLivePlugin(root) {
  const queue = [root];
  const candidates = [];
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "nicolive.py" &&
          path.basename(path.dirname(fullPath)).toLowerCase() === "plugins" &&
          path.basename(path.dirname(path.dirname(fullPath))).toLowerCase() === "streamlink") {
        candidates.push(fullPath);
      } else if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error("nicolive.py が1件見つかりません（検出数: " + candidates.length + "）。");
  }
  return candidates[0];
}

function extractZipWithPowerShell(archivePath, destinationPath, tempDirectory) {
  if (process.platform !== "win32") {
    throw new Error("Streamlinkの自動更新はWindows版で利用できます。");
  }
  const scriptPath = path.join(tempDirectory, "extract-streamlink.ps1");
  const script = [
    "param([string]$Archive, [string]$Destination)",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)"
  ].join("\r\n");
  fs.writeFileSync(scriptPath, script, "utf8");
  execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath, archivePath, destinationPath
  ], { windowsHide: true, stdio: "pipe", timeout: 180000 });
}

async function installWindowsPortableRelease(options = {}) {
  const userDataDirectory = options.userDataDirectory;
  const release = options.release;
  const asset = options.asset || selectWindowsPortableAsset(release);
  const fetchImpl = options.fetchImpl || global.fetch;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  if (!userDataDirectory) throw new Error("Streamlink更新の保存先がありません。");
  if (process.platform !== "win32" && options.allowNonWindows !== true) {
    throw new Error("Streamlinkの自動更新はWindows版で利用できます。");
  }
  const root = getManagedRuntimeDirectory(userDataDirectory);
  const destination = path.join(root, asset.version);
  const existing = getActiveManagedRuntime(userDataDirectory);
  if (existing && existing.version === asset.version) {
    return { version: asset.version, root: existing.root, alreadyInstalled: true };
  }

  fs.mkdirSync(root, { recursive: true });
  const tempDirectory = fs.mkdtempSync(path.join(root, ".download-"));
  const archivePath = path.join(tempDirectory, asset.name);
  const stagingPath = path.join(tempDirectory, "runtime");
  try {
    onProgress({ state: "downloading", version: asset.version, percent: 0 });
    const response = await fetchImpl(asset.url, {
      headers: { "User-Agent": "Nico-Live-Message-Recorder" },
      signal: AbortSignal.timeout(180000)
    });
    if (!response.ok) throw new Error("Streamlinkのダウンロードに失敗しました（HTTP " + response.status + "）。");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) {
      throw new Error("Streamlinkのダウンロードサイズが想定範囲外です。");
    }
    if (asset.size && bytes.length !== asset.size) {
      throw new Error("Streamlink ZIPのファイルサイズが一致しません。");
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error("Streamlink ZIPのSHA-256検証に失敗しました。");
    }
    fs.writeFileSync(archivePath, bytes);
    onProgress({ state: "extracting", version: asset.version, percent: 100 });
    fs.mkdirSync(stagingPath, { recursive: true });
    (options.extractZip || extractZipWithPowerShell)(archivePath, stagingPath, tempDirectory);

    const streamlinkPath = findNamedFile(stagingPath, "streamlink.exe");
    const ffmpegPath = findNamedFile(stagingPath, "ffmpeg.exe");
    if (!streamlinkPath || !ffmpegPath) {
      throw new Error("Portable ZIPにStreamlinkまたはFFmpegが含まれていません。");
    }
    patchNicoLivePluginFile(findNicoLivePlugin(stagingPath));

    const versionCheck = spawnSync(streamlinkPath, ["--version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000
    });
    if (versionCheck.error || versionCheck.status !== 0 ||
        !String(versionCheck.stdout || versionCheck.stderr || "").includes(asset.version.split("-")[0])) {
      throw new Error("更新後のStreamlinkバージョン検証に失敗しました。");
    }
    const ffmpegCheck = spawnSync(ffmpegPath, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000
    });
    if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
      throw new Error("更新後のFFmpeg検証に失敗しました。");
    }

    if (fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(stagingPath, destination);
    const manifestPath = path.join(root, "active.json");
    const pendingManifest = path.join(root, "active.json.tmp");
    fs.writeFileSync(pendingManifest, JSON.stringify({
      version: asset.version,
      activatedAt: new Date().toISOString()
    }, null, 2), "utf8");
    fs.renameSync(pendingManifest, manifestPath);
    onProgress({ state: "updated", version: asset.version, percent: 100 });
    return { version: asset.version, root: destination, alreadyInstalled: false };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  RELEASES_API,
  parseReleaseVersion,
  compareReleaseVersions,
  selectWindowsPortableAsset,
  fetchLatestWindowsRelease,
  getManagedRuntimeDirectory,
  getActiveManagedRuntime,
  installWindowsPortableRelease
};
