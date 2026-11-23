"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFeedbackIssueUrl } = require("../electron/feedback-url.cjs");
const fs = require("node:fs");
const path = require("node:path");

test("feedback form pre-populates issue type, edition, version and details", () => {
  for (const edition of ["beta", "product"]) {
    for (const kind of ["bug", "feature"]) {
      const url = new URL(buildFeedbackIssueUrl({kind, edition, version: edition === "beta" ? "1.0.2-beta.144" : "1.0.1", details:"録画が失敗する"}));
      assert.equal(url.origin, "https://github.com");
      assert.equal(url.pathname, "/kanenao/-Nico-Live-Message-Recorder/issues/new");
      assert.equal(url.searchParams.get("template"), kind === "bug" ? "bug_report.yml" : "feature_request.yml");
      assert.equal(url.searchParams.get("edition"), edition === "beta" ? "β版" : "正規版");
      assert.equal(url.searchParams.get("details"), "録画が失敗する");
      assert.ok(url.searchParams.get("version"));
    }
  }
});
test("feedback URL cannot redirect or leak raw sessions and secrets", () => {
  const item = {kind:"bug",edition:"beta",version:"1.0.2-beta.144",details:"test"};
  assert.throws(() => buildFeedbackIssueUrl({...item,kind:"https://evil.example"}), TypeError);
  assert.throws(() => buildFeedbackIssueUrl({...item,details:"user_session=very-secret"}), TypeError);
  assert.throws(() => buildFeedbackIssueUrl({...item,details:""}), TypeError);
  assert.throws(() => buildFeedbackIssueUrl({...item,details:"x".repeat(501)}), TypeError);
  assert.throws(() => buildFeedbackIssueUrl({...item,version:"1.0.2#evil"}), TypeError);
});
test("app feedback page exists and is gated by explicit GitHub submission", () => {
  const root = path.join(__dirname,"..");
  const html = fs.readFileSync(path.join(root,"index.html"),"utf8");
  const renderer = fs.readFileSync(path.join(root,"renderer.js"),"utf8");
  const main = fs.readFileSync(path.join(root,"electron","main.cjs"),"utf8");
  const preload = fs.readFileSync(path.join(root,"electron","preload.cjs"),"utf8");
  for (const id of ["feedback-report-card","feedback-details","feedback-bug-button","feedback-feature-button"])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(renderer,/api\.openFeedback\(kind, details\)/);
  assert.match(preload,/openFeedback:/);
  assert.match(main,/ipcMain\.handle\("app:open-feedback"/);
  assert.match(main,/buildFeedbackIssueUrl\(/);
  assert.match(html,/GitHubで内容を確認して送信/);
});