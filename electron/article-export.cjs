"use strict";

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderArticleHtml(article = {}) {
  const e = escapeHtml;
  const title = e(article.title || article.programTitle || "放送記事");
  const meta = [
    article.broadcasterName,
    article.liveId,
    article.startedAt || article.generatedAt
  ].filter(Boolean).map(e).join(" ・ ");
  const section = (heading, body) => body ? "<section><h2>" + e(heading) + "</h2>" + body + "</section>" : "";
  const paragraphs = (Array.isArray(article.paragraphs) ? article.paragraphs : [])
    .filter(Boolean).map(value => "<p>" + e(value) + "</p>").join("");
  const highlights = (Array.isArray(article.aiHighlights) ? article.aiHighlights : [])
    .filter(Boolean).map(value => "<li>" + e(value) + "</li>").join("");
  const timeline = (Array.isArray(article.aiTimeline) ? article.aiTimeline : [])
    .map(item => item && "<li><time>" + e(item.time || item.timestamp || "") + "</time> " + e(item.detail || item.title || "") + "</li>").filter(Boolean).join("");
  const topics = (Array.isArray(article.topics) ? article.topics : [])
    .map(item => typeof item === "string" ? item : item && item.term).filter(Boolean)
    .map(value => "<span class=\"topic\">" + e(value) + "</span>").join(" ");
  const transcript = article.audioTranscript ? "<pre>" + e(article.audioTranscript) + "</pre>" : "";
  const sourceNotes = [article.videoAnalysis, article.audioAnalysis, article.note].filter(Boolean).map(value => "<p>" + e(value) + "</p>").join("");
  return "<!doctype html>\n<html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><style>" +
    "body{margin:0;background:#f4f6fa;color:#20283a;font:16px/1.85 system-ui,sans-serif}main{max-width:900px;margin:40px auto;padding:40px;background:#fff;border-radius:16px;box-shadow:0 8px 32px #18233a12}h1{line-height:1.4}h2{margin-top:32px;border-bottom:1px solid #e4e8f0;padding-bottom:8px}header p,.meta{color:#647087;font-size:14px}.lead{font-size:1.15em;font-weight:600;background:#f3f5fb;padding:18px;border-radius:10px}.topic{display:inline-block;background:#edf0ff;color:#394b91;padding:3px 10px;border-radius:20px;margin:3px}li{margin:7px 0}time{font-variant-numeric:tabular-nums;color:#596b9b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7fa;padding:18px;border-radius:10px}@media(max-width:700px){main{margin:0;padding:22px;border-radius:0}}" +
    "</style></head><body><main><header><p class=\"meta\">Nico Live Message Recorder / 放送記事</p><h1>" + title + "</h1><p>" + meta + "</p></header>" +
    (article.summary ? "<p class=\"lead\">" + e(article.summary) + "</p>" : "") +
    section("記事本文", paragraphs) +
    section("注目ポイント", highlights ? "<ul>" + highlights + "</ul>" : "") +
    section("放送の流れ", timeline ? "<ol>" + timeline + "</ol>" : "") +
    section("話題", topics) +
    section("音声文字起こし", transcript) +
    section("分析・補足", sourceNotes) +
    "<footer><p class=\"meta\">生成日時：" + e(article.generatedAt || "") + " ・ 映像や音声の認識結果には誤りが含まれる場合があります。</p></footer></main></body></html>";
}

module.exports = { escapeHtml, renderArticleHtml };
