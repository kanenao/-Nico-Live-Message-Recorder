"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCommentEvidence, commentTime, summarizeEvidenceSources } = require("../electron/article-evidence.cjs");

test("AI evidence balances long broadcasts without changing original counts", () => {
  const records = Array.from({ length: 360 }, (_, index) => ({
    type: "comment", content: "展開-" + index,
    timestamp: new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + index * 1000).toISOString(),
    userId: String(index % 25)
  }));
  const evidence = prepareCommentEvidence(records, 36, 6);
  assert.equal(evidence.totalCount, 360);
  assert.equal(evidence.sampleCount, 36);
  assert.equal(evidence.timestampedCount, 360);
  assert.equal(evidence.uniqueCommenters, 25);
  assert.equal(evidence.segments.length, 6);
  assert.ok(evidence.segments.every(segment => segment.samples.length > 0));
  assert.ok(evidence.segments.at(0).samples.some(sample => sample.text === "展開-0"));
  assert.ok(evidence.segments.at(-1).samples.some(sample => sample.text.startsWith("展開-")));
  assert.equal(records.length, 360);
});

test("AI evidence omits repeated spam from prompt only, without losing totals", () => {
  const rows = [
    { type: "comment", content: "こんにちは", timestamp: 1795000000 },
    { type: "comment", content: "こんにちは", timestamp: 1795000001 },
    { type: "comment", content: "別の話題", timestamp: 1795000010 },
    { type: "gift", content: "情報ではない" }
  ];
  const evidence = prepareCommentEvidence(rows, 20, 1);
  assert.equal(evidence.totalCount, 3);
  assert.equal(evidence.sampleCount, 2);
  assert.equal(evidence.repeatedOmittedCount, 1);
  assert.equal(rows.length, 4);
});

test("AI evidence handles no timestamps and missing sources without invented events", () => {
  const evidence = prepareCommentEvidence([
    { type: "comment", content: "最初" },
    { type: "comment", content: "最後" }
  ], 8, 3);
  assert.equal(evidence.coverage, "record-order");
  assert.equal(evidence.timestampedCount, 0);
  assert.equal(evidence.sampleCount, 2);
  assert.equal(commentTime("bad"), null);
  assert.deepEqual(summarizeEvidenceSources({ commentCount: 2, compactRetry: true }),
    ["音声認識結果がありません", "映像AI解析結果がありません", "AI出力不完全のため、短縮本文に切り替えました"]);
});

test("Ollama prompt keeps all-count, phase comments, and source-availability notes", async () => {
  const { generateArticleWithOllama } = require("../electron/ollama.cjs");
  const originalFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ done_reason: "stop", message: { content: JSON.stringify({
      title: "配信のまとめ", summary: "配信中のコメントについて紹介します。",
      paragraphs: ["コメントの記録をもとに記事を作成しました。"]
    }) } }) };
  };
  try {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      type: "comment", content: "コメント-" + i, timestamp: 1795000000 + i
    }));
    const result = await generateArticleWithOllama({ records: rows,
      context: { programTitle: "記事品質テスト", liveUpdate: true } });
    assert.equal(result.commentTotalCount, 200);
    assert.equal(result.commentSampleCount, 96);
    assert.equal(result.evidence.sampleCount, 96);
    assert.equal(result.sourceCoverage.comments, "analyzed");
    assert.equal(result.sourceCoverage.video, "unavailable");
    assert.equal(result.sourceCoverage.audio, "unavailable");
    assert.ok(request.messages[1].content.includes("区間6"));
    assert.ok(request.messages[1].content.includes("保存コメント全200件"));
    assert.ok(request.messages[1].content.includes("配信中"));
    assert.ok(result.qualityNotes.some(item => item.includes("映像")));
  } finally { global.fetch = originalFetch; }
});
