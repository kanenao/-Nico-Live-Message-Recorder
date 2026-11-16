const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseBroadcasterFromCommentLog, readBroadcasterFromCommentLog, verifiedProgramBroadcaster } = require("../electron/library-profile-resolution.cjs");

test("historical session metadata resolves the broadcaster ID, never a viewer comment ID", () => {
  const lines = [
    JSON.stringify({ type:"comment", userId:"99999999", userName:"あーちゃん", liveId:"lv123456789" }),
    JSON.stringify({ type:"sessionStart", liveId:"lv123456789", broadcasterName:"あーちゃん", broadcasterId:"" }),
    JSON.stringify({ type:"programMetadata", liveId:"lv123456789", broadcasterName:"あーちゃん", broadcasterId:"23456789" })
  ].join("\n");
  assert.equal(parseBroadcasterFromCommentLog(lines, "lv123456789", "あーちゃん"), "23456789");
  assert.equal(parseBroadcasterFromCommentLog(lines, "lv987654321", "あーちゃん"), "");
  assert.equal(parseBroadcasterFromCommentLog(lines, "lv123456789", "別人"), "");
});

test("a conflicting owner ID, malformed JSON or a channel ID is not assigned to a user", () => {
  const rows = [
    JSON.stringify({ type:"programMetadata", broadcasterName:"配信者", broadcasterId:"11111111" }),
    JSON.stringify({ type:"programMetadata", broadcasterName:"配信者", broadcasterId:"22222222" }),
    JSON.stringify({ type:"comment", broadcasterId:"33333333" }),
    "{broken"
  ].join("\n");
  assert.equal(parseBroadcasterFromCommentLog(rows, "", "配信者"), "");
  assert.equal(parseBroadcasterFromCommentLog(JSON.stringify({ type:"programMetadata", broadcasterId:"ch123456" })), "");
});

test("a bounded read also recovers metadata written near the end of large old comment logs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nico-library-id-"));
  const filename = path.join(dir, "lv123456789_test.jsonl");
  try {
    fs.writeFileSync(filename, JSON.stringify({ type:"comment", userId:"99999999" })+"\n"+
      " ".repeat(170000)+"\n"+JSON.stringify({type:"programMetadata",liveId:"lv123456789",broadcasterName:"あーちゃん",broadcasterId:"23456789"})+"\n");
    assert.equal(await readBroadcasterFromCommentLog(filename, "lv123456789", "あーちゃん"), "23456789");
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("public program data may be used only for an exact broadcaster name match", () => {
  assert.equal(verifiedProgramBroadcaster({broadcasterName:"あーちゃん",broadcasterId:"23456789"}, "あーちゃん"), "23456789");
  assert.equal(verifiedProgramBroadcaster({broadcasterName:"別人",broadcasterId:"23456789"}, "あーちゃん"), "");
  assert.equal(verifiedProgramBroadcaster({broadcasterName:"あーちゃん",broadcasterId:"ch1234"}, "あーちゃん"), "");
});
