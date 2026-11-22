"use strict";

const MAX_COVER_BASE64_LENGTH = 420000;
function normalizeArticleCoverImage(value) {
  const raw = String(value || "").replace(/^data:image\/jpeg;base64,/i, "");
  if (raw.length < 100 || raw.length > MAX_COVER_BASE64_LENGTH || raw.length % 4 !== 0) return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return "";
  return "data:image/jpeg;base64," + raw;
}

function selectArticleCoverImage(frames, previousCoverImage = "") {
  if (Array.isArray(frames)) {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const item = frames[index];
      const candidate = typeof item === "string" ? item : (item && item.image);
      const normalized = normalizeArticleCoverImage(candidate);
      if (normalized) return normalized;
    }
  }
  return normalizeArticleCoverImage(previousCoverImage);
}

module.exports = { MAX_COVER_BASE64_LENGTH, normalizeArticleCoverImage, selectArticleCoverImage };
