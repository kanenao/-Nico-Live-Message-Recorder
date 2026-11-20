"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateArticleWithOllama } = require("../electron/ollama.cjs");

test("22K-token context overflow followed by token-repeat abort recovers with a tiny text article", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, opts) => {
    const req = JSON.parse(opts.body);
    requests.push(req);
    if (requests.length === 1) return {
      ok: false, status: 400,
      json: async () => ({ error: "request (22044 tokens) exceeds the available context size (8192 tokens), try increasing it" })
    };
    if (requests.length === 2) return {
      ok: false, status: 500,
      json: async () => ({ error: "prediction aborted, token repeat limit reached" })
    };
    return { ok: true, json: async () => ({
      done: true, done_reason: "stop",
      message: { content: JSON.stringify({
        title: "収集した情報による配信記事",
        summary: "放送記録の範囲で整理しました。",
        paragraphs: ["保存コメントと音声認識の抜粋を根拠にまとめました。"]
      }) }
    }) };
  };
  try {
    const records = Array.from({ length: 450 }, (_, i) => ({
      type: "comment",
      content: "長いコメント" + i + "「" + "あ".repeat(140) + "」",
      timestamp: "2026-11-20T12:00:00Z"
    }));
    const images = Array.from({ length: 8 }, (_, i) => ({
      image: "base64-frame-" + i, capturedAt: "00:" + String(i).padStart(2, "0") + ":00"
    }));
    const output = await generateArticleWithOllama({
      model: "qwen2.5vl:3b",
      context: { liveUpdate: true, programTitle: "配信タイトル" },
      records, images,
      audioTranscript: "長い音声文字起こし".repeat(3000)
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].options.num_ctx, 8192);
    assert.ok(requests[0].options.num_predict < 1700);
    assert.ok(requests[0].messages[1].content.length < 7000, "initial prompt is bounded");
    assert.equal(requests[0].messages[1].images.length, 1);
    assert.equal(requests[1].messages[1].images.length, 1);
    assert.equal(requests[2].messages[1].images, undefined);
    assert.ok(requests[1].messages[1].content.length < requests[0].messages[1].content.length);
    assert.ok(requests[2].messages[1].content.length < requests[1].messages[1].content.length);
    assert.ok(requests[1].options.repeat_penalty > requests[0].options.repeat_penalty);
    assert.equal(output.title, "収集した情報による配信記事");
    assert.equal(output.commentTotalCount, 450);
    assert.equal(output.commentSampleCount, 24);
    assert.equal(output.usedImages, false);
    assert.equal(output.compactRetry, true);
    assert.equal(output.sourceCoverage.video, "sampled");
    assert.equal(records.length, 450, "saved comments stay untouched");
    assert.equal(images.length, 8, "captured frames stay untouched");
  } finally {
    global.fetch = originalFetch;
  }
});

test("text-only generation recovers after a repetition-limit error with a shorter retry", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, opts) => {
    requests.push(JSON.parse(opts.body));
    if (requests.length === 1) return {
      ok: false, status: 500,
      json: async () => ({ error: "prediction aborted, token repeat limit reached" })
    };
    return { ok: true, json: async () => ({
      done_reason: "stop",
      message: { content: JSON.stringify({
        title: "コメント主体の放送記事",
        paragraphs: ["視聴者のコメントから確認できる範囲をまとめました。"]
      }) }
    }) };
  };
  try {
    const result = await generateArticleWithOllama({
      model: "qwen2.5:3b",
      records: [{ type: "comment", content: "うぽつ" }],
      context: { programTitle: "配信" }
    });
    assert.equal(requests.length, 2);
    assert.ok(requests[0].messages[1].content.length > requests[1].messages[1].content.length);
    assert.equal(requests[0].messages[1].images, undefined);
    assert.equal(requests[1].messages[1].images, undefined);
    assert.equal(result.title, "コメント主体の放送記事");
    assert.equal(result.compactRetry, true);
  } finally {
    global.fetch = originalFetch;
  }
});
