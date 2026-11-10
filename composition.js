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
    const origin =
      timestampMs(videoStart && (videoStart.videoStartedAt || videoStart.timestamp)) ??
      timestampMs(sessionStart && (sessionStart.sessionStartedAt || sessionStart.timestamp));

    if (origin === null) {
      throw new Error("録画開始時刻がコメントログにありません。β2以前のログは録画開始時刻を基準にできないため、コメントの先頭時刻を使用します。");
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
          timeMs: Math.max(0, entry.absoluteMs - origin),
          text: String(entry.record.content || ""),
          userName: String(entry.record.userName || ""),
          mail,
          isHistory: Boolean(entry.record.isHistory)
        };
      })
      .filter((comment) => comment.timeMs <= maxDuration + 250)
      .sort((a, b) => a.timeMs - b.timeMs);

    return {
      originMs: origin,
      durationMs: Number.isFinite(maxDuration) ? maxDuration : null,
      comments
    };
  }

  return { timestampMs, prepareCommentTimeline };
});
