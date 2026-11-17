"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateAssFromRecords } = require("../electron/ass.cjs");
const {
  normalizeAssMotion, calculateAutomaticAssMotion,
  calculateAutomaticAssSafeStart, reserveAutomaticAssLane, AUTO_ASS_LANE_ORDER
} = require("../electron/ass-motion.cjs");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const start = { type: "videoStart", videoStartedAt: "2026-11-18T00:00:00.000Z" };

function comment(time, content, mail = "") {
  return { type: "comment", timestamp: new Date(Date.parse(start.videoStartedAt) + time * 1000).toISOString(), content, mail };
}

function dialogue(result) {
  return result.content.split("\r\n").filter(line => line.startsWith("Dialogue:"));
}

function timeSeconds(raw) {
  const match = raw.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  assert.ok(match, "invalid ASS time " + raw);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
}

function coordinates(line) {
  const match = line.match(/\\move\((\d+),(\d+),(-?\d+),(\d+)\)/);
  assert.ok(match, "ASS move missing: " + line);
  return match.slice(1).map(Number);
}

test("automatic motion is on by default, but can be disabled for manual values", () => {
  assert.equal(normalizeAssMotion().assAutoMotion, true);
  assert.equal(normalizeAssMotion({ assAutoMotion: false }).assAutoMotion, false);
  const manual = generateAssFromRecords([start, comment(1, "手動")], {
    assAutoMotion: false, assScrollSpeed: 180, assEntryOffset: 320
  });
  assert.match(dialogue(manual)[0], /\\move\(2240,52,-\d+,52\)/);
  assert.equal(manual.automaticallyAdjustedCount, 0);
  assert.equal(manual.automaticallyDeferredCount, 0);
});

test("short and long comments enter at the right edge and cross in about five seconds", () => {
  const shortResult = generateAssFromRecords([start, comment(1, "うぽつ")]);
  const longResult = generateAssFromRecords([start, comment(1, "おつかれさま".repeat(18))]);
  const shortLine = dialogue(shortResult)[0];
  const longLine = dialogue(longResult)[0];
  assert.equal(coordinates(shortLine)[0], 1920);
  assert.equal(coordinates(longLine)[0], 1920);
  assert.ok(Math.abs((timeSeconds(shortLine.split(",")[2]) - timeSeconds(shortLine.split(",")[1])) - 5.2) < 0.03);
  assert.ok(Math.abs((timeSeconds(longLine.split(",")[2]) - timeSeconds(longLine.split(",")[1])) - 5.2) < 0.03);
  assert.ok(Math.abs(coordinates(longLine)[2]) > Math.abs(coordinates(shortLine)[2]));
  assert.equal(shortResult.automaticallyAdjustedCount, 1);
});

test("dense comments speed up moderately and fan out to additional screen rows", () => {
  const sparse = calculateAutomaticAssMotion(400, 1);
  const dense = calculateAutomaticAssMotion(400, 28);
  assert.ok(dense.speed > sparse.speed);
  assert.ok(dense.duration < sparse.duration);
  assert.equal(dense.entryX, 1920);
  assert.ok(dense.laneCount > sparse.laneCount);
  const result = generateAssFromRecords([
    start, ...Array.from({ length: 32 }, (_, index) => comment(1, "コメント" + index))
  ]);
  const lines = dialogue(result);
  const rows = new Set(lines.map(line => coordinates(line)[1]));
  assert.equal(lines.length, 32);
  assert.equal(result.automaticallyAdjustedCount, 32);
  assert.ok(rows.size >= 8, "the text should be spread over multiple rows");
  assert.ok(result.automaticallyDeferredCount > 0, "overloaded rows should be deferred");
  assert.match(lines[0], /Dialogue: 0,0:00:01\.00,/);
});

test("a faster following comment never catches the older comment in the same row", () => {
  const previous = { start: 1, entryX: 1920, width: 180, speed: 420 };
  const nextSpeed = 700;
  const startAt = calculateAutomaticAssSafeStart(previous, 1.5, 1920, nextSpeed);
  const priorExit = previous.start + (previous.entryX + previous.width) / previous.speed;
  assert.ok(startAt > 1.5);
  // At every overlapping instant, the next left edge stays >= 48 px behind
  // the older comment's trailing right edge.
  for (let t = startAt; t < priorExit; t += 0.05) {
    const previousTail = previous.entryX + previous.width - previous.speed * (t - previous.start);
    const nextFront = 1920 - nextSpeed * (t - startAt);
    assert.ok(nextFront - previousTail >= 47.99);
  }
  const lanes = Array(18).fill(null);
  const first = reserveAutomaticAssLane(lanes, [8], 1, 180, 420, 1920);
  const second = reserveAutomaticAssLane(lanes, [8], 1.5, 180, 700, 1920);
  assert.equal(first.index, 8);
  assert.equal(second.index, 8);
  assert.ok(second.start >= startAt - 1e-8);
  assert.equal(AUTO_ASS_LANE_ORDER.length, 18);
  assert.equal(new Set(AUTO_ASS_LANE_ORDER).size, 18);
});

test("NG filtering, fixed ue/shita comments and timestamps remain intact in auto mode", () => {
  const generated = generateAssFromRecords([
    start,
    comment(1, "うぽつ"),
    comment(2, "連投"),
    comment(3, "上固定", "ue red"),
    comment(3.5, "下固定", "shita")
  ], { ngRegex: "連投", assAutoMotion: true });
  const lines = dialogue(generated);
  assert.equal(lines.length, 3);
  assert.equal(generated.filteredCount, 1);
  assert.equal(generated.automaticallyAdjustedCount, 1);
  assert.match(lines[0], /Dialogue: 0,0:00:01\.00,/);
  assert.match(lines[1], /\\an8\\pos\(/);
  assert.match(lines[2], /\\an2\\pos\(/);
  assert.doesNotMatch(generated.content, /連投/);
});

test("manual and automatic exports persist the toggle and surface adjustment information", () => {
  assert.match(main, /\.\.\.normalizeAssMotion\(stored\)/);
  assert.match(main, /\.\.\.normalizeAssMotion\(candidate\)/);
  assert.match(main, /\.\.\.normalizeAssMotion\(getMonitorSettings\(\)\)/);
  assert.match(main, /automaticallyAdjustedCount: generated\.automaticallyAdjustedCount/);
  assert.match(renderer, /settings\.assAutoMotion = byId\(prefix \+ "auto-motion"\)\.checked/);
  assert.match(renderer, /auto\.checked = values\.assAutoMotion !== false/);
  assert.match(renderer, /api\.exportAss\(\{ ngRegex: byId\("ass-ng-regex"\)\.value, \.\.\.readAssMotionInputs\("ass-"\) \}\)/);
  for (const id of ["ass-auto-motion", "setting-ass-auto-motion", "reset-ass-motion-button", "save-ass-motion-button"]) {
    assert.ok(html.includes('id="' + id + '"'), "Missing automatic ASS UI " + id);
  }
});
