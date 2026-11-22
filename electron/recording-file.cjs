const fs = require("node:fs");

function hasNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { hasNonEmptyFile };
