"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMMENT_EXTENSIONS = new Set([".jsonl", ".csv", ".ass"]);

function isStrictlyInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

// Reject files outside comments/, symlinks (including parent symlinks that
// resolve outside comments/), folders, and unrelated file formats.
function resolveSavedCommentFile(value, commentsDirectory, options = {}) {
  const io = options.fs || fs;
  const root = path.resolve(String(commentsDirectory || ""));
  const target = path.resolve(String(value || ""));
  if (!isStrictlyInside(root, target) || !COMMENT_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error("録画ライブラリのコメントファイル（JSONL・CSV・ASS）だけ削除できます。");
  }
  let resolvedRoot, realTarget;
  try {
    resolvedRoot = io.realpathSync(root);
    if (io.lstatSync(target).isSymbolicLink()) throw new Error("リンクは削除できません。");
    realTarget = io.realpathSync(target);
    if (!io.statSync(realTarget).isFile()) throw new Error("ファイルではありません。");
  } catch (error) {
    throw new Error("コメントファイルを確認できません: " + (error.message || String(error)));
  }
  if (!isStrictlyInside(resolvedRoot, realTarget)) {
    throw new Error("コメント保存フォルダー外のファイルは削除できません。");
  }
  return realTarget;
}

// During capture, the active log and any sidecars with the same base name
// must not be removed. Other broadcaster's archived files stay editable.
function isActiveCommentFile(target, activeCommentPath) {
  if (!activeCommentPath) return false;
  const active = path.resolve(String(activeCommentPath));
  const candidate = path.resolve(String(target));
  return path.dirname(active) === path.dirname(candidate) &&
    path.basename(active, path.extname(active)).toLowerCase() ===
      path.basename(candidate, path.extname(candidate)).toLowerCase();
}

module.exports = { COMMENT_EXTENSIONS, isStrictlyInside,
  resolveSavedCommentFile, isActiveCommentFile };
