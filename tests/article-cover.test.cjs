const test = require("node:test");
const assert = require("node:assert/strict");
const { selectArticleCoverImage, normalizeArticleCoverImage } = require("../electron/article-cover.cjs");

test("stores one bounded JPEG cover for live article previews", () => {
  const frame = Buffer.from("valid jpeg test data".repeat(40)).toString("base64");
  const result = selectArticleCoverImage([{ image: frame, capturedAt: "0:00:01" }]);
  assert.equal(result, "data:image/jpeg;base64," + frame);
  assert.equal(selectArticleCoverImage([], result), result);
});

test("selects last valid frame and never accepts external image URLs or oversized data", () => {
  const good = Buffer.from("live preview image".repeat(32)).toString("base64");
  assert.equal(selectArticleCoverImage([{ image: good }, { image: "https://evil.example/x.jpg" }]),
    "data:image/jpeg;base64," + good);
  assert.equal(normalizeArticleCoverImage("javascript:alert(1)"), "");
  assert.equal(normalizeArticleCoverImage("data:image/png;base64," + good), "");
  assert.equal(normalizeArticleCoverImage("a".repeat(420004)), "");
});
