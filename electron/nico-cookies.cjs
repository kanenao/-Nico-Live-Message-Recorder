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
  // Prefer the shared .nicovideo.jp cookie set by the manual-session field.
  // Host-only cookies from prior browser logins may coexist in Chromium's jar.
  const matches = normalized.filter((item) => item.name === "user_session");
  const cookie = matches.find((item) => {
    const domain = String(item.domain || "").toLowerCase();
    return domain === ".nicovideo.jp" || domain === "nicovideo.jp";
  }) || matches[0];
  return cookie ? String(cookie.value || "") : "";
}

module.exports = { normalizeNicoCookies, getNicoUserSession };
