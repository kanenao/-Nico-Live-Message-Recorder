"use strict";

// All settings are stored as user preferences and are also used by one-off
// ASS conversions before the preferences have been saved.
const ASS_MOTION_DEFAULTS = Object.freeze({
  assScrollSpeed: 360,       // pixels/second, measured across the whole line
  assEntryOffset: 0,        // pixels outside the right edge at event start
  assScrollLanes: 18,
  assFixedDuration: 5,      // seconds for ue/shita fixed comments
  assPreventOverlap: true
});

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
    assScrollSpeed: boundedNumber(input.assScrollSpeed, ASS_MOTION_DEFAULTS.assScrollSpeed, 180, 720, true),
    assEntryOffset: boundedNumber(input.assEntryOffset, ASS_MOTION_DEFAULTS.assEntryOffset, 0, 320, true),
    assScrollLanes: boundedNumber(input.assScrollLanes, ASS_MOTION_DEFAULTS.assScrollLanes, 6, 18, true),
    assFixedDuration: boundedNumber(input.assFixedDuration, ASS_MOTION_DEFAULTS.assFixedDuration, 3, 10),
    assPreventOverlap: input.assPreventOverlap !== false
  };
}

// A new comment may start as soon as the previous comment's trailing edge
// has passed the entry point. No need to wait for an entire screen crossing.
function calculateAssHeadwayMs(textWidth, speed, gapPixels = 48) {
  return Math.ceil((Math.max(1, textWidth) + Math.max(0, gapPixels)) / speed * 1000);
}

module.exports = { ASS_MOTION_DEFAULTS, normalizeAssMotion, calculateAssHeadwayMs };
