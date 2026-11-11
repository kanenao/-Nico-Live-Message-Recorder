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
      const live = broadcasts.find((item) => item.isLive) || null;
      return {
        userId: normalizedId,
        isLive: Boolean(live),
        live,
        latest: broadcasts[0] || null,
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

module.exports = {
  HISTORY_ENDPOINTS,
  normalizeNicoUserId,
  normalizeProgram,
  extractUserBroadcasts,
  fetchUserBroadcastStatus
};
