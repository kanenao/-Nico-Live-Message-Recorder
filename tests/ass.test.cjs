"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateAssFromRecords, assTime } = require("../electron/ass.cjs");

test("aligns ASS timestamps to videoStart and excludes earlier history", () => {
  const result = generateAssFromRecords([
    { type: "sessionStart", sessionStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:03.000Z", content: "old history" },
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:05.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:06.230Z", content: "こんにちは" }
  ]);

  assert.equal(result.commentCount, 1);
  assert.match(result.content, /Dialogue: 0,0:00:01\.22,/);
  assert.match(result.content, /こんにちは/);
  assert.doesNotMatch(result.content, /old history/);
});

test("converts top, bottom, color and size commands", () => {
  const result = generateAssFromRecords([
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:01.000Z", content: "top red", mail: "ue red big" },
    { type: "comment", timestamp: "2026-11-11T00:00:07.000Z", content: "bottom blue", mail: "shita blue small" }
  ]);

  assert.match(result.content, /\\an8\\pos\(/);
  assert.match(result.content, /\\an2\\pos\(/);
  assert.match(result.content, /\\c&H000000FF&/);
  assert.match(result.content, /\\c&H00FF0000&/);
  assert.match(result.content, /\\fs50/);
  assert.match(result.content, /\\fs32/);
});

test("escapes ASS override braces and newlines", () => {
  const result = generateAssFromRecords([
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:01.000Z", content: "{\\an7}hello\nworld" }
  ]);

  assert.match(result.content, /\\\{\\\\an7\\\}hello\\Nworld/);
});

test("formats ASS time in centiseconds", () => {
  assert.equal(assTime(3723456), "1:02:03.45");
});

test("rejects an empty comment set", () => {
  assert.throws(() => generateAssFromRecords([{ type: "gift", content: "gift" }]), /コメントがありません/);
});
