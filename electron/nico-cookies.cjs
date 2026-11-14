"use strict";

function normalizeNicoCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter((cookie) => {
    if (!cookie || !cookie.name || !cookie.value) return false;
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    return domain === "nicovideo.jp" || domain.endsWith(".nicovideo.jp");
  });
}

function getNicoUserSession(cookies) {
  const normalized = normalizeNicoCookies(cookies);
  const cookie = normalized.find((item) => item.name === "user_session");
  return cookie ? String(cookie.value || "") : "";
}

module.exports = { normalizeNicoCookies, getNicoUserSession };
