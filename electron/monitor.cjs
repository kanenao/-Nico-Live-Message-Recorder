"use strict";

const HISTORY_ENDPOINTS = [
  "https://live.nicovideo.jp/front/api/v2/user-broadcast-history",
  "https://live.nicovideo.jp/front/api/v1/user-broadcast-history"
];

function normalizeNicoUserId(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("ニコニコのユーザーIDまたはユーザーURLを入力してください。");

  const pathMatch = input.match(/(?:https?:\/\/)?(?:www\.)?nicovideo\.jp\/user\/(\d+)/i);
  const digits = pathMatch ? pathMatch[1] : (input.match(/^\d+$/) || [])[0];
  if (!digits || !/^\d{5,}$/.test(digits)) {
    throw new Error("ユーザーIDは数字5桁以上、またはニコニコのユーザーページURLを指定してください。");
  }
  return digits;
}

function toLiveId(value) {
  const raw = String(value || "").trim();
  if (/^lv\d+$/i.test(raw)) return raw.toLowerCase();
  if (/^\d{5,}$/.test(raw)) return "lv" + raw;
  return "";
}

function normalizeProgram(entry) {
  const program = entry && entry.program ? entry.program : entry || {};
  const idValue = entry && entry.id && typeof entry.id === "object"
    ? entry.id.value
    : (entry && entry.id) || program.id;
  const liveId = toLiveId(idValue);
  if (!liveId) return null;

  const schedule = program.schedule || entry.schedule || {};
  const status = String(schedule.status || program.status || entry.status || "").trim().toUpperCase();
  const isLive = ["ON_AIR", "ONAIR", "ON AIR", "LIVE"].includes(status) ||
    schedule.isOnAir === true || program.isOnAir === true || entry.isOnAir === true;

  return {
    liveId,
    title: String(program.title || entry.title || "タイトル未取得"),
    providerName: String((program.provider && program.provider.name) || (program.programProvider && program.programProvider.name) || entry.providerName || ""),
    status,
    isLive,
    beginTime: schedule.beginTime || schedule.begin || program.beginTime || null,
    endTime: schedule.endTime || schedule.end || program.endTime || null
  };
}

function extractUserBroadcasts(payload) {
  const root = payload && payload.data ? payload.data : payload || {};
  const list = root.programsList || root.programs || payload.programsList || [];
  if (!Array.isArray(list)) return [];
  return list.map(normalizeProgram).filter(Boolean);
}

async function fetchUserBroadcastStatus(userId, options = {}) {
  const normalizedId = normalizeNicoUserId(userId);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10000);
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");

  let lastError = null;
  for (const endpoint of HISTORY_ENDPOINTS) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      providerId: normalizedId,
      providerType: "user",
      isIncludeNonPublic: "false",
      offset: "0",
      limit: "5",
      withTotalCount: "true"
    }).toString();

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "Nico-Live-Message-Recorder"
        },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined
      });
      if (!response || !response.ok) {
        throw new Error("ニコニコの放送履歴APIがHTTP " + (response ? response.status : "応答なし") + " を返しました。");
      }

      const payload = await response.json();
      const broadcasts = extractUserBroadcasts(payload);
      const latest = broadcasts[0] || null;
      // History is newest-first: an older ON_AIR record must not override a newer ended one.
      const live = latest && latest.isLive ? latest : null;
      return {
        userId: normalizedId,
        isLive: Boolean(live),
        live,
        latest,
        broadcasts,
        checkedAt: new Date().toISOString(),
        endpoint
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    "ユーザー " + normalizedId + " の放送状況を確認できませんでした: " +
    (lastError && lastError.message ? lastError.message : String(lastError || "不明なエラー"))
  );
}

const FOLLOWING_ONAIR_ENDPOINT =
  "https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=0";

class NotAuthenticatedError extends Error {
  constructor(status) {
    super("ニコニコのログインが必要です（フォロー中番組API: HTTP " + status + "）。");
    this.name = "NotAuthenticatedError";
    this.status = status;
  }
}

