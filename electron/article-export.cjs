"use strict";

const { normalizeArticleCoverImage } = require("./article-cover.cjs");

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
  const chapters = (Array.isArray(article.aiSections) ? article.aiSections : [])
    .filter(item => item && item.heading && item.body)
    .slice(0, 6)
    .map(item => "<section class=\"chapter\"><h2>" + e(String(item.heading).slice(0, 90)) +
      "</h2><p>" + e(String(item.body).slice(0, 2000)) + "</p></section>").join("");
  const cover = normalizeArticleCoverImage(article.coverImage);
  const coverMarkup = cover ? "<figure class=\"cover\"><img alt=\"放送映像のサムネイル\" src=\"" + e(cover) + "\"></figure>" : "";
  const transcript = article.audioTranscript ? "<pre>" + e(article.audioTranscript) + "</pre>" : "";
  const sourceNotes = [article.videoAnalysis, article.audioAnalysis, article.note].filter(Boolean).map(value => "<p>" + e(value) + "</p>").join("");
  const aiEvidence = article.aiEvidence && typeof article.aiEvidence === "object" ? article.aiEvidence : {};
  const aiSourceCoverage = article.aiSourceCoverage && typeof article.aiSourceCoverage === "object" ? article.aiSourceCoverage : {};
  const labels = {
    analyzed: "画像AI解析済み", sampled: "映像フレーム取得済み（AI未解析）", transcribed: "文字起こしあり", unavailable: "未取得"
  };
  const sourceQuality = article.aiProvider ? [
    "<p>生成状態：" + e(article.aiGenerationStatus === "recovered" ? "短縮再生成" :
      article.aiGenerationStatus === "fallback" ? "標準記事（AI生成失敗）" :
      article.aiGenerationStatus === "stale" ? "前回の完成記事を保持（AI更新失敗）" : "AI記事") + "</p>",
    "<p>コメント：" + e((Number(aiEvidence.commentCount) || 0) + "件中" +
      (Number(aiEvidence.sampleCount) || 0) + "件を抜粋") +
      "／映像：" + e(labels[aiSourceCoverage.video] || "未取得") +
      "／音声：" + e(labels[aiSourceCoverage.audio] || "未取得") + "</p>",
    ...(Array.isArray(article.aiQualityNotes) ? article.aiQualityNotes.slice(0, 8) : [])
      .map(note => "<p>注意：" + e(note) + "</p>")
  ].join("") : "";
  return "<!doctype html>\n<html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><style>" +
    "body{margin:0;background:#f4f6fa;color:#20283a;font:16px/1.85 system-ui,sans-serif}main{max-width:900px;margin:40px auto;padding:40px;background:#fff;border-radius:16px;box-shadow:0 8px 32px #18233a12}h1{line-height:1.4}h2{margin-top:32px;border-bottom:1px solid #e4e8f0;padding-bottom:8px}header p,.meta{color:#647087;font-size:14px}.lead{font-size:1.15em;font-weight:600;background:#f3f5fb;padding:18px;border-radius:10px}.cover{margin:20px 0}.cover img{width:100%;max-height:430px;object-fit:cover;border-radius:12px;aspect-ratio:16/9}.chapter{border-bottom:1px solid #e4e8f0;padding:10px 0 14px}.chapter p{white-space:pre-wrap}.topic{display:inline-block;background:#edf0ff;color:#394b91;padding:3px 10px;border-radius:20px;margin:3px}li{margin:7px 0}time{font-variant-numeric:tabular-nums;color:#596b9b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7fa;padding:18px;border-radius:10px}@media(max-width:700px){main{margin:0;padding:22px;border-radius:0}}" +
    "</style></head><body><main><header><p class=\"meta\">Nico Live Message Recorder / 放送記事</p><h1>" + title + "</h1><p>" + meta + "</p></header>" +
    coverMarkup +
    (article.summary ? "<p class=\"lead\">" + e(article.summary) + "</p>" : "") +
    (chapters || section("記事本文", paragraphs)) +
    section("注目ポイント", highlights ? "<ul>" + highlights + "</ul>" : "") +
    section("放送の流れ", timeline ? "<ol>" + timeline + "</ol>" : "") +
    section("話題", topics) +
    section("音声文字起こし", transcript) +
    section("記事の根拠・取得状況", sourceQuality) +
    section("分析・補足", sourceNotes) +
    "<footer><p class=\"meta\">生成日時：" + e(article.generatedAt || "") + " ・ 映像や音声の認識結果には誤りが含まれる場合があります。</p></footer></main></body></html>";
}

module.exports = { escapeHtml, renderArticleHtml };
