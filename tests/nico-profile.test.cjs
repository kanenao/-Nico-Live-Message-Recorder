"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeProfileUserId, extractNicoUserId, nicoUserPageUrl,
  normalizeIconUrl, extractProfileImageUrl, extractApiProfileIcon, fetchNicoProfileIcon
} = require("../electron/nico-profile.cjs");

const cdn = "https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/s/123/12345678.jpg";

test("user IDs come only from numeric IDs, valid Nico URLs and recorded folder suffixes", () => {
  assert.equal(normalizeProfileUserId("12345678"), "12345678");
  assert.equal(normalizeProfileUserId("https://www.nicovideo.jp/user/12345678"), "12345678");
  assert.equal(normalizeProfileUserId("https://www.nicovideo.jp/user/12345678/"), "12345678");
  assert.equal(normalizeProfileUserId("https://evil.example/user/12345678"), "");
  assert.equal(normalizeProfileUserId("12345/../../evil"), "");
  assert.equal(normalizeProfileUserId("ユーザー12345678"), "");
  assert.equal(extractNicoUserId("配信者_12345678"), "12345678");
  assert.equal(extractNicoUserId("IDなしの配信者"), "");
  assert.equal(nicoUserPageUrl("12345678"), "https://www.nicovideo.jp/user/12345678");
  assert.equal(nicoUserPageUrl("javascript:alert(1)"), "");
});

test("profile icons accept only the trusted Nico image CDN", () => {
  assert.equal(normalizeIconUrl(cdn), cdn);
  assert.equal(normalizeIconUrl("https://attacker.example/avatar.png"), "");
  assert.equal(normalizeIconUrl("https://nimg.jp.attacker.example/icon.jpg"), "");
  assert.equal(normalizeIconUrl("http://secure-dcdn.cdn.nimg.jp/avatar.jpg"), "");
  assert.equal(normalizeIconUrl("https://user:password@secure-dcdn.cdn.nimg.jp/icon.jpg"), "");
  assert.equal(extractApiProfileIcon({ data: { user: { icons: { large: cdn } } } }), cdn);
  assert.equal(extractApiProfileIcon({ data: { user: { icons: { large: "https://bad.example/icon.jpg", small: cdn } } } }), cdn);
});

test("public Nico user API is preferred for the avatar", async () => {
  const calls = [];
  const image = await fetchNicoProfileIcon("12345678", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: { user: { icons: { large: cdn } } } }) };
  });
  assert.equal(image, cdn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nvapi.nicovideo.jp/v1/users/12345678");
  assert.equal(calls[0].options.headers["X-Frontend-Id"], "6");
});

test("API failures may use the Nico page user icon fallback, never arbitrary OGP images", async () => {
  const html = '<meta property="og:image" content="' + cdn + '">';
  const calls = [];
  const result = await fetchNicoProfileIcon("12345678", async url => {
    calls.push(url);
    return url.includes("nvapi.") ? { ok: false } : { ok: true, text: async () => html };
  });
  assert.equal(result, cdn);
  assert.equal(calls.length, 2);
  assert.equal(extractProfileImageUrl('<meta property="og:image" content="https://nicovideo.cdn.nimg.jp/thumbnails/1.jpg">'), "");
  assert.equal(extractProfileImageUrl('<meta content="' + cdn + '" property="og:image">'), cdn);
});

test("bad IDs do not make any network request", async () => {
  let calls = 0;
  assert.equal(await fetchNicoProfileIcon("javascript:abc", async () => { calls++; }), "");
  assert.equal(calls, 0);
});

test("recording library offers clickable profiles and manual ID mapping for legacy folders", () => {
  const root = path.join(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(main, /ipcMain\.handle\("library:open-user-profile"/);
  assert.match(main, /ipcMain\.handle\("library:set-profile-user-id"/);
  assert.match(main, /getMonitorSettings\(\)\.targets/);
  assert.match(main, /listBroadcastArticles\(\)\.items/);
  assert.match(main, /mapWithConcurrency\(\[\.\.\.knownIds\], 4/);
  assert.match(preload, /openNicoUserProfile/);
  assert.match(preload, /setLibraryProfileUserId/);
  assert.match(renderer, /const profileUserId = broadcasterItems\.find/);
  assert.match(renderer, /api\.openNicoUserProfile\(profileUserId\)/);
  assert.match(renderer, /api\.setLibraryProfileUserId\(broadcaster, input\.value\.trim\(\)\)/);
  assert.match(css, /\.library-profile-id-form\[hidden\] \{ display:none; \}/);
});
