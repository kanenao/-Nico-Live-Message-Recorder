"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCommentTimeline, timestampMs, reserveLane } = require("../composition.js");

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
