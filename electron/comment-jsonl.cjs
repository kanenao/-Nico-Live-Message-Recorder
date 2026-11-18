"use strict";

const fs = require("node:fs");

// JSONL keeps one record per line. Preserve valid records even if a file
// contains a partial/corrupted final line after an interrupted recording.
function parseCommentJsonlText(value) {
  // Accept correct newline-delimited JSON and older sessions whose writer
  // accidentally appended objects together with no line breaks.
  // A small state machine recognizes balanced top-level JSON objects without
  // splitting at braces inside comment strings.
  const records = [];
  const source = String(value == null ? "" : value).replace(/^\uFEFF/, "");
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const record = JSON.parse(source.slice(start, index + 1));
          if (record && typeof record === "object" && !Array.isArray(record)) {
            records.push(record);
          }
        } catch (_) {
          // Skip a damaged object; retain any other complete JSON records.
        }
        start = -1;
      }
    } else if (char === "\n" && depth > 0 && !inString) {
      // An interrupted object on a previous line must not swallow a later
      // complete record from the same JSONL file.
      // Only resynchronize when the next meaningful row starts an object.
      let next = index + 1;
      while (next < source.length && (source[next] === " " || source[next] === "\t" || source[next] === "\r")) next += 1;
      if (source[next] === "{") {
        start = -1;
        depth = 0;
      }
    }
  }
  return records;
}

function readCommentJsonlRecords(filePath) {
  return parseCommentJsonlText(fs.readFileSync(filePath, "utf8"));
}

module.exports = { parseCommentJsonlText, readCommentJsonlRecords };
