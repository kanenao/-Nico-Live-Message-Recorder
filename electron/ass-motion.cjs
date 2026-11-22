"use strict";

// Manual values remain available when automatic Nico-style placement is off.
const ASS_MOTION_DEFAULTS = Object.freeze({
  assAutoMotion: true,
  assScrollSpeed: 360,
  assEntryOffset: 0,
  assScrollLanes: 18,
  assFixedDuration: 5,
  assPreventOverlap: true
});

// Spread sparse traffic vertically rather than repeatedly using the first row.
// The same physical rows are reused as more lanes become necessary.
const AUTO_ASS_LANE_ORDER = Object.freeze([8, 6, 10, 4, 12, 7, 9, 5, 11, 13, 3, 14, 2, 15, 1, 16, 0, 17]);

function boundedNumber(value, fallback, minimum, maximum, integer = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(maximum, Math.max(minimum, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function normalizeAssMotion(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  return {
    assAutoMotion: input.assAutoMotion !== false,
    assScrollSpeed: boundedNumber(input.assScrollSpeed, ASS_MOTION_DEFAULTS.assScrollSpeed, 180, 720, true),
    assEntryOffset: boundedNumber(input.assEntryOffset, ASS_MOTION_DEFAULTS.assEntryOffset, 0, 320, true),
    assScrollLanes: boundedNumber(input.assScrollLanes, ASS_MOTION_DEFAULTS.assScrollLanes, 6, 18, true),
    assFixedDuration: boundedNumber(input.assFixedDuration, ASS_MOTION_DEFAULTS.assFixedDuration, 3, 10),
    assPreventOverlap: input.assPreventOverlap !== false
  };
}

function calculateAssHeadwayMs(textWidth, speed, gapPixels = 48) {
  return Math.ceil((Math.max(1, textWidth) + Math.max(0, gapPixels)) / speed * 1000);
}

// Inspired by Nico's roughly five-second crossing and width-dependent speed.
// The comment begins at the visible right edge, never in a hidden waiting
// region. A busy five-second window shortens crossing time modestly.
function calculateAutomaticAssMotion(textWidth, recentCount, screenWidth = 1920) {
  const width = Math.max(1, Number(textWidth) || 1);
  const screen = Math.max(320, Number(screenWidth) || 1920);
  const traffic = Math.min(60, Math.max(1, Math.floor(Number(recentCount) || 1)));
  const duration = Math.max(4.0, 5.2 - Math.min(1.2, Math.max(0, traffic - 2) * 0.09));
  return {
    entryX: screen,
    speed: Math.round((screen + width) / duration),
    duration,
    laneCount: Math.min(18, Math.max(6, 6 + Math.floor(traffic * 0.8)))
  };
}

// Do not only check whether the previous comment's tail has entered the
// screen. A faster following comment might otherwise catch that tail halfway
// across. Check clearance both at entry and when the old comment exits.
function calculateAutomaticAssSafeStart(previous, requestedStart, entryX, speed, gapPixels = 48) {
  const requested = Math.max(0, Number(requestedStart) || 0);
  if (!previous) return requested;
  const prevSpeed = Math.max(1, previous.speed);
  const gap = Math.max(0, gapPixels);
  const clearanceAtEntry = previous.start +
    (previous.entryX + previous.width - entryX + gap) / prevSpeed;
  let safe = Math.max(requested, clearanceAtEntry);
  if (speed > prevSpeed) {
    const previousExit = previous.start + (previous.entryX + previous.width) / prevSpeed;
    safe = Math.max(safe, previousExit - (entryX - gap) / speed);
  }
  return safe;
}

function reserveAutomaticAssLane(lanes, laneIndices, requestedStart, width, speed, entryX, sequence = 0) {
  if (!Array.isArray(lanes) || !Array.isArray(laneIndices) || !laneIndices.length) {
    throw new TypeError("ASSコメントの自動配置行がありません。");
  }
  let winner = null;
  for (let i = 0; i < laneIndices.length; i += 1) {
    const index = laneIndices[(sequence + i) % laneIndices.length];
    const start = calculateAutomaticAssSafeStart(lanes[index], requestedStart, entryX, speed);
    if (!winner || start < winner.start - 1e-8) winner = { index, start };
  }
  lanes[winner.index] = { start: winner.start, entryX, width, speed };
  return winner;
}

module.exports = {
  ASS_MOTION_DEFAULTS, AUTO_ASS_LANE_ORDER,
  normalizeAssMotion, calculateAssHeadwayMs,
  calculateAutomaticAssMotion, calculateAutomaticAssSafeStart, reserveAutomaticAssLane
};
