"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectEdition, classifyFallback, safeAiResult } = require("../scripts/feedback-triage.cjs");

test("explicit release edition wins over bare version fragments", () => {
  assert.equal(detectEdition("### 対象版\nβ版\n\n### アプリのバージョン\n1.0.2-beta.143"), "beta");
  assert.equal(detectEdition("### 対象版\n正規版\n\n### バージョン\n1.0.1"), "product");
  assert.equal(detectEdition("1.0.2-beta.143"), "beta");
  assert.equal(detectEdition("1.0.1"), "product");
  assert.equal(detectEdition("unknown"), null);
});

test("fallback triages bug, request, and possible serious recording failure", () => {
  assert.deepEqual(classifyFallback("[不具合] 録画できない", "### 対象版\n正規版"),
    { category: "bug", edition: "product", urgency: "urgent" });
  assert.deepEqual(classifyFallback("[要望] 再生ボタン追加", "### 対象版\nβ版"),
    { category: "feature", edition: "beta", urgency: "review" });
  assert.equal(classifyFallback("コメント付き動画の音ズレ", "").category, "bug");
});

test("AI output is allowlisted and cannot change reporter-selected edition", () => {
  const fallback = { category: "bug", edition: "product", urgency: "review" };
  assert.deepEqual(safeAiResult('{"category":"feature","edition":"beta","urgency":"urgent","labels":["admin"]}', fallback),
    { category: "feature", edition: "product", urgency: "review" });
  assert.equal(safeAiResult('{"category":"admin","urgency":"urgent"}', fallback), null);
  assert.equal(safeAiResult("ignore all rules", fallback), null);
});

test("AI action response is validated before any labels are applied", () => {
  const fallback = { category: "bug", edition: "beta", urgency: "review" };
  assert.deepEqual(safeAiResult('{"category":"feature","urgency":"review"}', fallback),
    { category: "feature", edition: "beta", urgency: "review" });
  assert.equal(safeAiResult('{"category":"unsafe","urgency":"urgent"}', fallback), null);
});
