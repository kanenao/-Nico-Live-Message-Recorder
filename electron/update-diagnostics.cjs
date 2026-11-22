"use strict";

// Never echo signed GitHub CDN URLs, Authorization headers or tokens into the UI or local logs.
function explainUpdateError(error) {
  const sourceCode = error && typeof error.code === "string" ? error.code : "";
  const code = /^[A-Z0-9_-]{2,80}$/.test(sourceCode) ? sourceCode : "";
  const raw = String(error && error.message || error || "");
  let category = "unknown";
  let reason = "更新データを取得できませんでした。GitHub Releasesからインストーラー版を入手できます。";
  let retryable = false;
  if (/sha512|checksum|signature|ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED|ERR_UPDATER_INSTALLER_VERSION_MISMATCH/i.test(raw + " " + code)) {
    category = "integrity";
    reason = "更新ファイルの検証に失敗しました。安全のため適用していません。GitHub Releasesからインストーラーを取得してください。";
  } else if (/\b(404)\b|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(raw + " " + code)) {
    category = "not-found";
    reason = "更新情報またはファイルが見つかりません（HTTP 404）。公開直後の場合は再度確認するか、Releasesから取得してください。";
  } else if (/\b(401|403)\b|forbidden|unauthorized/i.test(raw)) {
    category = "permission";
    reason = "GitHubの更新ファイルへのアクセスが拒否されました（HTTP 401/403）。通信制限を確認するか、Releasesから取得してください。";
  } else if (/\b(429|500|502|503|504)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|network|socket hang up|net::ERR_/i.test(raw + " " + code)) {
    category = "network";
    reason = "GitHubとの通信が中断・混雑しています。フルダウンロードの再試行を利用できます。";
    retryable = true;
  }
  return { category, code, retryable, message: reason + (code ? "（" + code + "）" : "") };
}

module.exports = { explainUpdateError };
