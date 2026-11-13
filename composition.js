"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.nicoCommentComposition = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  function timestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1000000000000 ? value * 1000 : value;
    }
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function prepareCommentTimeline(records, videoDurationMs) {
    if (!Array.isArray(records)) throw new TypeError("コメントログの形式が正しくありません。");

    const videoStart = records.find((record) => record && record.type === "videoStart");
    const sessionStart = records.find((record) => record && record.type === "sessionStart");
    const videoStop = records.find((record) => record && record.type === "videoStop");
    const timeshiftOrigin = records.find((record) => record && record.type === "timeshiftOrigin");
    let origin = timestampMs(videoStart && videoStart.videoOriginAt) ??
      timestampMs(timeshiftOrigin && timeshiftOrigin.originAt) ??
      timestampMs(videoStart && (videoStart.videoStartedAt || videoStart.timestamp));

    if (origin === null) {
      const firstCommentTime = records
        .filter((record) => record && record.type === "comment")
        .map((record) => timestampMs(record.timestamp) ?? timestampMs(record.receivedAt))
        .filter((value) => value !== null)
        .sort((a, b) => a - b)[0];
      origin = firstCommentTime ?? timestampMs(sessionStart && (sessionStart.sessionStartedAt || sessionStart.timestamp));
    }
    if (origin === null) {
      throw new Error("コメントの日時を読み取れませんでした。");
    }

    const stopAt = timestampMs(videoStop && (videoStop.videoStoppedAt || videoStop.timestamp));
    let maxDuration = Number.isFinite(videoDurationMs) && videoDurationMs > 0
      ? videoDurationMs
      : Number.POSITIVE_INFINITY;
    if (stopAt !== null && stopAt >= origin) {
      maxDuration = Math.min(maxDuration, stopAt - origin);
    }

    const comments = records
      .filter((record) => record && record.type === "comment" && String(record.content || "").trim())
      .map((record) => ({
        record,
        absoluteMs: timestampMs(record.timestamp) ?? timestampMs(record.receivedAt)
      }))
      .filter((entry) => entry.absoluteMs !== null)
      .map((entry) => {
        const mail = Array.isArray(entry.record.mail)
          ? entry.record.mail.join(" ")
          : String(entry.record.mail || "");
        return {
          relativeMs: entry.absoluteMs - origin,
          timeMs: Math.max(0, entry.absoluteMs - origin),
          text: String(entry.record.content || ""),
          userName: String(entry.record.userName || ""),
          mail,
          isHistory: Boolean(entry.record.isHistory)
        };
      })
      .filter((comment) => comment.relativeMs >= -250 && comment.relativeMs <= maxDuration + 250)
      .map(({ relativeMs, ...comment }) => comment)
      .sort((a, b) => a.timeMs - b.timeMs);

    return {
      originMs: origin,
      durationMs: Number.isFinite(maxDuration) ? maxDuration : null,
      usedFallbackOrigin: !videoStart,
      comments
    };
  }


  // Calculate safe vertical rows for large comments and keep fixed comments near the edges.
  function calculateCommentLaneLayout(options = {}) {
    const height = Math.max(120, Number(options.height) || 1080);
    const baseFontSize = Math.max(12, Math.min(110, Number(options.baseFontSize) || 64));
    const outlineWidth = Math.max(0, Math.min(12, Number(options.outlineWidth) || 0));
    const marginPercent = Math.max(4, Math.min(25, Number(options.marginPercent) || 7));
    const rowLimit = Math.max(1, Math.min(24, Math.floor(Number(options.rowLimit) || 12)));
    const edge = Math.round(height * marginPercent / 100);
    const maximumCommentFont = Math.min(120, Math.max(10, Math.round(baseFontSize * 1.22)));
    const lineHeight = Math.max(24, Math.ceil(maximumCommentFont * 1.22 + outlineWidth * 2 + 8));

    // Keep two fixed-comment rows at the top and bottom. The reserved band
    // includes a line-height margin so large comments do not touch scrolling rows.
    const fixedLaneCount = 2;
    const fixedBandHeight = Math.max(lineHeight * (fixedLaneCount + 1), Math.round(height * 0.22));
    const scrollTop = Math.max(edge, fixedBandHeight);
    const scrollBottom = Math.min(height - edge, height - fixedBandHeight);
    const usableScrollHeight = Math.max(lineHeight, scrollBottom - scrollTop);
    const availableScrollRows = Math.max(1, Math.floor(usableScrollHeight / lineHeight));
    const scrollLaneCount = Math.max(1, Math.min(rowLimit, availableScrollRows));
    const occupiedHeight = scrollLaneCount * lineHeight;
    const verticalOffset = Math.max(0, Math.floor((usableScrollHeight - occupiedHeight) / 2));
    const topLaneYs = Array.from({ length: fixedLaneCount }, (_, lane) =>
      Math.round(fixedBandHeight * (lane + 1) / (fixedLaneCount + 1)));
    const bottomLaneYs = topLaneYs.map(y => height - y);
    const scrollLaneYs = Array.from({ length: scrollLaneCount }, (_, lane) =>
      scrollTop + verticalOffset + Math.round(lineHeight / 2) + lane * lineHeight);

    return {
      edge,
      lineHeight,
      fixedLaneCount,
      scrollLaneCount,
      topLaneYs,
      bottomLaneYs,
      scrollLaneYs
    };
  }

  // Reserve a lane without allowing a new comment to overlap the previous one.
  // When every lane is occupied, defer the comment to the earliest free lane.
  function reserveLane(lanes, requestedStartMs, durationMs, gapMs) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new TypeError("コメントレーンがありません。");
    }
    let lane = 0;
    for (let index = 1; index < lanes.length; index += 1) {
      if (lanes[index] < lanes[lane]) lane = index;
    }
    const duration = Math.max(0, Number(durationMs) || 0);
    const gap = Math.max(0, Number(gapMs) || 0);
    const startMs = Math.max(Number(requestedStartMs) || 0, lanes[lane] || 0);
    lanes[lane] = startMs + duration + gap;
    return { lane, startMs, endMs: startMs + duration };
  }

  // Time needed for a previous comment's tail to clear the right edge.
  // It is much shorter than the full screen-crossing duration, so the next
  // comment can keep its timestamp without colliding in the same lane.
  function calculateScrollCommentHeadway(screenWidth, textWidth, durationMs) {
    const width = Math.max(1, Number(screenWidth) || 1);
    const text = Math.max(1, Number(textWidth) || 1);
    const duration = Math.max(1, Number(durationMs) || 1);
    const pixelsPerSecond = (width + text) / (duration / 1000);
    return Math.max(1, Math.ceil((text / pixelsPerSecond) * 1000));
  }

  function normalizeCommentDisplayText(value) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return { timestampMs, prepareCommentTimeline, reserveLane, calculateCommentLaneLayout, calculateScrollCommentHeadway, normalizeCommentDisplayText };
});
