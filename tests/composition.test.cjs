"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCommentTimeline, timestampMs, reserveLane, calculateCommentLaneLayout, calculateScrollCommentHeadway, normalizeCommentDisplayText } = require("../composition.js");

test("aligns comments to videoStart rather than sessionStart", () => {
  const result = prepareCommentTimeline([
    { type: "sessionStart", sessionStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:03.000Z", content: "before video" },
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:05.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:06.250Z", content: "during video" }
  ], 10000);

  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].timeMs, 1250);
});

test("limits the timeline to video duration and videoStop", () => {
  const result = prepareCommentTimeline([
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:01.000Z", content: "inside" },
    { type: "videoStop", videoStoppedAt: "2026-11-11T00:00:05.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:08.000Z", content: "after stop" }
  ], 9000);

  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].text, "inside");
});

test("preserves display commands and accepts mail arrays", () => {
  const result = prepareCommentTimeline([
    { type: "videoStart", videoStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:00:01.000Z", content: "pink big", mail: ["ue", "big", "red"] }
  ], 5000);

  assert.equal(result.comments[0].mail, "ue big red");
});

test("supports older logs without recording markers by falling back to first comment", () => {
  const result = prepareCommentTimeline([
    { type: "comment", timestamp: "2026-11-11T00:00:01.000Z", content: "first" },
    { type: "comment", timestamp: "2026-11-11T00:00:02.000Z", content: "second" }
  ], 5000);
  assert.equal(result.comments[0].timeMs, 0);
  assert.equal(result.comments[1].timeMs, 1000);
});

test("uses first comment when session marker exists but video marker is absent", () => {
  const result = prepareCommentTimeline([
    { type: "sessionStart", sessionStartedAt: "2026-11-11T00:00:00.000Z" },
    { type: "comment", timestamp: "2026-11-11T00:03:00.000Z", content: "first captured comment" },
    { type: "comment", timestamp: "2026-11-11T00:03:02.000Z", content: "second" }
  ], 10000);
  assert.equal(result.usedFallbackOrigin, true);
  assert.equal(result.comments[0].timeMs, 0);
  assert.equal(result.comments[1].timeMs, 2000);
});

test("parses second and millisecond timestamps", () => {
  assert.equal(timestampMs(1794355200), 1794355200000);
  assert.equal(timestampMs(1794355200000), 1794355200000);
});


test("defers a comment until its selected lane becomes free", () => {
  const lanes = [5000, 12000, 8000];
  const reservation = reserveLane(lanes, 2000, 4000, 200);
  assert.equal(reservation.lane, 0);
  assert.equal(reservation.startMs, 5000);
  assert.equal(reservation.endMs, 9000);
  assert.equal(lanes[0], 9200);
});

test("keeps comments in the same lane from overlapping", () => {
  const lanes = [0, 0];
  const first = reserveLane(lanes, 1000, 6000, 250);
  const second = reserveLane(lanes, 2000, 6000, 250);
  assert.notEqual(first.lane, second.lane);
  const third = reserveLane(lanes, 3000, 6000, 250);
  assert.ok(third.startMs >= 7250);
  assert.ok(third.startMs >= first.startMs + 6250);
});


test("calculates separate comment bands with spacing for maximum font size and outline", () => {
  const layout = calculateCommentLaneLayout({
    height: 1080,
    baseFontSize: 42,
    outlineWidth: 6,
    marginPercent: 7,
    rowLimit: 12
  });
  assert.equal(layout.fixedLaneCount, 2);
  assert.ok(layout.lineHeight >= Math.ceil(51 * 1.22 + 12 + 8));
  assert.ok(layout.scrollLaneYs[0] > layout.topLaneYs[0]);
  assert.ok(layout.scrollLaneYs.at(-1) < layout.bottomLaneYs[0]);
});

test("scales comment bands to output resolution and respects the requested scroll row limit", () => {
  const layout = calculateCommentLaneLayout({
    height: 720,
    baseFontSize: 40,
    outlineWidth: 4,
    marginPercent: 7,
    rowLimit: 3
  });
  assert.equal(layout.fixedLaneCount, 2);
  assert.ok(layout.scrollLaneCount <= 3);
  assert.ok(layout.topLaneYs[0] < layout.scrollLaneYs[0]);
  assert.ok(layout.scrollLaneYs.at(-1) < layout.bottomLaneYs[0]);
});


test("uses comment tail clearance instead of the full screen transit time", () => {
  const durationMs = 6545; // roughly 330 px/s across 1920px plus 240px of text
  const headwayMs = calculateScrollCommentHeadway(1920, 240, durationMs);
  assert.ok(headwayMs > 700 && headwayMs < 800);
  assert.ok(headwayMs < durationMs / 5);
});

test("spreads scrolling rows through the video while fixed comments stay at the edges", () => {
  const layout = calculateCommentLaneLayout({
    height: 1080,
    baseFontSize: 64,
    outlineWidth: 4,
    marginPercent: 7,
    rowLimit: 12
  });
  assert.ok(layout.scrollLaneCount >= 7);
  assert.ok(layout.scrollLaneYs[0] > layout.edge);
  assert.ok(layout.scrollLaneYs.at(-1) < 1080 - layout.edge);
  assert.ok(layout.topLaneYs[0] < layout.scrollLaneYs[0]);
  assert.ok(layout.bottomLaneYs[0] > layout.scrollLaneYs.at(-1));
});


test("allocates two fixed comment rows above and below the scrolling region", () => {
  const layout = calculateCommentLaneLayout({
    height: 1080, baseFontSize: 64, outlineWidth: 5, marginPercent: 7, rowLimit: 12
  });
  assert.equal(layout.fixedLaneCount, 2);
  assert.equal(layout.topLaneYs.length, 2);
  assert.equal(layout.bottomLaneYs.length, 2);
  assert.ok(layout.topLaneYs[0] < layout.topLaneYs[1]);
  assert.ok(layout.topLaneYs[1] < layout.scrollLaneYs[0]);
  assert.ok(layout.bottomLaneYs[0] > layout.scrollLaneYs.at(-1));
  assert.ok(layout.bottomLaneYs[0] > layout.bottomLaneYs[1]);
});

test("normalizes multiline and control-character comments for one-line display", () => {
  assert.equal(normalizeCommentDisplayText("  こんにちは\\r\\n世界\\t  \u0001 "), "こんにちは 世界");
  assert.equal(normalizeCommentDisplayText("  "), "");
});
