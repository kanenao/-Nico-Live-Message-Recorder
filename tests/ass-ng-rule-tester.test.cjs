"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { testAssNgRegex, compileAssNgRegex } = require("../electron/ass-ng-regex.cjs");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("NG test identifies the original rule lines, including blank lines", () => {
  const result = testAssNgRegex("連投|荒らし\n\nhttps?://\\S+\n^NGコメント$", "連投 https://example.com");
  assert.equal(result.matched, true);
  assert.equal(result.ruleCount, 3);
  assert.deepEqual(result.matches, [
    { lineNumber: 1, pattern: "連投|荒らし" },
    { lineNumber: 3, pattern: "https?://\\S+" }
  ]);
});

test("NG test reports when a comment would remain in the generated ASS", () => {
  assert.deepEqual(testAssNgRegex("荒らし", "普通のコメント"), {
    matched: false, ruleCount: 1, matches: []
  });
  assert.deepEqual(testAssNgRegex("", "うぽつ"), {
    matched: false, ruleCount: 0, matches: []
  });
});

test("NG test follows manual converter's same flag, case and regex validation semantics", () => {
  assert.equal(testAssNgRegex("https?://\\S+", "HTTPS://example.com").matched, true);
  assert.equal(testAssNgRegex("/Spam/", "SPAM").matched, false);
  assert.equal(testAssNgRegex("/Spam/", "Spam").matched, true);
  assert.equal(testAssNgRegex("/Spam/i", "SPAM").matched, true);
  assert.equal(compileAssNgRegex("荒らし").length, 1);
  assert.throws(() => testAssNgRegex("正常\n[", "hello"), /2 行目/);
  assert.throws(() => testAssNgRegex("荒らし", " "), /入力してください/);
  assert.throws(() => testAssNgRegex("荒らし", "a".repeat(2001)), /2000文字/);
});

test("the preview IPC is read-only and exposes a verdict to the renderer", () => {
  assert.match(main, /ipcMain\.handle\("comments:test-ass-ng", \(_event, input = \{\}\) =>/);
  assert.match(main, /testAssNgRegex\(input && input\.ngRegex, input && input\.sample\)/);
  assert.match(preload, /testAssNgRegex: \(input\) => ipcRenderer\.invoke\("comments:test-ass-ng", input\)/);
  for (const id of ["ass-ng-test-comment", "test-ass-ng-button", "ass-ng-test-result"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing NG test control " + id);
  }
  assert.match(renderer, /api\.testAssNgRegex\(\{/);
  assert.match(renderer, /output\.dataset\.state = result\.matched \? "match" : "pass"/);
  assert.match(renderer, /match\.lineNumber/);
  assert.match(css, /\.ass-ng-test-result\[data-state="match"\]/);
  assert.match(css, /\.ass-ng-test-result\[data-state="error"\]/);
});
