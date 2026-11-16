"use strict";

// Only program metadata can identify a broadcaster. Viewer/comment user IDs must never be used.
function normalizeBroadcastUserId(value) {
  const valueText = String(value == null ? "" : value).trim();
  return /^\d{5,}$/.test(valueText) ? valueText : "";
}

function normalizeBroadcasterLabel(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function parseBroadcasterFromCommentLog(logText, expectedLiveId = "", expectedName = "") {
  const candidates = new Set();
  const liveId = String(expectedLiveId || "").toLowerCase();
  const name = normalizeBroadcasterLabel(expectedName);
  for (const line of String(logText || "").split(/\r?\n/)) {
    if (!line || line.length > 64000 || !/^\s*\{/.test(line)) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    if (!record || !["sessionStart", "programMetadata"].includes(record.type)) continue;
    if (liveId && record.liveId && String(record.liveId).toLowerCase() !== liveId) continue;
    const claimedName = normalizeBroadcasterLabel(record.broadcasterName || record.providerName);
    if (name && claimedName && claimedName !== name) continue;
    const id = normalizeBroadcastUserId(record.broadcasterUserId || record.broadcasterId || record.providerId);
    if (id) candidates.add(id);
  }
  return candidates.size === 1 ? [...candidates][0] : "";
}

async function readBroadcasterFromCommentLog(filePath, expectedLiveId = "", expectedName = "", fsModule = require("node:fs")) {
  let file;
  try {
    file = await fsModule.promises.open(filePath, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 2) return "";
    const chunkSize = 160 * 1024;
    const readChunk = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    let content = await readChunk(0, Math.min(stat.size, chunkSize));
    if (stat.size > chunkSize) {
      const from = Math.max(chunkSize, stat.size - chunkSize);
      const tail = await readChunk(from, stat.size - from);
      const newline = tail.indexOf("\n");
      content += "\n" + (newline < 0 ? "" : tail.slice(newline + 1));
    }
    return parseBroadcasterFromCommentLog(content, expectedLiveId, expectedName);
  } catch (_) { return ""; }
  finally { if (file) await file.close().catch(() => {}); }
}

function verifiedProgramBroadcaster(page, folderName) {
  if (!page || typeof page !== "object") return "";
  const id = normalizeBroadcastUserId(page.broadcasterId || page.broadcasterUserId);
  if (!id) return "";
  const expectedName = normalizeBroadcasterLabel(folderName);
  const actualName = normalizeBroadcasterLabel(page.broadcasterName);
  // A matching public program name proves the recording belongs to this library group.
  return expectedName && actualName && expectedName === actualName ? id : "";
}

module.exports = { normalizeBroadcastUserId, normalizeBroadcasterLabel,
  parseBroadcasterFromCommentLog, readBroadcasterFromCommentLog, verifiedProgramBroadcaster };
