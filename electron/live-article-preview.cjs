"use strict";

// Broadcast IDs are globally unique; never match by broadcaster name alone.
// Restrict the IPC response to compact metadata (not embedded JPEGs or transcripts).
function normalizeLiveArticleIds(values, max = 100) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value =>
    typeof value === "string" ? value.trim().toLowerCase() : "")
    .filter(value => /^lv\d{5,}$/.test(value)))].slice(0, max);
}

function selectLiveArticlePreviews(articles, liveIds) {
  const ids = normalizeLiveArticleIds(liveIds);
  const allowed = new Set(ids);
  const latest = new Map();
  for (const article of Array.isArray(articles) ? articles : []) {
    if (!article || article.status !== "generated") continue;
    const liveId = String(article.liveId || "").trim().toLowerCase();
    if (!allowed.has(liveId)) continue;
    const timestamp = Date.parse(article.generatedAt || article.startedAt || "") || 0;
    const current = latest.get(liveId);
    if (current && current.timestamp > timestamp) continue;
    const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
    const description = article.summary || paragraphs.find(Boolean) || "";
    latest.set(liveId, {
      timestamp,
      preview: {
        liveId,
        title: String(article.title || article.programTitle || "放送記事").slice(0, 160),
        summary: String(description).replace(/\s+/g, " ").trim().slice(0, 260),
        aiProvider: String(article.aiProvider || "").slice(0, 50),
        aiModel: String(article.aiModel || "").slice(0, 80),
        liveStatus: String(article.liveStatus || "").slice(0, 24),
        generatedAt: String(article.generatedAt || "").slice(0, 40),
        commentCount: Math.max(0, Number(article.commentCount) || 0),
        videoFrameCount: Math.max(0, Number(article.videoFrameCount) || 0),
        hasAudio: Boolean(article.audioTranscript || article.audioAnalysis)
      }
    });
  }
  return {
    items: ids.map(id => latest.get(id)?.preview).filter(Boolean),
    requested: ids.length
  };
}

module.exports = { normalizeLiveArticleIds, selectLiveArticlePreviews };
