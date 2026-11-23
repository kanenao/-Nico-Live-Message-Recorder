"use strict";

const BETA_CHANNEL = "beta";
const PRODUCT_CHANNEL = "latest";

function normalizeUpdateChannel(value) {
  return value === BETA_CHANNEL || value === PRODUCT_CHANNEL ? value : null;
}

function getEffectiveUpdateChannel(edition, preference) {
  if (edition === "product") return PRODUCT_CHANNEL;
  return normalizeUpdateChannel(preference) || BETA_CHANNEL;
}

function canSwitchUpdateChannel(edition) {
  return edition !== "product";
}

module.exports = {
  BETA_CHANNEL,
  PRODUCT_CHANNEL,
  normalizeUpdateChannel,
  getEffectiveUpdateChannel,
  canSwitchUpdateChannel
};
