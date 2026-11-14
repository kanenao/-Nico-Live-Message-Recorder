const fs = require("node:fs");

function hasNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { hasNonEmptyFile };
