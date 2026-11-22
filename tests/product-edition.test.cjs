"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const buildWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "nicolive-recorder-build.yml"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "nicolive-recorder-release.yml"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

test("product edition uses a stable version and the latest update channel", () => {
  assert.equal(pkg.nicoEdition, "product");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.build.win.publish[0].channel, "latest");
  assert.equal(pkg.build.win.publish[0].releaseType, "release");
});

test("product UI hides broadcast journal and Ollama controls", () => {
  assert.match(html, /<body data-edition="product">/);
  assert.match(html, /id="ollama-settings-section"/);
  assert.match(css, /body\[data-edition="product"\] #articles-panel/);
  assert.match(css, /body\[data-edition="product"\] #ollama-settings-section/);
  assert.match(css, /body\[data-edition="product"\] #articles-nav-button/);
});

test("renderer does not load or expose the beta-only article page in product edition", () => {
  assert.match(renderer, /const PRODUCT_EDITION = document\.body\.dataset\.edition === "product"/);
  assert.match(renderer, /if \(PRODUCT_EDITION\) return;/);
  assert.match(renderer, /if \(!PRODUCT_EDITION\) APP_PAGES\.add\("articles"\)/);
  assert.match(renderer, /if \(!PRODUCT_EDITION\) \{[\s\S]*api\.getBroadcastArticles\(\)/);
});

test("main process prevents article generation, live AI capture and Ollama IPC in product edition", () => {
  assert.match(main, /const PRODUCT_EDITION = require\("\.\.\/package\.json"\)\.nicoEdition === "product"/);
  assert.match(main, /if \(PRODUCT_EDITION\) return \{ status: "skipped"/);
  assert.match(main, /if \(PRODUCT_EDITION\) throw new Error\("製品版では放送記事・無料AI記事生成は利用できません/);
  const articleAt = main.indexOf('ipcMain.handle("articles:delete"');
  const articleGate = main.lastIndexOf("if (!PRODUCT_EDITION) {", articleAt);
  const ollamaAt = main.indexOf('ipcMain.handle("ollama:get-status"');
  const ollamaGate = main.lastIndexOf("if (!PRODUCT_EDITION) {", ollamaAt);
  assert.ok(articleGate > 0 && articleGate < articleAt, "article IPC handlers must be edition-gated");
  assert.ok(ollamaGate > 0 && ollamaGate < ollamaAt, "Ollama IPC handlers must be edition-gated");
  assert.match(main, /const savedArticles = PRODUCT_EDITION \? \[\] : listBroadcastArticles\(\)\.items/);
});

test("product build and release workflows validate stable latest-channel metadata", () => {
  assert.match(buildWorkflow, /Verify product update manifest and installer checksum/);
  assert.match(buildWorkflow, /node scripts\/verify-update-manifest\.cjs/);
  assert.match(releaseWorkflow, /stable X\.Y\.Z versions/);
  assert.match(releaseWorkflow, /latest\.yml/);
  assert.match(changelog, /^## 1\.0\.0/m);
});
