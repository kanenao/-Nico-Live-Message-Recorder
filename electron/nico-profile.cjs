"use strict";

// ニコニコの公開ユーザーIDのみを扱い、推測したIDでは外部ページを開かない。
function normalizeProfileUserId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(?:https:\/\/(?:www\.)?nicovideo\.jp\/user\/)?(\d{5,})(?:\/)?$/i);
  return match ? match[1] : "";
}

function extractNicoUserId(folderName) {
  const match = String(folderName || "").match(/_(\d{5,})$/);
  return match ? match[1] : "";
}

function nicoUserPageUrl(userId) {
  const id = normalizeProfileUserId(userId);
  return id ? "https://www.nicovideo.jp/user/" + id : "";
}

function normalizeIconUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value.replace(/&amp;/g, "&").trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (url.hostname !== "nimg.jp" && !url.hostname.endsWith(".nimg.jp")) return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function extractProfileImageUrl(html) {
  const source = String(html || "");
  // ページのOGP画像はユーザーアイコンではないこともあるため、APIを優先する。
  const patterns = [
    /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["'][^>]*>/i,
    /<meta\b[^>]*\bname=["']twitter:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const url = normalizeIconUrl(match[1]);
      if (url && new URL(url).pathname.includes("usericon/")) return url;
    }
  }
  return "";
}

function extractApiProfileIcon(payload) {
  const user = payload && (payload.data?.user || payload.data || payload.user || payload);
  if (!user || typeof user !== "object") return "";
  const candidates = [
    user.icons?.large,
    user.icons?.small,
    user.icon?.large,
    user.icon?.small,
    user.iconUrl,
    user.iconURL,
    user.icon
  ];
  for (const candidate of candidates) {
    const url = normalizeIconUrl(candidate);
    if (url) return url;
  }
  return "";
}

async function fetchNicoProfileIcon(userId, fetchImpl = globalThis.fetch) {
  const id = normalizeProfileUserId(userId);
  if (!id || typeof fetchImpl !== "function") return "";
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(8000) : undefined;
  try {
    const response = await fetchImpl("https://nvapi.nicovideo.jp/v1/users/" + id, {
      method: "GET",
      headers: { Accept: "application/json", "X-Frontend-Id": "6", "X-Frontend-Version": "0" },
      signal
    });
    if (response && response.ok) {
      const url = extractApiProfileIcon(await response.json());
      if (url) return url;
    }
  } catch (_) {
    // 公開APIが変更・停止した場合に限りユーザーページの画像へフォールバック。
  }
  try {
    const response = await fetchImpl(nicoUserPageUrl(id), {
      method: "GET",
      headers: { Accept: "text/html" },
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(8000) : undefined
    });
    return response && response.ok ? extractProfileImageUrl(await response.text()) : "";
  } catch (_) {
    return "";
  }
}

module.exports = {
  normalizeProfileUserId,
  extractNicoUserId,
  nicoUserPageUrl,
  normalizeIconUrl,
  extractProfileImageUrl,
  extractApiProfileIcon,
  fetchNicoProfileIcon
};
