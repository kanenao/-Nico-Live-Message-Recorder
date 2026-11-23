const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BETA_CHANNEL,
  PRODUCT_CHANNEL,
  normalizeUpdateChannel,
  getEffectiveUpdateChannel,
  canSwitchUpdateChannel
} = require("../electron/update-channel.cjs");

test("beta edition can select beta or stable product update channels", () => {
  assert.equal(canSwitchUpdateChannel("beta"), true);
  assert.equal(getEffectiveUpdateChannel("beta", BETA_CHANNEL), BETA_CHANNEL);
  assert.equal(getEffectiveUpdateChannel("beta", PRODUCT_CHANNEL), PRODUCT_CHANNEL);
});

test("product edition is permanently locked to the stable update channel", () => {
  assert.equal(canSwitchUpdateChannel("product"), false);
  assert.equal(getEffectiveUpdateChannel("product", BETA_CHANNEL), PRODUCT_CHANNEL);
  assert.equal(getEffectiveUpdateChannel("product", PRODUCT_CHANNEL), PRODUCT_CHANNEL);
});

test("invalid channel preferences safely fall back to beta for beta builds", () => {
  assert.equal(normalizeUpdateChannel("alpha"), null);
  assert.equal(normalizeUpdateChannel(""), null);
  assert.equal(getEffectiveUpdateChannel("beta", "invalid"), BETA_CHANNEL);
});
