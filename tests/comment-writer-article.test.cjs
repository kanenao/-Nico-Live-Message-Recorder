"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeCommentLine, finishCommentWriter } = require("../electron/comment-writer.cjs");
const { readCommentJsonlRecords } = require("../electron/comment-jsonl.cjs");
const { generateBroadcastArticle } = require("../electron/articles.cjs");

test("multiple live comment events are saved as valid individual JSONL lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nico-article-jsonl-"));
  const file = path.join(dir, "live.jsonl");
  try {
    const writer = fs.createWriteStream(file, { flags: "wx" });
    const events = [
      { type: "sessionStart", liveId: "lv123456789" },
      { type: "programMetadata", programTitle: "コメント連携確認" },
      { type: "comment", content: "こんにちは", userId: "1" },
      { type: "comment", content: "次のコメント", userId: "2" }
    ];
    // Real capture does not await event writes; the barrier must still see all.
    const writes = events.map(value => writeCommentLine(writer, JSON.stringify(value)));
    await Promise.all(writes);
    await writeCommentLine(writer, "");
    await finishCommentWriter(writer);
    const saved = fs.readFileSync(file, "utf8");
    const lines = saved.trim().split(/\r?\n/);
    assert.equal(lines.length, events.length);
    assert.deepEqual(lines.map(line => JSON.parse(line)), events);
    assert.deepEqual(readCommentJsonlRecords(file), events);
    const article = generateBroadcastArticle(saved, { liveId: "lv123456789" });
    assert.equal(article.commentCount, 2);
    assert.equal(article.uniqueCommenters, 2);
    assert.match(article.paragraphs.join("\n"), /2件/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-delimited records do not gain duplicate separators", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nico-comment-writer-"));
  const file = path.join(dir, "stream.jsonl");
  try {
    const writer = fs.createWriteStream(file, { flags: "wx" });
    await writeCommentLine(writer, '{"type":"comment","content":"A"}\n');
    await writeCommentLine(writer, '{"type":"comment","content":"B"}\r\n');
    await finishCommentWriter(writer);
    assert.equal(fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("previously joined comments remain usable for ASS and article summaries", () => {
  const { parseCommentJsonlText } = require("../electron/comment-jsonl.cjs");
  const { generateAssFromRecords } = require("../electron/ass.cjs");
  const previous = [
    { type: "videoStart", videoStartedAt: "2026-11-18T12:00:00Z" },
    { type: "comment", content: "最初のコメント", timestamp: "2026-11-18T12:00:01Z", userId: "1" },
    { type: "comment", content: "次のコメント", timestamp: "2026-11-18T12:00:02Z", userId: "2" }
  ];
  const damaged = previous.map(row => JSON.stringify(row)).join("");
  const recovered = parseCommentJsonlText(damaged);
  assert.deepEqual(recovered, previous);
  assert.equal(generateAssFromRecords(recovered).commentCount, 2);
  const article = generateBroadcastArticle(damaged, { programTitle: "旧保存形式の復旧" });
  assert.equal(article.commentCount, 2);
  assert.equal(article.uniqueCommenters, 2);
});

test("finishing an already destroyed comment stream rejects instead of hanging", async () => {
  const { Writable } = require("node:stream");
  const writer = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  writer.destroy();
  await assert.rejects(finishCommentWriter(writer), /終了前に閉じられました/);
});

test("premature close while finishing a comment stream rejects instead of hanging", async () => {
  const { Writable } = require("node:stream");
  const writer = new Writable({
    write(_chunk, _encoding, _callback) {
      // Simulate an interrupted disk write that never invokes its callback.
    }
  });
  writer.write('{"type":"comment","content":"pending"}\\n');
  const finishing = finishCommentWriter(writer);
  writer.destroy();
  await assert.rejects(finishing, /終了前に閉じられました/);
});
