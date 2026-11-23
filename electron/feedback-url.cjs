"use strict";
const REPO_ISSUES = "https://github.com/kanenao/-Nico-Live-Message-Recorder/issues/new";
function buildFeedbackIssueUrl(input = {}) {
  const {kind,edition} = input;
  if (!["bug","feature"].includes(kind)) throw new TypeError("報告の種類が正しくありません。");
  if (!["beta","product"].includes(edition)) throw new TypeError("アプリの版が正しくありません。");
  const details = String(input.details || "").trim();
  if (!details || details.length > 500) throw new TypeError("報告内容を1〜500文字で入力してください。");
  if (/user_session\s*=|(?:^|\s)(?:cookie|authorization|password|パスワード)\s*[:=]/i.test(details))
    throw new TypeError("認証情報が含まれている可能性があります。user_sessionやCookieを削除してください。");
  const version = String(input.version || "");
  if (!/^\d+\.\d+\.\d+(?:-(?:beta|alpha)\.\d+)?$/.test(version))
    throw new TypeError("バージョン情報が正しくありません。");
  const url = new URL(REPO_ISSUES);
  url.searchParams.set("template", kind === "bug" ? "bug_report.yml" : "feature_request.yml");
  url.searchParams.set("edition", edition === "beta" ? "β版" : "正規版");
  url.searchParams.set("version", version);
  url.searchParams.set("details", details);
  url.searchParams.set("title", (kind === "bug" ? "[不具合] " : "[要望] ") + details.slice(0, 55).replace(/[\r\n]+/g, " "));
  return url.toString();
}
module.exports = { buildFeedbackIssueUrl };