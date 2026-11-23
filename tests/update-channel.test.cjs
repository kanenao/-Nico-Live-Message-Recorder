"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasBetaOrigin, canSwitchUpdateChannel, getEffectiveUpdateChannel, markBetaOrigin } = require("../electron/update-channel.cjs");
test("native product installation cannot access beta channel", () => {
  assert.equal(canSwitchUpdateChannel("product", null), false);
  assert.equal(getEffectiveUpdateChannel("product", "beta", null), "latest");
  assert.equal(hasBetaOrigin({ channel:"beta" }), false);
});
test("beta origin marker survives switching between product and beta", () => {
  const original = markBetaOrigin(null);
  assert.equal(canSwitchUpdateChannel("product", original), true);
  assert.equal(getEffectiveUpdateChannel("product", "beta", original), "beta");
  assert.equal(getEffectiveUpdateChannel("product", "latest", original), "latest");
});
test("legacy beta opt-in to product remains eligible", () => {
  const migrated = { channel:"latest", updatedAt:"2026-11-23T00:00:00.000Z" };
  assert.equal(hasBetaOrigin(migrated), true);
  assert.equal(canSwitchUpdateChannel("product", migrated), true);
  assert.equal(hasBetaOrigin({ channel:"latest" }), false);
  assert.equal(hasBetaOrigin({ channel:"latest", updatedAt:"invalid" }), false);
});
