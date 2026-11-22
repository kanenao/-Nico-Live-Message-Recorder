"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyNicoSession, ME_URL } = require("../electron/nico-auth-check.cjs");

test("only a server-confirmed account means successfully logged in", async () => {
  let requests = 0;
  const result = await verifyNicoSession("user_session_test", async (url, options) => {
    requests++;
    assert.equal(url, ME_URL);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Cookie, "user_session=user_session_test");
    return { status: 200, json: async () => ({ data: { userId: "23456789", nickname: "放送者" } }) };
  });
  assert.equal(requests, 1);
  assert.equal(result.state, "valid");
  assert.equal(result.loggedIn, true);
  assert.equal(result.userId, "23456789");
  assert.equal(result.nickname, "放送者");
  assert.ok(!JSON.stringify(result).includes("user_session_test"));
});

test("missing cookies, rejected cookies and login redirects are differentiated", async () => {
  const noCookie = await verifyNicoSession("", () => { throw new Error("should not call"); });
  assert.equal(noCookie.state, "missing");
  assert.equal(noCookie.hasSession, false);
  assert.equal((await verifyNicoSession("token", async () => ({ status: 401 }))).state, "expired");
  assert.equal((await verifyNicoSession("token", async () => ({ status: 403 }))).state, "expired");
  assert.equal((await verifyNicoSession("token", async () => ({ status: 302, headers: { get: () => "https://account.nicovideo.jp/login" } }))).state, "expired");
});

test("network failures and unexpected responses do not falsely indicate expiry or login", async () => {
  assert.equal((await verifyNicoSession("token", async () => { throw new Error("ECONNRESET token"); })).state, "unknown");
  assert.equal((await verifyNicoSession("token", async () => ({ status: 503 }))).state, "unknown");
  assert.equal((await verifyNicoSession("token", async () => ({ status: 200, json: async () => ({ data: {} }) }))).state, "unknown");
  assert.equal((await verifyNicoSession("token", async () => ({ status: 200, json: async () => ({ data: { userId: "NaN" } }) }))).state, "unknown");
});
