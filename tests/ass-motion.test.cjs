"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateAssFromRecords } = require("../electron/ass.cjs");
const { normalizeAssMotion, calculateAssHeadwayMs } = require("../electron/ass-motion.cjs");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const videoStart = { type: "videoStart", videoStartedAt: "2026-11-17T12:00:00Z" };
function comment(seconds, content = "うぽつ", mail = "") {
  return {
    type: "comment",
    timestamp: new Date(Date.parse(videoStart.videoStartedAt) + seconds * 1000).toISOString(),
    content,
    mail
  };
}
function dialogueLines(ass) {
  return ass.content.split("\r\n").filter(line => line.startsWith("Dialogue:"));
}

test("manual mode preserves the legacy Nico-style 360 px/sec and right-edge entry", () => {
  const motion = normalizeAssMotion();
  assert.deepEqual(motion, {
    assAutoMotion: true,
    assScrollSpeed: 360,
    assEntryOffset: 0,
    assScrollLanes: 18,
    assFixedDuration: 5,
    assPreventOverlap: true
  });
  const ass = generateAssFromRecords([videoStart, comment(1)], { assAutoMotion: false });
  assert.equal(ass.commentCount, 1);
  assert.match(dialogueLines(ass)[0], /\\move\(1920,52,-\d+,52\)/);
  assert.match(dialogueLines(ass)[0], /Dialogue: 0,0:00:01\.00,/);
});

test("faster speed changes the ASS crossing time while keeping the original timestamp", () => {
  const slow = generateAssFromRecords([videoStart, comment(1, "ながれるコメント")], {
    assAutoMotion: false, assScrollSpeed: 180
  });
  const fast = generateAssFromRecords([videoStart, comment(1, "ながれるコメント")], {
    assAutoMotion: false, assScrollSpeed: 720
  });
  const slowLine = dialogueLines(slow)[0], fastLine = dialogueLines(fast)[0];
  assert.match(slowLine, /Dialogue: 0,0:00:01\.00,/);
  assert.match(fastLine, /Dialogue: 0,0:00:01\.00,/);
  const parseEnd = line => {
    const raw = line.split(",")[2];
    const [, hh, mm, ss, cs] = raw.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cs) / 100;
  };
  assert.ok(parseEnd(slowLine) > parseEnd(fastLine) + 3);
});

test("entry offset starts the movement farther outside the right side", () => {
  const normal = dialogueLines(generateAssFromRecords([videoStart, comment(1)], { assAutoMotion: false }))[0];
  const offset = dialogueLines(generateAssFromRecords([videoStart, comment(1)], {
    assAutoMotion: false, assEntryOffset: 320
  }))[0];
  assert.match(offset, /\\move\(2240,52,-\d+,52\)/);
  assert.match(normal, /\\move\(1920,52,-\d+,52\)/);
  assert.ok(Number(offset.match(/0:00:(\d+)\.(\d+),Default/)[1]) >= Number(normal.match(/0:00:(\d+)\.(\d+),Default/)[1]));
  assert.match(offset, /Dialogue: 0,0:00:01\.00,/);
});

test("same-lane comment reuse waits only for the previous trailing edge, not the full crossing", () => {
  const result = generateAssFromRecords([
    videoStart, comment(1, "短い"), comment(2, "つぎ")
  ], { assAutoMotion: false });
  const lines = dialogueLines(result);
  assert.equal(lines.length, 2);
  // The second comment can reuse line 1 at its original timestamp.
  assert.match(lines[0], /\\move\(1920,52,/);
  assert.match(lines[1], /\\move\(1920,52,/);
  assert.match(lines[1], /Dialogue: 0,0:00:02\.00,/);
  assert.ok(calculateAssHeadwayMs(100, 360) < 600);
});

test("overlap protection delays only overflowing comments; disabling it preserves event timestamps", () => {
  const records = [videoStart, ...Array.from({ length: 19 }, (_, i) => comment(1, "投稿" + i))];
  const protectedAss = generateAssFromRecords(records, { assAutoMotion: false, assPreventOverlap: true });
  const relaxedAss = generateAssFromRecords(records, { assAutoMotion: false, assPreventOverlap: false });
  const protectedLines = dialogueLines(protectedAss);
  const relaxedLines = dialogueLines(relaxedAss);
  assert.equal(protectedLines.length, 19);
  assert.equal(relaxedLines.length, 19);
  // 19th line goes back to the first lane, after a short headway delay.
  assert.doesNotMatch(protectedLines[18], /Dialogue: 0,0:00:01\.00,/);
  assert.match(relaxedLines[18], /Dialogue: 0,0:00:01\.00,/);
});

test("top/bottom fixed comments have adjustable durations and retain mail commands", () => {
  const result = generateAssFromRecords([
    videoStart, comment(1, "上", "ue red big"), comment(1, "下", "shita")
  ], { assFixedDuration: 7 });
  const lines = dialogueLines(result);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Dialogue: 0,0:00:01\.00,0:00:08\.00/);
  assert.match(lines[1], /Dialogue: 0,0:00:01\.00,0:00:08\.00/);
  assert.match(lines[0], /\\an8\\pos\(/);
  assert.match(lines[1], /\\an2\\pos\(/);
  assert.match(lines[0], /\\c&H000000FF&/);
});

test("invalid or extreme values are bounded for safe ASS generation", () => {
  const settings = normalizeAssMotion({
    assScrollSpeed: 0, assEntryOffset: 10000,
    assScrollLanes: 1, assFixedDuration: 1000,
    assPreventOverlap: false
  });
  assert.deepEqual(settings, {
    assAutoMotion: true, assScrollSpeed: 180, assEntryOffset: 320,
    assScrollLanes: 6, assFixedDuration: 10,
    assPreventOverlap: false
  });
  assert.equal(normalizeAssMotion({ assScrollSpeed: "invalid" }).assScrollSpeed, 360);
  assert.equal(normalizeAssMotion({ assScrollLanes: 9.6 }).assScrollLanes, 10);
});

test("manual and automatic ASS export apply motion settings and the UI exposes editable controls", () => {
  assert.match(main, /\.\.\.normalizeAssMotion\(getMonitorSettings\(\)\)/);
  assert.match(main, /\.\.\.normalizeAssMotion\(options\)/);
  assert.match(main, /\.\.\.normalizeAssMotion\(stored\)/);
  assert.match(main, /\.\.\.normalizeAssMotion\(candidate\)/);
  assert.match(renderer, /api\.exportAss\(\{ ngRegex: byId\("ass-ng-regex"\)\.value, \.\.\.readAssMotionInputs\("ass-"\) \}\)/);
  assert.match(renderer, /api\.saveMonitorSettings\(readAssMotionInputs\("ass-"\)\)/);
  assert.match(renderer, /settings\.assAutoMotion = byId\(prefix \+ "auto-motion"\)\.checked/);
  assert.match(renderer, /input\.disabled = autoEnabled/);
  assert.match(html, /id="ass-auto-motion" checked/);
  assert.match(html, /id="setting-ass-auto-motion" checked/);
  for (const prefix of ["ass-", "setting-ass-"]) {
    for (const id of ["scroll-speed", "entry-offset", "scroll-lanes", "fixed-duration", "prevent-overlap"]) {
      assert.ok(html.includes('id="' + prefix + id + '"'), "missing ASS motion control " + prefix + id);
    }
  }
});
