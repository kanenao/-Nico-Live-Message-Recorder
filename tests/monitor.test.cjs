const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNicoUserId,
  extractUserBroadcasts,
  fetchUserBroadcastStatus
} = require("../electron/monitor.cjs");

test("normalizes a numeric user id and public user page URL", () => {
  assert.equal(normalizeNicoUserId("48495285"), "48495285");
  assert.equal(
    normalizeNicoUserId("https://www.nicovideo.jp/user/48495285/live_programs"),
    "48495285"
  );
});

test("rejects unsupported user identifiers", () => {
  assert.throws(() => normalizeNicoUserId("lv123456789"), /ユーザーID/);
  assert.throws(() => normalizeNicoUserId("https://example.com/user/48495285"), /ユーザーID/);
});

test("extracts the current public broadcast and normalized live id", () => {
  const broadcasts = extractUserBroadcasts({
    data: {
      programsList: [
        {
          id: { value: "lv987654321" },
          program: {
            title: "テスト配信",
            schedule: { status: "ON_AIR" }
          }
        },
        {
          id: { value: "lv987654320" },
          program: {
            title: "終了済み",
            schedule: { status: "ENDED" }
          }
        }
      ]
    }
  });
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].liveId, "lv987654321");
  assert.equal(broadcasts[0].isLive, true);
  assert.equal(broadcasts[1].isLive, false);
});

test("requests public user history and detects an active stream", async () => {
  let requestedUrl;
  const result = await fetchUserBroadcastStatus("48495285", {
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({
          data: {
            programsList: [{
              id: { value: "lv987654321" },
              program: {
                title: "配信中",
                schedule: { status: "ON_AIR" }
              }
            }]
          }
        })
      };
    }
  });
  assert.equal(requestedUrl.searchParams.get("providerId"), "48495285");
  assert.equal(requestedUrl.searchParams.get("providerType"), "user");
  assert.equal(requestedUrl.searchParams.get("isIncludeNonPublic"), "false");
  assert.equal(result.isLive, true);
  assert.equal(result.live.liveId, "lv987654321");
});

test("falls back to the legacy public history endpoint after a v2 error", async () => {
  const requested = [];
  const result = await fetchUserBroadcastStatus("48495285", {
    fetchImpl: async (url) => {
      const current = new URL(url);
      requested.push(current.pathname);
      if (requested.length === 1) return { ok: false, status: 404 };
      return {
        ok: true,
        json: async () => ({
          data: {
            programsList: [{
              id: { value: "lv987654321" },
              program: { title: "終了済み", schedule: { status: "ENDED" } }
            }]
          }
        })
      };
    }
  });
  assert.equal(requested.length, 2);
  assert.ok(requested[0].includes("/v2/"));
  assert.ok(requested[1].includes("/v1/"));
  assert.equal(result.isLive, false);
});

test("does not treat an older ON_AIR item as live when the latest program ended", async () => {
  const result = await fetchUserBroadcastStatus("48495285", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          programsList: [
            {
              id: { value: "lv987654322" },
              program: { title: "最新の終了済み配信", schedule: { status: "ENDED" } }
            },
            {
              id: { value: "lv987654321" },
              program: { title: "古い放送中レコード", schedule: { status: "ON_AIR" } }
            }
          ]
        }
      })
    })
  });
  assert.equal(result.latest.liveId, "lv987654322");
  assert.equal(result.isLive, false);
  assert.equal(result.live, null);
});

test("reports the last HTTP failure when both history endpoints fail", async () => {
  await assert.rejects(
    fetchUserBroadcastStatus("48495285", {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
});
