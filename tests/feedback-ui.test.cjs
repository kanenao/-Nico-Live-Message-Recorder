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
test("app feedback page exists and requires explicit in-app submission", () => {
  const root = path.join(__dirname,"..");
  const html = fs.readFileSync(path.join(root,"index.html"),"utf8");
  const renderer = fs.readFileSync(path.join(root,"renderer.js"),"utf8");
  const main = fs.readFileSync(path.join(root,"electron","main.cjs"),"utf8");
  const preload = fs.readFileSync(path.join(root,"electron","preload.cjs"),"utf8");
  for (const kind of ["bug","feature"]) {
    for (const suffix of ["panel","details","count","button","note","nav-button"])
      assert.match(html,new RegExp('id="feedback-'+kind+'-'+suffix+'"'));
    assert.match(html,new RegExp('data-page-target="feedback-'+kind+'"'));
    assert.match(html,new RegExp('data-page="feedback-'+kind+'"'));
  }
  assert.doesNotMatch(html,/id="feedback-details"/);
  assert.match(renderer,/"feedback-bug", "feedback-feature"/);
  assert.match(renderer,/api\.openFeedback\(kind, details\)/);
  assert.match(preload,/openFeedback:/);
  assert.match(main,/ipcMain\.handle\("app:open-feedback"/);
  assert.match(main,/submitFeedback\(/);
  assert.match(html,/公開GitHub Issuesに掲載/);
});

test("separate feedback drafts and submission statuses are independent",async()=>{
  const vm=require("node:vm");
  const renderer=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const code=renderer.slice(renderer.indexOf("function feedbackForm("),renderer.indexOf('for(const kind of ["bug","feature"])',renderer.indexOf("function feedbackForm(")));
  const elements={};const calls=[];
  for(const kind of ["bug","feature"]){
    elements["feedback-"+kind+"-details"]={value:kind+" draft"};
    elements["feedback-"+kind+"-button"]={dataset:{}};
    elements["feedback-"+kind+"-count"]={};
    elements["feedback-"+kind+"-note"]={textContent:"initial"};
  }
  const fn=vm.runInNewContext(code+"\n({open:openFeedbackReport,update:updateFeedbackForm});",{byId:id=>elements[id],api:{openFeedback:async(...args)=>{calls.push(args);return {number:42}}},showToast:()=>{}});
  await fn.open("bug");
  assert.deepEqual(calls,[["bug","bug draft"]]);
  assert.equal(elements["feedback-bug-details"].value,"");
  assert.match(elements["feedback-bug-note"].textContent,/#42/);
  assert.equal(elements["feedback-feature-note"].textContent,"initial");
  assert.equal(elements["feedback-feature-details"].value,"feature draft");
  await fn.open("feature");
  assert.deepEqual(calls[1],["feature","feature draft"]);
  elements["feedback-bug-details"].value="   ";
  fn.update("bug");assert.equal(elements["feedback-bug-button"].disabled,true);
  assert.equal(elements["feedback-feature-button"].disabled,true);
  await fn.open("invalid");assert.equal(calls.length,2);
});
