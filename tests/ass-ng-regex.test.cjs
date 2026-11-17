"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { compileAssNgRegex, isAssNgComment } = require("../electron/ass-ng-regex.cjs");
const { generateAssFromRecords } = require("../electron/ass.cjs");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const records = [
  { type: "videoStart", videoStartedAt: "2026-11-17T12:00:00Z" },
  { type: "comment", timestamp: "2026-11-17T12:00:01Z", content: "うぽつ" },
  { type: "comment", timestamp: "2026-11-17T12:00:02Z", content: "連投しています" },
  { type: "comment", timestamp: "2026-11-17T12:00:03Z", content: "Visit HTTPS://example.org" },
  { type: "comment", timestamp: "2026-11-17T12:00:04Z", content: "普通の日本語コメント" }
];

test("filters multiple regex NG patterns before emitting ASS while preserving timestamps", () => {
  const result = generateAssFromRecords(records, { ngRegex: "連投|荒らし\nhttps?://\\S+" });
  assert.equal(result.commentCount, 2);
  assert.equal(result.filteredCount, 2);
  assert.match(result.content, /うぽつ/);
  assert.match(result.content, /普通の日本語コメント/);
  assert.doesNotMatch(result.content, /連投しています/);
  assert.doesNotMatch(result.content, /Visit HTTPS/);
  assert.match(result.content, /0:00:04\.00/);
  assert.equal(records.filter(r => r.type === "comment").length, 4);
});

test("blank rules preserve all comments; slash flags support explicit case-sensitive matching", () => {
  const result = generateAssFromRecords(records, { ngRegex: " \n " });
  assert.equal(result.commentCount, 4);
  assert.equal(result.filteredCount, 0);
  const insensitive = compileAssNgRegex("uPoTsU\n^うぽつ$");
  assert.equal(isAssNgComment("うぽつ", insensitive), true);
  const sensitive = compileAssNgRegex("/Spam/\n/spam/i");
  assert.equal(isAssNgComment("SPAM", sensitive), true);
  assert.equal(isAssNgComment("Spam", compileAssNgRegex("/Spam/")), true);
  assert.equal(isAssNgComment("SPAM", compileAssNgRegex("/Spam/")), false);
});

test("invalid regex, unsupported flags, and expensive patterns fail with line numbers", () => {
  for (const pattern of ["正常\n[", "/foo/g", "/foo/ii", "(a+)+", "(a*)*", "\\1"]) {
    assert.throws(() => compileAssNgRegex(pattern), /NGワード.*行目/);
  }
  assert.throws(() => compileAssNgRegex("X".repeat(4001)), /4000文字/);
  assert.throws(() => compileAssNgRegex("A".repeat(241)), /240文字/);
  assert.throws(() => compileAssNgRegex(Array(41).fill("a").join("\n")), /最大40行/);
});

test("all comments excluded produces an actionable error rather than silently emitting empty ASS", () => {
  assert.throws(() => generateAssFromRecords(records, { ngRegex: ".*" }), /NGワード設定によりASSへ出力できるコメントがありません/);
});

test("manual and automatic ASS export share persisted NG regex, but original logs and CSV are unfiltered", () => {
  assert.match(main, /assNgRegex: ""/);
  assert.match(main, /compileAssNgRegex\(assNgRegex\)/);
  assert.match(main, /assNgRegex: typeof stored\.assNgRegex/);
  assert.match(main, /ngRegex: getMonitorSettings\(\)\.assNgRegex/);
  assert.match(main, /generateAssFromRecords\(records, \{\s*ngRegex: getMonitorSettings/);
  assert.match(main, /generateAssFromRecords\(records, \{ ngRegex, \.\.\.normalizeAssMotion\(options\) \}\)/);
  assert.match(main, /output = generateAssFromRecords\(records,[\s\S]*?\)\.content/);
  assert.match(main, /output = recordsToCsv\(records\)/);
  assert.match(main, /return \{ path: saveResult\.filePath, commentCount: generated\.commentCount, filteredCount: generated\.filteredCount \}/);
  assert.match(preload, /exportAss: \(options\) => ipcRenderer\.invoke\("comments:export-ass", options\)/);
  for (const id of ["ass-ng-regex", "save-ass-ng-button", "setting-ass-ng-regex"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing ASS regex input: " + id);
  }
  assert.match(renderer, /api\.exportAss\(\{ ngRegex: byId\("ass-ng-regex"\)\.value, \.\.\.readAssMotionInputs\("ass-"\) \}\)/);
  assert.match(renderer, /api\.saveMonitorSettings\(\{\s*assNgRegex: byId\("ass-ng-regex"\)\.value/);
  assert.match(renderer, /setting-ass-ng-regex/);
});
