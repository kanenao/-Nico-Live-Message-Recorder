const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("version update page includes legible status, both versions, search and actions", () => {
  for (const id of ["app-current-version", "settings-latest-version", "settings-update-badge",
    "settings-update-overview", "settings-update-headline", "settings-update-next-action",
    "settings-update-checked-at", "settings-update-progress-label",
    "settings-check-update-button", "settings-install-update-button",
    "open-github-releases-button", "release-history-search", "release-history-count",
    "release-history-more-button"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(css, /\.version-update-page \[hidden\] \{ display: none !important; \}/);
  assert.match(renderer, /latestVersionRow\.hidden = false/);
  assert.equal((renderer.match(/byId\("settings-check-update-button"\)\.addEventListener\("click"/g) || []).length, 1);
  assert.equal((renderer.match(/byId\("settings-install-update-button"\)\.addEventListener\("click"/g) || []).length, 1);
});

test("all update states give a readable next action", () => {
  const start = renderer.indexOf("function getUpdateStatusGuide(state) {");
  const end = renderer.indexOf("\nfunction renderUpdateState(payload) {", start);
  assert.ok(start >= 0 && end > start);
  const guide = vm.runInNewContext(renderer.slice(start, end) + "\ngetUpdateStatusGuide");
  for (const state of ["checking", "available", "retrying", "progress", "downloaded",
    "not-available", "unsupported", "error"]) {
    const entry = guide(state);
    assert.ok(entry.title && entry.action, state);
  }
  assert.match(guide("error").title, /失敗/);
  assert.match(guide("unsupported").title, /自動更新できません/);
  assert.match(guide("not-available").title, /最新/);
  assert.match(guide("downloaded").action, /再起動して更新/);
});

test("changelog is expandable, searchable and safely rendered", () => {
  assert.match(renderer, /matches\.slice\(0, 5\)/);
  assert.match(renderer, /document\.createElement\("details"\)/);
  assert.match(renderer, /document\.createElement\("summary"\)/);
  assert.match(renderer, /document\.createTextNode\(text\)/);
  assert.doesNotMatch(renderer.slice(renderer.indexOf("function appendFormattedReleaseNote"),
    renderer.indexOf("function renderVisibleReleaseHistory")), /innerHTML\s*=/);
  const start = renderer.indexOf("function parseReleaseHistory(markdown) {");
  const end = renderer.indexOf("\nfunction appendFormattedReleaseNote", start);
  const parse = vm.runInNewContext(renderer.slice(start, end) + "\nparseReleaseHistory");
  const entries = parse("## 0.8.2-alpha.131\n- **画面改善**：検索\n## 0.8.1-alpha.130\n- 旧版");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "0.8.2-alpha.131");
  assert.equal(entries[0].notes.length, 1);
});
