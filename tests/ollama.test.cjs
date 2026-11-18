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

test("incomplete model output is retried once with the original comments", async (t) => {
  const { generateArticleWithOllama } = require("../electron/ollama.cjs");
  const bodies = [];
  const reply = t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const data = bodies.length === 1
      ? { done_reason: "length", message: { content: '{"title":"速報"}' } }
      : { message: { content: JSON.stringify({ sections: [{ heading: "視聴者の反応", body: "会場への質問が届いた。" }] }) } };
    return { ok: true, json: async () => data };
  });
  const article = await generateArticleWithOllama({ records: [{ type: "comment", content: "会場はどこ？" }] });
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages[1].content, /会場はどこ？/);
  assert.equal(article.summary, "会場への質問が届いた。");
  assert.equal(article.commentTotalCount, 1);
  reply.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ message: { content: '{"title":"速報"}' } }) }));
  await assert.rejects(generateArticleWithOllama(), /記事本文/);
  assert.equal(reply.mock.callCount(), 4);
});
