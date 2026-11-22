const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { safeRecordingBroadcasterName, recordingDateTime, recordingFileStem,
  chooseUniqueRecordingStem } = require("../electron/recording-filenames.cjs");

const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

test("Nico broadcast start time uses JST in both video and comment filenames", () => {
  const startedAt = "2026-11-16T16:05:09.000Z";
  assert.equal(recordingDateTime(startedAt), "20261117_010509");
  assert.equal(recordingFileStem("配信者さん", startedAt), "配信者さん_20261117_010509");
  assert.equal(recordingFileStem("配信者さん", startedAt) + ".mp4", "配信者さん_20261117_010509.mp4");
  assert.equal(recordingFileStem("配信者さん", startedAt) + ".jsonl", "配信者さん_20261117_010509.jsonl");
  assert.equal(recordingDateTime(1794845109), "20261117_010509");
  assert.equal(recordingDateTime(1794845109000), "20261117_010509");
});

test("Nico broadcast time falls back to recording start when program start cannot be fetched", () => {
  const fallback = new Date("2026-11-17T00:00:07Z");
  assert.equal(recordingFileStem("配信者", "", fallback), "配信者_20261117_090007");
  assert.equal(recordingFileStem("配信者", "not-a-time", fallback), "配信者_20261117_090007");
});

test("sanitize unsafe Windows filename characters, reserved names and trailing dots", () => {
  assert.equal(safeRecordingBroadcasterName('A/B:<C>?"*\\|'), "A_B__C______");
  assert.equal(safeRecordingBroadcasterName("CON"), "_CON");
  assert.equal(safeRecordingBroadcasterName("配信者.  "), "配信者");
  assert.equal(safeRecordingBroadcasterName(""), "配信者名未取得");
  assert.ok(recordingFileStem("A/B", "2026-11-16T16:00:00Z").startsWith("A_B_"));
});

test("simultaneous and repeated recordings never silently overwrite existing videos or comments", () => {
  const directories = ["C:/videos", "C:/comments", "C:/articles"];
  const busy = new Set(["C:/videos/配信者_20261117_010500.mp4",
    "C:/comments/配信者_20261117_010500_2.jsonl"]);
  assert.equal(chooseUniqueRecordingStem("配信者_20261117_010500", directories,
    candidate => busy.has(candidate.replace(/\\/g, "/"))), "配信者_20261117_010500_3");
  assert.equal(chooseUniqueRecordingStem("配信者_20261117_010501", directories,
    candidate => busy.has(candidate.replace(/\\/g, "/"))), "配信者_20261117_010501");
});

test("comment writer renames only after closure and keeps article references synchronized", () => {
  assert.match(main, /await finishCommentWriter\(writer\)/);
  assert.match(main, /await moveCommentLogToBroadcasterFolder\(oldPath\)/);
  assert.match(main, /relocateArticleForRenamedComment\(oldPath, commentFilePath\)/);
  assert.match(main, /async function finalizeStreamlinkRecording\(/);
  assert.match(main, /resolvedRecordingStem\(streamlinkLiveId/);
  assert.match(main, /rememberRecordedVideo\(finalPath/);
  assert.match(main, /recordingNamingSession\.liveId === liveId/);
  assert.match(main, /startedAt: page\.beginAt \|\| ""/);
  assert.match(main, /commentLogLiveId\(item\.path\)/);
  assert.match(main, /savedIndex\[recordingRelativeKey\(item\.path\)\]/);
});
