const fs = require("node:fs");
const path = require("node:path");

const QUALITIES = new Set(["best", "worst"]);

function normalizeLiveId(value) {
  const match = String(value || "").trim().match(/(?:lv)?(\d{5,})/i);
  if (!match) throw new Error("放送IDまたは視聴URLを入力してください。");
  return "lv" + match[1];
}

function normalizeQuality(value) {
  return QUALITIES.has(String(value || "")) ? String(value) : "best";
}

function findExecutable(options = {}) {
  const {
    customPath,
    executableName,
    env = process.env,
    platform = process.platform,
    extraDirectories = []
  } = options;
  const suffix = platform === "win32" ? ".exe" : "";
  const names = [executableName + suffix];
  const candidates = [];
  if (customPath) candidates.push(customPath);
  for (const directory of extraDirectories) {
    for (const name of names) candidates.push(path.join(directory, name));
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(directory, name));
  }
  return [...new Set(candidates)].find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  }) || null;
}

function findBundledExecutable(bundleRoot, executableName, maxDepth = 7) {
  if (!bundleRoot) return null;
  let root;
  try {
    root = fs.realpathSync(bundleRoot);
    if (!fs.statSync(root).isDirectory()) return null;
  } catch (_) {
    return null;
  }

  const target = executableName.toLowerCase();
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return fullPath;
      if (
        entry.isDirectory() &&
        current.depth < maxDepth &&
        !["__pycache__", ".git", "cache", "caches"].includes(entry.name.toLowerCase())
      ) {
        queue.push({ directory: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function findBundledStreamlinkExecutable(bundleRoot) {
  return findBundledExecutable(bundleRoot, "streamlink.exe");
}

function findBundledFfmpegExecutable(bundleRoot) {
  return findBundledExecutable(bundleRoot, "ffmpeg.exe");
}

function findStreamlinkExecutable(options = {}) {
  const env = options.env || process.env;
  const commonDirectories = [];
  if (options.platform !== "linux" && options.platform !== "darwin") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (!root) continue;
      commonDirectories.push(
        path.join(root, "Streamlink", "bin"),
        path.join(root, "Programs", "Streamlink", "bin")
      );
    }
    if (env.USERPROFILE) {
      commonDirectories.push(path.join(env.USERPROFILE, "scoop", "apps", "streamlink", "current"));
    }
  }
  return findExecutable({
    ...options,
    env,
    executableName: "streamlink",
    extraDirectories: [...(options.extraDirectories || []), ...commonDirectories]
  });
}

function findFfmpegExecutable(options = {}) {
  const env = options.env || process.env;
  const extraDirectories = [...(options.extraDirectories || [])];
  if (options.streamlinkPath) {
    const directory = path.dirname(options.streamlinkPath);
    extraDirectories.push(
      directory,
      path.join(directory, "ffmpeg"),
      path.join(directory, "ffmpeg", "bin"),
      path.resolve(directory, ".."),
      path.resolve(directory, "..", "ffmpeg"),
      path.resolve(directory, "..", "ffmpeg", "bin")
    );
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
    if (!root) continue;
    extraDirectories.push(path.join(root, "ffmpeg", "bin"));
  }
  return findExecutable({
    ...options,
    env,
    executableName: "ffmpeg",
    extraDirectories
  });
}

function createStreamlinkRuntime(tempRoot, userSession) {
  if (!tempRoot) throw new Error("一時フォルダーを取得できません。");
  const token = String(userSession || "").trim();
  if (/[\r\n]/.test(token)) throw new Error("ログインセッションの形式が正しくありません。");
  fs.mkdirSync(tempRoot, { recursive: true });
  const runtimeDirectory = fs.mkdtempSync(path.join(tempRoot, "nlmr-streamlink-"));
  const appDataDirectory = path.join(runtimeDirectory, "appdata");
  const configDirectory = path.join(appDataDirectory, "streamlink");
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

  const configPath = path.join(configDirectory, "config");
  fs.writeFileSync(configPath, "loglevel=info\n", { encoding: "utf8", mode: 0o600 });

  if (token) {
    fs.writeFileSync(
      configPath + ".nicolive",
      "niconico-user-session=" + token + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  }

  return {
    runtimeDirectory,
    configPath,
    env: {
      ...process.env,
      APPDATA: appDataDirectory,
      LOCALAPPDATA: appDataDirectory,
      USERPROFILE: runtimeDirectory,
      HOME: runtimeDirectory
    }
  };
}

function formatStreamlinkFailure(stderr, options = {}) {
  const detail = String(stderr || "").trim();
  const normalized = detail.toLowerCase();
  const hasUserSession = options.hasUserSession === true;
  let guidance = "配信ID・放送の公開状態・視聴権限・ネットワーク接続を確認してください。";
  if (/failed to get wss_api_url|wss_api_url/.test(normalized)) {
    guidance = "ニコ生の視聴接続情報を取得できません。放送ID・放送状態・アカウントの視聴権限を確認してください。";
  } else if (/\b(401|403)\b|unauthorized|forbidden|login required|ログイン/.test(normalized)) {
    guidance = "ログインまたは視聴権限で拒否された可能性があります。「ニコニコにログイン」から再ログインし、対象放送をブラウザーで視聴できるか確認してください。";
  } else if (/websocket|timed out|timeout|connection reset|connection refused|network is unreachable/.test(normalized)) {
    guidance = "配信サーバーとの通信が完了しませんでした。通信状態を確認してから再試行してください。";
  } else if (/no streams found|no playable streams/.test(normalized)) {
    guidance = "配信ストリームを取得できません。放送状態・視聴権限・Streamlinkの対応状況を確認してください。";
  }
  const authNote = options.hasUserSession === undefined ? "" :
    "ニコニコ user_session: " + (hasUserSession ? "検出（有効性は未確認）" : "未検出") + "。";
  return [guidance, authNote, detail ? "Streamlink詳細: " + detail.slice(-1800) : ""]
    .filter(Boolean).join("\n");
}

function buildStreamlinkArgs(options) {
  const liveId = normalizeLiveId(options.liveId);
  if (!options.configPath) throw new Error("Streamlink用の設定ファイルがありません。");
  if (!options.stdout && !options.outputPath) throw new Error("録画ファイルの保存先がありません。");

  const args = [
    "--config", options.configPath,
    // Keep Streamlink plugin cache enabled: the nicolive plugin uses it for authentication/session cookies.
    "--loglevel", "info",
    "--retry-streams", "3",
    "--retry-max", "20",
    "--retry-open", "3",
    "--hls-live-edge", "3"
  ];
  if (options.ffmpegPath) args.push("--ffmpeg-ffmpeg", options.ffmpegPath);
  if (options.timeshift) {
    // Streamlink's nicolive plugin supports VOD/timeshift URLs. Offset 0 starts at the archive beginning.
    args.push("--niconico-timeshift-offset", "0");
  }
  if (options.stdout) args.push("--stdout");
  else args.push("--output", options.outputPath);
  args.push("https://live.nicovideo.jp/watch/" + liveId, normalizeQuality(options.quality));
  return args;
}

module.exports = {
  normalizeLiveId,
  normalizeQuality,
  findStreamlinkExecutable,
  findFfmpegExecutable,
  findBundledExecutable,
  findBundledStreamlinkExecutable,
  findBundledFfmpegExecutable,
  createStreamlinkRuntime,
  buildStreamlinkArgs,
  formatStreamlinkFailure
};
