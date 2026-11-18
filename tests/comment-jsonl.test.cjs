"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCommentJsonlText, readCommentJsonlRecords } = require("../electron/comment-jsonl.cjs");
const { generateAssFromRecords } = require("../electron/ass.cjs");

const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

const records = [
  { type: "videoStart", videoStartedAt: "2026-11-17T12:00:00Z" },
  { type: "comment", timestamp: "2026-11-17T12:00:01Z", content: "うぽつ" },
  { type: "comment", timestamp: "2026-11-17T12:00:02Z", content: "普通のコメント" }
];

test("reads CRLF, LF and BOM-prefixed comments without joining JSONL rows", () => {
  const jsonl = "\uFEFF" + JSON.stringify(records[0]) + "\r\n" +
    JSON.stringify(records[1]) + "\n" + JSON.stringify(records[2]) + "\r\n";
  assert.deepEqual(parseCommentJsonlText(jsonl), records);
});

test("ignores blank, truncated and non-record rows without dropping valid comments", () => {
  const jsonl = [
    JSON.stringify(records[0]),
    "",
    "{broken json",
    JSON.stringify(records[1]),
    "null",
    "[]",
    JSON.stringify("not an object"),
    JSON.stringify(records[2]),
    "{unfinished"
  ].join("\r\n");
  assert.deepEqual(parseCommentJsonlText(jsonl), records);
  assert.deepEqual(parseCommentJsonlText(""), []);
  assert.deepEqual(parseCommentJsonlText(null), []);
});

test("the saved JSONL file reader and ASS converter preserve timestamp alignment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nico-comment-jsonl-"));
  const filePath = path.join(dir, "comments.jsonl");
  try {
    fs.writeFileSync(filePath, "\uFEFF" + records.map(record => JSON.stringify(record)).join("\r\n"), "utf8");
    const parsed = readCommentJsonlRecords(filePath);
    assert.deepEqual(parsed, records);
    const ass = generateAssFromRecords(parsed, { ngRegex: "普通" });
    assert.equal(ass.commentCount, 1);
    assert.equal(ass.filteredCount, 1);
    assert.ok(ass.content.includes("0:00:01.00"));
    assert.match(ass.content, /うぽつ/);
    assert.doesNotMatch(ass.content, /普通のコメント/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CSV and ASS export both use the same JSONL parser", () => {
  const csvStart = main.indexOf('ipcMain.handle("comments:export-csv"');
  const assStart = main.indexOf('ipcMain.handle("comments:export-ass"');
  const nextHandler = main.indexOf("app.whenReady()", assStart);
  assert.ok(csvStart >= 0 && assStart > csvStart && nextHandler > assStart);
  const csvHandler = main.slice(csvStart, assStart);
  const assHandler = main.slice(assStart, nextHandler);
  assert.ok(csvHandler.includes("const records = readCommentJsonlRecords(source);"));
  assert.ok(assHandler.includes("const records = readCommentJsonlRecords(source);"));
  assert.ok(csvHandler.includes("recordsToCsv(records)"));
  assert.ok(assHandler.includes("generateAssFromRecords(records, { ngRegex, ...normalizeAssMotion(options) })"));
});


test("recovers legacy concatenated JSON objects without newline delimiters", () => {
  const legacy = records.map(record => JSON.stringify(record)).join("");
  assert.deepEqual(parseCommentJsonlText(legacy), records);
  const article = require("../electron/articles.cjs").generateBroadcastArticle(legacy, {
    liveId: "lv123456789",
    programTitle: "旧バージョンのコメント復旧"
  });
  assert.equal(article.status, "generated");
  assert.equal(article.commentCount, 2);
  assert.equal(article.uniqueCommenters, 0);
});

test("recovers comments containing braces, escaped quotes and line breaks in mixed logs", () => {
  const mixedRecords = [
    { type: "sessionStart", liveId: "lv123456789" },
    { type: "comment", content: '見た目の括弧 { } と "ダブルクォート"', userId: "1" },
    { type: "comment", content: "改行\nと終わり", userId: "2" }
  ];
  const value = "\uFEFF" + JSON.stringify(mixedRecords[0]) +
    JSON.stringify(mixedRecords[1]) + "\n" + JSON.stringify(mixedRecords[2]) + "\n" +
    '{"type":"comment","content":"途切れたログ"';
  assert.deepEqual(parseCommentJsonlText(value), mixedRecords);
  const article = require("../electron/articles.cjs").generateBroadcastArticle(value, { programTitle: "復旧" });
  assert.equal(article.commentCount, 2);
  assert.equal(article.uniqueCommenters, 2);
});
