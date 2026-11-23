"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUpdateChannel, hasBetaOrigin, getEffectiveUpdateChannel,
  markBetaOrigin, canSwitchUpdateChannel } = require("../electron/update-channel.cjs");
test("beta builds always retain beta and product channel choice", () => {
  assert.equal(canSwitchUpdateChannel("beta", null), true);
  assert.equal(getEffectiveUpdateChannel("beta", "beta"), "beta");
  assert.equal(getEffectiveUpdateChannel("beta", "latest"), "latest");
});
test("native product cannot enter beta but beta-origin product can return", () => {
  assert.equal(canSwitchUpdateChannel("product", null), false);
  assert.equal(getEffectiveUpdateChannel("product", "beta", null), "latest");
  const recorded = markBetaOrigin(null);
  assert.equal(canSwitchUpdateChannel("product", recorded), true);
  assert.equal(getEffectiveUpdateChannel("product", "beta", recorded), "beta");
});
test("previous beta-to-product transition is treated as beta origin", () => {
  const previous = { channel:"latest", updatedAt:"2026-11-23T00:00:00Z" };
  assert.equal(hasBetaOrigin(previous), true);
  assert.equal(hasBetaOrigin({ channel:"latest" }), false);
  assert.equal(markBetaOrigin(previous).betaReturnEligible, true);
  assert.equal(normalizeUpdateChannel("alpha"), null);
});
