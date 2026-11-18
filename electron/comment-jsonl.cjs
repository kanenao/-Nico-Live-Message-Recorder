"use strict";

const fs = require("node:fs");

// Older writers appended complete JSON objects with no line separator.
function recoverJoinedObjects(line, records) {
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (!depth && /\s/.test(char)) {
      continue;
    } else if (char === "{") {
      if (!depth) start = index;
      depth++;
    } else if (!depth) {
      break;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "}" && --depth === 0) {
      try { records.push(JSON.parse(line.slice(start, index + 1))); }
      catch (_) { /* Skip an invalid object with balanced braces. */ }
    }
  }
}

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
      recoverJoinedObjects(line, records);
    }
  }
  return records;
}

function readCommentJsonlRecords(filePath) {
  return parseCommentJsonlText(fs.readFileSync(filePath, "utf8"));
}

module.exports = { parseCommentJsonlText, readCommentJsonlRecords };
