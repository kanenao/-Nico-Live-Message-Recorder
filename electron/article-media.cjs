"use strict";

const path = require("node:path");
const { recordingStem } = require("./article-thumbnail.cjs");

function findMatchingCommentLog(videoPath, items = []) {
  const base = recordingStem(videoPath);
  if (!base) return "";
  const eligible = (Array.isArray(items) ? items : []).map(item => ({
    path: typeof item === "string" ? item : item && item.path,
    broadcaster: typeof item === "string" ? "" : String(item && item.broadcaster || "")
  })).filter(item => typeof item.path === "string" && path.extname(item.path).toLowerCase() === ".jsonl");
  const folder = path.basename(path.dirname(videoPath)).toLowerCase();
  const exact = eligible.filter(item => recordingStem(item.path) === base)
    .filter(item => !item.broadcaster || item.broadcaster.toLowerCase() === folder);
  if (exact.length === 1) return exact[0].path;
  if (exact.length > 1) return "";
  // A timestamped recording is a specific session. Never silently attach a
  // different recording of the same lv ID just because it is the only log.
  if (/^lv\d{5,}_\d{8}_\d{6}/.test(base)) return "";
  // Archives with a renamed video may still have one unambiguous comment log.
  const match = base.match(/^(lv\d{5,})(?:_|$)/);
  if (!match) return "";
  const byId = eligible.filter(item => recordingStem(item.path).startsWith(match[1] + "_"))
    .filter(item => !item.broadcaster || item.broadcaster.toLowerCase() === folder);
  return byId.length === 1 ? byId[0].path : "";
}

function selectLiveArticleFrameHistory(frames, limit = 16) {
  const history = (Array.isArray(frames) ? frames : []).slice();
  if (history.length <= limit) return history;
  const first = Math.min(2, Math.floor(limit / 4));
  const last = Math.min(5, Math.floor(limit / 3));
  // Remove the least informative interval. Preserving the oldest frames and
  // a recent tail avoids turning long live broadcasts into only last minutes.
  const timeAt = index => {
    const date = Date.parse(history[index] && history[index].capturedAt || "");
    return Number.isFinite(date) ? date : index * 15000;
  };
  while (history.length > limit) {
    let drop = first;
    let bestGap = Infinity;
    for (let index = first; index < history.length - last; index++) {
      const gap = Math.max(timeAt(index) - timeAt(index - 1),
        timeAt(index + 1) - timeAt(index));
      if (gap < bestGap) { bestGap = gap; drop = index; }
    }
    history.splice(drop, 1);
  }
  return history;
}

function buildLiveArticleFfmpegArgs(frameDirectory, audioDirectory, audioEnabled, frameSeconds = 15, segmentSeconds = 25) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-map", "0:v:0", "-vf", "fps=1/" + frameSeconds + ",scale=640:-2",
    "-q:v", "7", "-f", "image2", path.join(frameDirectory, "frame-%06d.jpg")
  ];
  if (audioEnabled) args.push(
    "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-f", "segment", "-segment_time", String(segmentSeconds),
    "-reset_timestamps", "1", "-segment_format", "wav",
    path.join(audioDirectory, "audio-%05d.wav")
  );
  return args;
}

module.exports = { findMatchingCommentLog, selectLiveArticleFrameHistory, buildLiveArticleFfmpegArgs };
