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
    "settings-update-checked-at", "settings-update-progress-label", "settings-update-error-help",
    "settings-check-update-button", "settings-install-update-button",
    "open-github-releases-button", "release-history-search", "release-history-count",
    "release-history-more-button"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(css, /\.version-update-page \[hidden\] \{ display: none !important; \}/);
  assert.match(renderer, /latestVersionRow\.hidden = false/);
  assert.match(renderer, /settings-update-error-help"\)\.hidden = payload\.state !== "error"/);
  assert.match(renderer, /payload\.code \? "（"/);
  assert.match(renderer, /payload\.category === "integrity"/);
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
  assert.match(renderer, /安全確認に失敗したため再ダウンロードは停止しました/);
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


test("public beta and stable versions have separate Kick-style cards and release histories", () => {
  for (const id of ["edition-release-manager", "edition-release-refresh", "edition-beta-card",
    "edition-stable-card", "edition-beta-version", "edition-stable-version",
    "edition-beta-download", "edition-stable-download", "edition-beta-history",
    "edition-stable-history", "edition-beta-count", "edition-stable-count",
    "edition-beta-latest-notes", "edition-stable-latest-notes"]) {
    assert.ok(html.includes('id="' + id + '"'), "Missing public edition UI: " + id);
  }
  assert.match(html, /β版のバージョン更新履歴/);
  assert.match(html, /製品版のバージョン更新履歴/);
  assert.match(html, /製品版からβ版へのアプリ内切り替えはできません/);
  assert.match(renderer, /async function refreshEditionReleaseHistory\(force = false\)/);
  assert.match(renderer, /async function openPublicEditionInstaller\(edition\)/);
  assert.match(renderer, /if \(activePage === "updates"\) void refreshEditionReleaseHistory\(\)/);
  assert.match(renderer, /new Date\(editionReleaseCheckedAt\)\.toLocaleString\("ja-JP"\)/);
  assert.match(css, /\.edition-choice-card/);
  assert.match(css, /\.edition-public-item/);
});

test("GitHub public release notes are rendered as text, never HTML, and failures do not fake a published release", () => {
  const start = renderer.indexOf("function appendEditionReleaseNotes(");
  const end = renderer.indexOf("async function refreshUpdateChannelSettings()", start);
  const section = renderer.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(section, /\.innerHTML\s*=/);
  assert.match(section, /appendFormattedReleaseNote\(item, bullet\[1\]\)/);
  assert.match(section, /editionReleaseState = \{ beta: \[\], stable: \[\] \}/);
  assert.match(section, /公開状況を確認できませんでした/);
  assert.match(section, /button\.disabled = !latest/);
});
