"use strict";

const path = require("node:path");

const FILE_EXTENSIONS = [".ts", ".mp4", ".jsonl", ".csv", ".ass", ".json"];

function safeRecordingBroadcasterName(value) {
  let name = String(value || "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim()
    .slice(0, 56).replace(/[. ]+$/g, "");
  if (!name || /^\.+$/.test(name)) name = "配信者名未取得";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "_" + name;
  return name;
}

// Use the start of the broadcast (rather than the end of a long recording).
// Japanese broadcast times are always shown in JST even when Windows' timezone differs.
function recordingDateTime(value, fallback = new Date()) {
  let timestamp = value instanceof Date ? value : null;
  if (!timestamp) {
    const raw = String(value || "").trim();
    if (/^\d{10,13}$/.test(raw)) {
      const numeric = Number(raw);
      timestamp = new Date(raw.length === 10 ? numeric * 1000 : numeric);
    } else if (raw) {
      timestamp = new Date(raw);
    }
  }
  if (!timestamp || !Number.isFinite(timestamp.getTime())) {
    timestamp = fallback instanceof Date ? fallback : new Date(fallback);
  }
  if (!Number.isFinite(timestamp.getTime())) timestamp = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(timestamp).filter(item => item.type !== "literal").map(item => [item.type, item.value]));
  return parts.year + parts.month + parts.day + "_" + parts.hour + parts.minute + parts.second;
}

function recordingFileStem(name, startedAt, fallback = new Date()) {
  return safeRecordingBroadcasterName(name) + "_" + recordingDateTime(startedAt, fallback);
}

function chooseUniqueRecordingStem(preferred, directories = [], exists) {
  if (typeof exists !== "function") throw new TypeError("exists must be a function");
  for (let sequence = 1; sequence <= 10000; sequence += 1) {
    const stem = sequence === 1 ? preferred : preferred + "_" + sequence;
    const taken = directories.some(directory => FILE_EXTENSIONS.some(extension =>
      exists(path.join(directory, stem + extension))));
    if (!taken) return stem;
  }
  throw new Error("同じ配信日時のファイルが多すぎます。保存先を確認してください。");
}

module.exports = { safeRecordingBroadcasterName, recordingDateTime, recordingFileStem,
  chooseUniqueRecordingStem };
