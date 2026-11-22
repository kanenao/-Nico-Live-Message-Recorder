"use strict";

// The account API is the same session-verification endpoint used by the unofficial
// niconicojs auth client. A cookie in storage is not proof of a valid login.
const ME_URL = "https://account.nicovideo.jp/api/public/v2/user.json";
const { normalizeUserSessionInput } = require("./nico-session.cjs");

function status(state, extra = {}) {
  return { state, loggedIn: state === "valid", hasSession: state !== "missing",
    checkedAt: new Date().toISOString(), ...extra };
}

async function verifyNicoSession(sessionValue, fetchImpl = globalThis.fetch, timeoutMs = 12000) {
  const cookie = normalizeUserSessionInput(sessionValue);
  if (!cookie) return status("missing");
  if (typeof fetchImpl !== "function") return status("unknown");
  try {
    const response = await fetchImpl(ME_URL, {
      method: "GET",
      redirect: "manual",
      headers: { "Accept": "application/json", "Cookie": "user_session=" + cookie,
        "X-Frontend-Id": "6", "X-Frontend-Version": "0" },
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 12000))
    });
    if (!response) return status("unknown");
    if (response.status === 401 || response.status === 403) return status("expired");
    if (response.status >= 300 && response.status < 400) {
      const destination = String(response.headers && response.headers.get("location") || "");
      return /(?:account\.nicovideo\.jp\/login|\/login(?:\?|$))/i.test(destination)
        ? status("expired") : status("unknown");
    }
    if (response.status !== 200 || typeof response.json !== "function") return status("unknown");
    const body = await response.json();
    const account = body && body.data;
    if (body && body.meta && body.meta.status === 401) return status("expired");
    const userId = String(account && account.userId || "");
    if (!/^\d{1,20}$/.test(userId) || !Number.isSafeInteger(Number(userId)) || Number(userId) < 1) {
      return status("unknown");
    }
    const nickname = String(account.nickname || "").slice(0, 80);
    return status("valid", { userId, nickname });
  } catch (_) {
    // Never echo HTTP error objects; they may contain signed URLs or request headers.
    return status("unknown");
  }
}

module.exports = { ME_URL, verifyNicoSession };
