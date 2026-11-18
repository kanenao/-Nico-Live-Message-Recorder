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
