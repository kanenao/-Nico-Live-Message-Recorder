"use strict";

const fs = require("node:fs");
// Both the Electron main process and the renderer must decode exactly the
// same JSONL grammar. Older recorder versions sometimes concatenated objects
// without newlines, so parsing one physical line with JSON.parse is unsafe.
const { parseCommentJsonlText } = require("../composition.js");

function readCommentJsonlRecords(filePath) {
  return parseCommentJsonlText(fs.readFileSync(filePath, "utf8"));
}

module.exports = { parseCommentJsonlText, readCommentJsonlRecords };
