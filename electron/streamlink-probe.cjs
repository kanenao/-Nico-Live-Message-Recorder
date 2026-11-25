const { spawn } = require("node:child_process");

function verifyStreamlinkPlugin(executablePath, liveId, configPath, options = {}) {
  if (!executablePath) return Promise.reject(new Error("Streamlink実行ファイルが指定されていません。"));
  if (!configPath) return Promise.reject(new Error("Streamlink設定ファイルが指定されていません。"));
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000);
  const url = "https://live.nicovideo.jp/watch/" + String(liveId || "").replace(/^lv/i, "lv");
  return new Promise((resolve, reject) => {
    let child;
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ checked: true, url });
    };
    try {
      const args = ["--config", configPath];
      // CLI parsing must recognize the patched chase flag before any recording
      // is started; the normal URL probe alone accepts unpatched binaries.
      if (options.chase === true) args.push("--niconico-chase-play", "--hls-live-restart");
      args.push("--can-handle-url-no-redirect", url);
      child = spawnProcess(executablePath, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: options.env || process.env
      });
    } catch (error) {
      finish(new Error("Streamlinkを起動できません: " + (error.message || String(error))));
      return;
    }
    if (child.stderr) {
      child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2400);
      });
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(new Error("Streamlinkのニコ生プラグイン確認が" + Math.ceil(timeoutMs / 1000) + "秒以内に完了しませんでした。実行ファイル・セキュリティソフト・インストール状態を確認してください。"));
    }, timeoutMs);
    child.once("error", error => finish(new Error("Streamlinkの起動確認に失敗しました: " + (error.message || String(error)))));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = stderr.trim();
      const guidance = options.chase === true
        ? "Streamlinkの追っかけ録画対応を確認できません。最新の同梱版または自動更新版を利用してください。通常録画へは切り替えません。"
        : "Streamlinkがニコ生URLを処理できません";
      finish(new Error(guidance + "（終了コード " + code + (signal ? " / " + signal : "") + "）。" +
        (detail ? "\nStreamlink詳細: " + detail : " ニコ生プラグインが含まれるStreamlinkか確認してください。")));
    });
  });
}

module.exports = { verifyStreamlinkPlugin };
