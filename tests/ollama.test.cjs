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


test("truncated Ollama output is retried with a smaller complete Japanese article", async () => {
  const { generateArticleWithOllama } = require("../electron/ollama.cjs");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return {
      ok: true,
      json: async () => requests.length === 1
        ? { done_reason: "length", message: { content: '{"title":"未完成"' } }
        : { done_reason: "stop", message: { content: JSON.stringify({
            title: "復元された記事",
            paragraphs: ["視聴者のコメントから確認できた情報を紹介します。", "放送全体の流れはコメントに基づいて整理しました。"]
          }) } }
    };
  };
  try {
    const output = await generateArticleWithOllama({
      context: { liveId: "lv123456", programTitle: "放送のタイトル" },
      records: [{ type: "comment", content: "復元対象のコメント", timestamp: "2026-11-18T12:00:00Z" }],
      images: [{ image: "base64-test-frame", capturedAt: "00:00:05" }],
      model: "qwen2.5vl:3b"
    });
    assert.equal(requests.length, 2);
    assert.equal(output.compactRetry, true);
    assert.equal(output.usedImages, true);
    assert.equal(output.sourceCoverage.video, "analyzed");
    assert.ok(output.qualityNotes.some(note => note.includes("映像解析を維持")));
    assert.equal(output.commentTotalCount, 1);
    assert.equal(output.title, "復元された記事");
    assert.ok(output.summary.includes("コメント"));
    assert.equal(output.paragraphs.length, 2);
    assert.ok(requests[0].messages[1].images?.length);
    assert.equal(requests[1].messages[1].images.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});


test("vision retry failure saves a text article but never claims the images were analyzed", async () => {
  const { generateArticleWithOllama } = require("../electron/ollama.cjs");
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const done = requests.length === 3;
    return { ok: true, json: async () => done
      ? { done_reason: "stop", message: { content: JSON.stringify({
          title: "音声とコメントで再生成", paragraphs: ["確認できたコメントからの記事です。"]
        }) } }
      : { done_reason: "length", message: { content: "{\"title\":\"途中で切れた\"" } } };
  };
  try {
    const article = await generateArticleWithOllama({
      model: "qwen2.5vl:3b",
      images: [{ image: "frame1", capturedAt: "00:00:05" },
        { image: "frame2", capturedAt: "00:01:05" }],
      records: [{ type: "comment", content: "参考にするコメント" }]
    });
    assert.equal(requests.length, 3);
    assert.ok(requests[0].messages[1].images.length > 0);
    assert.ok(requests[1].messages[1].images.length > 0);
    assert.equal(requests[2].messages[1].images, undefined);
    assert.equal(article.usedImages, false);
    assert.equal(article.compactRetry, true);
    assert.equal(article.sourceCoverage.video, "sampled");
    assert.ok(article.qualityNotes.some(note => note.includes("画像AI解析が完了しませんでした")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("available video frames without an installed vision model are explicitly distinguished", async () => {
  const { generateArticleWithOllama } = require("../electron/ollama.cjs");
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, json: async () => ({ done_reason: "stop", message: { content: JSON.stringify({
      title: "コメント記事", paragraphs: ["録画映像は未解析です。"]
    }) } })
  });
  try {
    const article = await generateArticleWithOllama({
      model: "qwen2.5:3b", availableFrameCount: 4, visionModelMissing: true,
      records: [{ type: "comment", content: "映像確認" }]
    });
    assert.equal(article.sourceCoverage.video, "sampled");
    assert.equal(article.usedImages, false);
    assert.ok(article.qualityNotes.some(note => note.includes("qwen2.5vl:3b")));
    assert.equal(article.compactRetry, false);
  } finally {
    global.fetch = originalFetch;
  }
});
