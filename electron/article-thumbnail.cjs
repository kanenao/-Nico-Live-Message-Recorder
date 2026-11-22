"use strict";

const path = require("node:path");
const VIDEO_EXTENSIONS = new Set([".mp4", ".ts", ".mkv", ".webm", ".mov", ".m4v", ".avi"]);

function recordingStem(value) {
  const file = path.basename(String(value || ""));
  const extension = path.extname(file).toLowerCase();
  return extension ? file.slice(0, -extension.length).toLowerCase() : file.toLowerCase();
}

function isVideoPath(value) {
  return typeof value === "string" && VIDEO_EXTENSIONS.has(path.extname(value).toLowerCase());
}

// Prefer the specific recorded session; never silently attach a different
// segment from the same broadcast when there is more than one candidate.
function findArticleVideoCandidate(article, videoItems = [], exists = () => true) {
  if (!article || typeof article !== "object") return "";
  if (isVideoPath(article.videoFile) && exists(article.videoFile)) return article.videoFile;

  const candidates = (Array.isArray(videoItems) ? videoItems : []).map(item =>
    typeof item === "string" ? item : item && item.path
  ).filter(value => isVideoPath(value) && exists(value));
  const savedStem = recordingStem(article.commentFile || article.articlePath || "");
  const exact = savedStem
    ? candidates.filter(item => recordingStem(item) === savedStem)
    : [];
  if (exact.length) {
    const mp4 = exact.find(value => path.extname(value).toLowerCase() === ".mp4");
    return mp4 || exact[0];
  }

  const liveId = String(article.liveId || "").toLowerCase();
  if (!/^lv\d{5,}$/.test(liveId)) return "";
  const matching = candidates.filter(value => recordingStem(value).startsWith(liveId + "_"));
  const distinctSessions = new Set(matching.map(recordingStem));
  if (distinctSessions.size === 1) {
    return matching.find(value => path.extname(value).toLowerCase() === ".mp4") || matching[0];
  }
  return "";
}

module.exports = { VIDEO_EXTENSIONS, recordingStem, isVideoPath, findArticleVideoCandidate };
