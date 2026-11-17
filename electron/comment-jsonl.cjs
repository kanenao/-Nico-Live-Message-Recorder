"use strict";

const fs = require("node:fs");

// JSONL keeps one record per line. Preserve valid records even if a file
// contains a partial/corrupted final line after an interrupted recording.
function parseCommentJsonlText(value) {
  const records = [];
  const text = String(value == null ? "" : value).replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record);
      }
    } catch (_) {
      // A malformed individual line must not discard the rest of the log.
    }
  }
  return records;
}

function readCommentJsonlRecords(filePath) {
  return parseCommentJsonlText(fs.readFileSync(filePath, "utf8"));
}

module.exports = { parseCommentJsonlText, readCommentJsonlRecords };
