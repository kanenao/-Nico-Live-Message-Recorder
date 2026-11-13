const test = require("node:test");
const assert = require("node:assert/strict");
const { selectRepresentativeComments, formatCommentTimestamp } = require("../electron/ollama.cjs");

test("representative comment sampling covers the beginning, middle, and end of a long broadcast", () => {
  const records = Array.from({ length: 540 }, (_, index) => ({
    type: "comment",
    content: "comment-" + index,
    timestamp: "2026-11-13T00:" + String(Math.floor(index / 60)).padStart(2, "0") + ":" + String(index % 60).padStart(2, "0") + "Z"
  }));
  const selected = selectRepresentativeComments(records, 180);
  assert.equal(selected.length, 180);
  assert.equal(selected[0].content, "comment-0");
  assert.equal(selected.at(-1).content, "comment-539");
  assert.ok(Number(selected[90].content.split("-")[1]) > 250);
  assert.ok(Number(selected[90].content.split("-")[1]) < 290);
});

test("comment timestamps normalize epoch seconds, milliseconds, and ISO strings", () => {
  assert.equal(formatCommentTimestamp(1794528000), new Date(1794528000 * 1000).toISOString());
  assert.equal(formatCommentTimestamp(1794528000000), new Date(1794528000000).toISOString());
  assert.equal(formatCommentTimestamp("2026-11-13T12:00:00Z"), "2026-11-13T12:00:00.000Z");
});
