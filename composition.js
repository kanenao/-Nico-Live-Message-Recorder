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
    let origin =
      timestampMs(videoStart && (videoStart.videoStartedAt || videoStart.timestamp)) ??
      timestampMs(sessionStart && (sessionStart.sessionStartedAt || sessionStart.timestamp));

    if (origin === null) {
      const firstCommentTime = records
        .filter((record) => record && record.type === "comment")
        .map((record) => timestampMs(record.timestamp) ?? timestampMs(record.receivedAt))
        .filter((value) => value !== null)
        .sort((a, b) => a - b)[0];
      origin = firstCommentTime ?? null;
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
      usedFallbackOrigin: !videoStart && !sessionStart,
      comments
    };
  }

  return { timestampMs, prepareCommentTimeline };
});
