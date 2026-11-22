"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveSavedCommentFile, isActiveCommentFile
} = require("../electron/library-comment-file.cjs");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");

function withArchive(callback) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nico-comment-delete-test-"));
  const comments = path.join(temp, "comments");
  const videos = path.join(temp, "videos");
  const articles = path.join(temp, "articles");
  const broadcaster = path.join(comments, "放送者");
  fs.mkdirSync(broadcaster, { recursive: true });
  fs.mkdirSync(videos);
  fs.mkdirSync(articles);
  try { callback({ temp, comments, videos, articles, broadcaster }); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

test("allows individual JSONL, CSV and ASS files within the saved comments folder", () => {
  withArchive(({ comments, broadcaster }) => {
    for (const extension of [".jsonl", ".csv", ".ass", ".JSONL"]) {
      const filePath = path.join(broadcaster, "配信者_20261117_120000" + extension);
      fs.writeFileSync(filePath, "example");
      assert.equal(resolveSavedCommentFile(filePath, comments), fs.realpathSync(filePath));
      assert.equal(fs.existsSync(filePath), true, "validation must never delete files");
    }
  });
});

test("rejects videos, AI articles, unsupported extensions and directory traversal", () => {
  withArchive(({ comments, videos, articles, temp, broadcaster }) => {
    for (const filePath of [
      path.join(videos, "recording.mp4"),
      path.join(articles, "article.json"),
      path.join(temp, "other.jsonl"),
      path.join(broadcaster, "not-comment.txt"),
      path.join(comments, "..", "videos", "recording.jsonl")
    ]) {
      fs.writeFileSync(filePath, "example");
      assert.throws(() => resolveSavedCommentFile(filePath, comments), /コメント|保存フォルダー/);
    }
    assert.throws(() => resolveSavedCommentFile(comments, comments), /コメント/);
  });
});

test("does not follow symbolic links outside the comments folder", (t) => {
  withArchive(({ comments, temp, broadcaster }) => {
    const outside = path.join(temp, "private.jsonl");
    const linked = path.join(broadcaster, "linked.jsonl");
    fs.writeFileSync(outside, "private");
    try { fs.symlinkSync(outside, linked, "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlinks require elevated Windows permission"); return; }
      throw error;
    }
    assert.throws(() => resolveSavedCommentFile(linked, comments), /コメントファイル|保存フォルダー/);
    assert.equal(fs.readFileSync(outside, "utf8"), "private");
  });
});

test("a running comment log and its sidecars are protected; unrelated archives are eligible", () => {
  const active = path.resolve("comments", "streamer", "lv12345_20261117_120000.jsonl");
  assert.equal(isActiveCommentFile(active, active), true);
  assert.equal(isActiveCommentFile(active.replace(/\.jsonl$/, ".csv"), active), true);
  assert.equal(isActiveCommentFile(active.replace(/\.jsonl$/, ".ass"), active), true);
  assert.equal(isActiveCommentFile(path.resolve("comments", "other", "lv12345_20261117_120000.jsonl"), active), false);
  assert.equal(isActiveCommentFile(path.resolve("comments", "streamer", "another.jsonl"), active), false);
  assert.equal(isActiveCommentFile(active, ""), false);
});

test("native confirmation, revalidation and renderer UI preserve video and AI article files", () => {
  const start = main.indexOf('ipcMain.handle("library:delete-comment"');
  const end = main.indexOf('ipcMain.handle("comments:export-csv"', start);
  assert.ok(start > 0 && end > start, "comment delete IPC must exist");
  const handler = main.slice(start, end);
  assert.match(handler, /resolveSavedCommentFile\(value, commentsRoot\)/);
  assert.match(handler, /commentFinalizing \|\| timeshiftCommentFetchActive/);
  assert.match(handler, /commentWriter && isActiveCommentFile\(target, commentFilePath\)/);
  assert.match(handler, /dialog\.showMessageBox\(mainWindow/);
  assert.match(handler, /cancelId: 0/);
  assert.match(handler, /confirmation\.response !== 1/);
  assert.match(handler, /const confirmedTarget = resolveSavedCommentFile\(value, commentsRoot\)/);
  assert.match(handler, /ensureNotActive\(\)/);
  assert.match(handler, /await fs\.promises\.unlink\(target\)/);
  assert.doesNotMatch(handler, /unlink\([^)]*video|deleteBroadcastArticle|\.rm\(/);
  assert.match(main, /commentFinalizing = true/);
  assert.match(main, /commentFinalizing = false/);
  assert.match(preload, /deleteLibraryComment:.*ipcRenderer\.invoke\("library:delete-comment"/);
  assert.match(renderer, /if \(item\.type === "comment"\)/);
  assert.match(renderer, /api\.deleteLibraryComment\(item\.path\)/);
  assert.match(renderer, /await loadCaptureLibrary\(\)/);
  assert.match(renderer, /deleteCommentButton\.textContent = "削除"/);
});
