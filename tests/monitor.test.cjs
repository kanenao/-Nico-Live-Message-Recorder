const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNicoUserId,
  mapWithConcurrency,
  extractUserBroadcasts,
  fetchUserBroadcastStatus,
  fetchFollowingOnAirPrograms,
  fetchNicoUserName,
  normalizeMonitorDate
} = require("../electron/monitor.cjs");

test("normalizes second, millisecond and ISO broadcast timestamps", () => {
  const expected = "2026-11-11T03:34:00.000Z";
  assert.equal(normalizeMonitorDate("1794400000000"), new Date(1794400000000).toISOString());
  assert.equal(normalizeMonitorDate(1794400000), new Date(1794400000000).toISOString());
  assert.equal(normalizeMonitorDate("2026-11-11T12:34:00+09:00"), expected);
  assert.equal(normalizeMonitorDate("not-a-date"), "");
});

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


test("fetches on-air programs from the authenticated follow list", async () => {
  let requestedUrl;
  let requestedInit;
  const programs = await fetchFollowingOnAirPrograms("user_session=secret", {
    fetchImpl: async (url, init) => {
      requestedUrl = new URL(url);
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            programs: [
              {
                id: "lv123456789",
                title: "フォロー限定配信",
                programProvider: { id: 48495285, name: "配信者" },
                socialGroup: { id: "co123", name: "コミュニティ" },
                beginAt: 1794400000000,
                isFollowerOnly: true
              },
              { title: "IDがない項目" },
              null
            ]
          }
        })
      };
    }
  });

  assert.equal(requestedUrl.pathname, "/front/api/pages/follow/v1/programs");
  assert.equal(requestedUrl.searchParams.get("status"), "onair");
  assert.equal(requestedInit.headers.cookie, "user_session=secret");
  assert.equal(programs.length, 1);
  assert.equal(programs[0].liveId, "lv123456789");
  assert.equal(programs[0].providerId, "48495285");
  assert.equal(programs[0].isFollowerOnly, true);
  assert.equal(programs[0].title, "フォロー限定配信");
  assert.equal(programs[0].startedAt, new Date(1794400000000).toISOString());
});

test("follow-list API authentication failures are distinguishable", async () => {
  for (const status of [401, 403, 302]) {
    await assert.rejects(
      fetchFollowingOnAirPrograms("user_session=secret", {
        fetchImpl: async () => ({ ok: false, status })
      }),
      (error) => error.name === "NotAuthenticatedError"
    );
  }
});

test("follow-list API failures can be handled without hiding public-history fallback", async () => {
  await assert.rejects(
    fetchFollowingOnAirPrograms("user_session=secret", {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
  const result = await fetchUserBroadcastStatus("48495285", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          programsList: [{
            id: { value: "lv123456789" },
            program: { title: "公開配信", schedule: { status: "ON_AIR" } }
          }]
        }
      })
    })
  });
  assert.equal(result.isLive, true);
});

test("fetches the broadcaster display name from the public profile API", async () => {
  const result = await fetchNicoUserName("48495285", {
    fetchImpl: async (url) => {
            assert.match(String(url), /api\.ce\.nicovideo\.jp\/api\/v1\/user\.info/);
      return {
        ok: true,
        json: async () => ({
          nicovideo_user_response: { user: { nickname: "テスト配信者" } }
        })
      };
    }
  });
  assert.equal(result, "テスト配信者");
});

test("falls back to the public user profile title when the JSON endpoint has no nickname", async () => {
  let calls = 0;
  const result = await fetchNicoUserName("48495285", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ nicovideo_user_response: {} }) };
      return {
        ok: true,
        text: async () => "<html><title>&#12363;&#12394;&#12385;&#12435;さんのプロフィール - ニコニコ</title></html>"
      };
    }
  });
  assert.equal(result, "かなちん");
  assert.equal(calls, 2);
});


test("uses an ID fallback when the public profile is private or invalid", async () => {
  let calls = 0;
  const name = await fetchNicoUserName("48495285", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          json: async () => ({
            nicovideo_user_response: { user: { nickname: "-" } }
          })
        };
      }
      return {
        ok: true,
        text: async () => "<html><title>非公開プロフィール‐ニコニコ動画</title></html>"
      };
    }
  });
  assert.equal(name, "");
  assert.equal(calls, 2);
});


test("mapWithConcurrency limits concurrent work and preserves input order", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});

test("mapWithConcurrency accepts an empty list and rejects a missing mapper", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (value) => value), []);
  await assert.rejects(mapWithConcurrency([1], 1, null), /mapper/);
});