function asIdentifier(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeFollowingProgram(raw) {
  if (!raw || typeof raw !== "object") return null;
  const liveId = toLiveId(raw.id);
  if (!liveId) return null;

  const provider = raw.programProvider && typeof raw.programProvider === "object"
    ? raw.programProvider : {};
  const socialGroup = raw.socialGroup && typeof raw.socialGroup === "object"
    ? raw.socialGroup : {};
  const beginAtRaw = raw.beginAt;
  const beginAt = typeof beginAtRaw === "number" || typeof beginAtRaw === "string"
    ? new Date(beginAtRaw) : null;

  return {
    id: liveId,
    liveId,
    title: String(raw.title || "タイトル未取得"),
    watchPageUrl: typeof raw.watchPageUrl === "string"
      ? raw.watchPageUrl : "https://live.nicovideo.jp/watch/" + liveId,
    providerId: asIdentifier(provider.id) || "",
    providerName: typeof provider.name === "string" ? provider.name : "",
    providerIcon: typeof provider.icon === "string" ? provider.icon : "",
    socialGroupId: asIdentifier(socialGroup.id) || "",
    socialGroupName: typeof socialGroup.name === "string" ? socialGroup.name : "",
    beginAt: beginAt && Number.isFinite(beginAt.getTime()) ? beginAt : null,
    isFollowerOnly: raw.isFollowerOnly === true
  };
}

/**
 * ログイン中アカウントがフォローしている配信者の放送中一覧を取得する。
 * 取得できない場合は呼び出し元で公開放送履歴APIへフォールバックする。
 */
async function fetchFollowingOnAirPrograms(cookieHeader, options = {}) {
  const cookie = String(cookieHeader || "").trim();
  if (!cookie) throw new NotAuthenticatedError(401);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10000);
  const response = await fetchImpl(FOLLOWING_ONAIR_ENDPOINT, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": options.userAgent || "Nico-Live-Message-Recorder",
      cookie
    },
    redirect: "manual",
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs) : undefined
  });

  if (!response || response.status === 401 || response.status === 403 || response.status === 302) {
    throw new NotAuthenticatedError(response ? response.status : 401);
  }
  if (!response.ok) {
    throw new Error("フォロー中番組APIの取得に失敗しました（HTTP " +
      (response ? response.status : "応答なし") + "）。");
  }

  const payload = await response.json();
  const programs = payload && payload.data && Array.isArray(payload.data.programs)
    ? payload.data.programs : [];
  return programs.map(normalizeFollowingProgram).filter(Boolean);
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/&#(\\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * Best-effort public profile lookup. Prefer the provider name included in
 * the authenticated follow-list API; this is only a fallback for folder labels.
 */
async function fetchNicoUserName(userId, options = {}) {
  const normalizedId = normalizeNicoUserId(userId);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");

  const endpoints = [
    {
      url: "https://api.ce.nicovideo.jp/api/v1/user.info?user_id=" +
        encodeURIComponent(normalizedId) + "&__format=json",
      parse: async (response) => {
        const payload = await response.json();
        const user = payload && payload.nicovideo_user_response &&
          payload.nicovideo_user_response.user;
        return user && typeof user.nickname === "string" ? user.nickname.trim() : "";
      }
    },
    {
      url: "https://ext.nicovideo.jp/thumb_user/" + encodeURIComponent(normalizedId),
      parse: async (response) => {
        const html = await response.text();
                const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (!match) return "";
        return decodeHtmlText(match[1])
          .replace(/さんのプロフィール.*$/u, "")
          .replace(/\s*[-|｜].*ニコニコ.*$/u, "")
          .trim();
      }
    }
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "GET",
        headers: { accept: "application/json, text/html;q=0.9", "user-agent": "Nico-Live-Message-Recorder" },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs) : undefined
      });
      if (!response || !response.ok) {
        throw new Error("ユーザープロフィールAPIがHTTP " +
          (response ? response.status : "応答なし") + " を返しました。");
      }
      const name = await endpoint.parse(response);
      if (name && name !== "非公開ユーザー" && name !== "無効なプロフィール") {
        return name.slice(0, 80);
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return "";
}

module.exports = {
  HISTORY_ENDPOINTS,
  FOLLOWING_ONAIR_ENDPOINT,
  NotAuthenticatedError,
  normalizeFollowingProgram,
  fetchFollowingOnAirPrograms,
  fetchNicoUserName,
  normalizeNicoUserId,
  normalizeProgram,
  extractUserBroadcasts,
  fetchUserBroadcastStatus
};
