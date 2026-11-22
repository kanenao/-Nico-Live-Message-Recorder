const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUserSessionInput } = require("../electron/nico-session.cjs");

test("normalizes a raw Niconico user_session cookie value", () => {
  assert.equal(normalizeUserSessionInput("user_session_token_123"), "user_session_token_123");
});

test("accepts a copied user_session=name-value pair", () => {
  assert.equal(normalizeUserSessionInput("user_session=abc_def-123"), "abc_def-123");
});

test("empty input means remove the manually configured cookie", () => {
  assert.equal(normalizeUserSessionInput(""), "");
  assert.equal(normalizeUserSessionInput("   "), "");
});

test("rejects cookie separators and whitespace to prevent malformed cookie injection", () => {
  for (const value of ["abc; other=value", "abc,other", "abc def", "abc\\nInjected: yes"]) {
    assert.throws(() => normalizeUserSessionInput(value), /空白・改行・セミコロン・カンマ/);
  }
});

test("rejects oversized session values", () => {
  assert.throws(() => normalizeUserSessionInput("x".repeat(4097)), /4096文字以内/);
});

test("manual root-domain session wins over older host-only session cookies", () => {
  const { getNicoUserSession } = require("../electron/nico-cookies.cjs");
  const cookies = [
    { name: "user_session", value: "old_token", domain: "www.nicovideo.jp" },
    { name: "user_session", value: "new_token", domain: ".nicovideo.jp" },
  ];
  assert.equal(getNicoUserSession(cookies), "new_token");
});
