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

test("failed periodic AI refresh keeps last good LIVE article while updating statistics", () => {
  const { preserveLastGoodLiveArticle } = require("../electron/article-evidence.cjs");
  const previous = {
    status: "generated", liveStatus: "live", aiProvider: "Ollama",
    aiModel: "qwen2.5:3b", generatedAt: "2026-11-19T00:00:00Z",
    title: "完成した見出し", paragraphs: ["前回の放送内容に基づく正常な本文です。"],
    aiSections: [{ heading: "概要", body: "前回の分析結果", source: "comments" }],
    aiGenerationStatus: "complete", aiEvidence: { commentCount: 10 },
    aiCommentSampleCount: 10, aiCommentTotalCount: 10
  };
  const current = {
    status: "generated", liveStatus: "live", aiGenerationStatus: "fallback",
    aiFallbackReason: "Ollama通信失敗", generatedAt: "2026-11-19T00:01:00Z",
    commentCount: 25, paragraphs: ["簡易記事が前回の本文を上書きする予定でした。"]
  };
  const merged = preserveLastGoodLiveArticle(current, previous);
  assert.equal(merged.title, "完成した見出し");
  assert.deepEqual(merged.paragraphs, previous.paragraphs);
  assert.equal(merged.commentCount, 25);
  assert.equal(merged.aiGenerationStatus, "stale");
  assert.equal(merged.aiFallbackReason, "Ollama通信失敗");
  assert.equal(merged.aiLastSuccessfulAt, "2026-11-19T00:00:00Z");
  assert.ok(merged.aiQualityNotes[0].includes("前回成功"));
  assert.equal(current.paragraphs[0], "簡易記事が前回の本文を上書きする予定でした。");
  // Do not reuse a live present-tense narrative after the stream has ended.
  assert.equal(preserveLastGoodLiveArticle({ ...current, liveStatus: "ended" }, previous).aiGenerationStatus, "fallback");
  assert.equal(preserveLastGoodLiveArticle(current, { ...previous, aiProvider: "" }).aiGenerationStatus, "fallback");
});

test("exported AI article explains unavailable sources and older live snapshots", () => {
  const { renderArticleHtml } = require("../electron/article-export.cjs");
  const html = renderArticleHtml({
    title: "テスト記事",
    aiProvider: "Ollama",
    aiGenerationStatus: "stale",
    aiEvidence: { commentCount: 70, sampleCount: 20 },
    aiSourceCoverage: { video: "unavailable", audio: "transcribed" },
    aiQualityNotes: ["前回の本文です。<注意>"]
  });
  assert.match(html, /記事の根拠・取得状況/);
  assert.match(html, /70件中20件を抜粋/);
  assert.match(html, /音声：文字起こしあり/);
  assert.ok(!html.includes("<注意>"));
  assert.ok(html.includes("&lt;注意&gt;"));
});
