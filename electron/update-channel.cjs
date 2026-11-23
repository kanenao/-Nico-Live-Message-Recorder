"use strict";
const BETA_CHANNEL = "beta";
const PRODUCT_CHANNEL = "latest";
function normalizeUpdateChannel(value) {
  return value === BETA_CHANNEL || value === PRODUCT_CHANNEL ? value : null;
}
function hasBetaOrigin(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.originEdition === "beta" && record.betaReturnEligible === true) return true;
  // Legacy beta.138-140 used the channel file without an origin key.
  // Its opt-in transition to product saved channel=latest and updatedAt.
  return !record.originEdition && record.channel === PRODUCT_CHANNEL &&
    typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt));
}
function canSwitchUpdateChannel(edition, record) {
  return edition === "beta" || (edition === "product" && hasBetaOrigin(record));
}
function getEffectiveUpdateChannel(edition, preference, record) {
  if (edition === "product" && !hasBetaOrigin(record)) return PRODUCT_CHANNEL;
  return normalizeUpdateChannel(preference) || (edition === "product" ? PRODUCT_CHANNEL : BETA_CHANNEL);
}
function markBetaOrigin(record) {
  const previous = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  return { ...previous, originEdition: "beta", betaReturnEligible: true,
    channel: normalizeUpdateChannel(previous.channel) || BETA_CHANNEL,
    updatedAt: new Date().toISOString() };
}
module.exports = { BETA_CHANNEL, PRODUCT_CHANNEL, normalizeUpdateChannel,
  hasBetaOrigin, canSwitchUpdateChannel, getEffectiveUpdateChannel, markBetaOrigin };
