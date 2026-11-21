const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const html = fs.readFileSync(path.join(root,"index.html"),"utf8");
const css = fs.readFileSync(path.join(root,"styles.css"),"utf8");
const main = fs.readFileSync(path.join(root,"electron/main.cjs"),"utf8");
const generator = fs.readFileSync(path.join(root,"scripts/prepare-app-icon.ps1"),"utf8");

test("app icon source is present, readable and has a JPEG image signature", () => {
  const bytes = fs.readFileSync(path.join(root,"assets","app-icon.jpg"));
  assert.ok(bytes.length > 2500, "app icon should not be empty");
  assert.deepEqual(Array.from(bytes.subarray(0,2)), [0xff,0xd8]);
  assert.deepEqual(Array.from(bytes.subarray(-2)), [0xff,0xd9]);
});
test("Windows build generates and packages the new icon for shortcuts, NSIS and executable", () => {
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.equal(pkg.build.nsis.installerIcon, "build/icon.ico");
  assert.equal(pkg.build.nsis.uninstallerIcon, "build/icon.ico");
  assert.ok(pkg.build.files.includes("assets/**/*"));
  for (const key of ["dist:win", "dist:win:release","pack"]) {
    assert.match(pkg.scripts[key], /npm run prepare:icon && npm run prepare:streamlink/);
  }
  for (const size of [16, 24, 32, 48, 64, 128, 256]) assert.match(generator, new RegExp("\\b"+size+"\\b"));
  assert.match(generator, /Image\]::FromFile/);
  assert.match(generator, /System\.Drawing\.Imaging\.ImageFormat\]::Png/);
  assert.match(generator, /BinaryWriter/);
});
test("main window and visible app branding use the same icon", () => {
  assert.match(main, /const applicationIconPath = path\.join\(__dirname, "\.\.", "assets", "app-icon\.jpg"\)/);
  assert.match(main, /icon: applicationIconPath/);
  assert.match(html, /<div class="brand-icon"><img src="\.\/assets\/app-icon\.jpg"/);
  assert.match(html, /<link rel="icon" type="image\/jpeg" href="\.\/assets\/app-icon\.jpg">/);
  assert.match(css, /\.brand-icon img \{/);
});
