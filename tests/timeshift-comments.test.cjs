const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTimeshiftWatchPage,
  decodeDelimitedMessages,
  mapTimeshiftChunkedMessage,
  fetchPastComments
} = require("../electron/timeshift-comments.cjs");

function encodeFrame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), "utf8");
  let length = payload.length;
  const prefix = [];
  while (length > 0x7f) {
    prefix.push((length & 0x7f) | 0x80);
    length >>>= 7;
  }
  prefix.push(length);
  return Buffer.concat([Buffer.from(prefix), payload]);
}

function responseBytes(bytes) {
  const value = Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  };
}

test("parses the timeshift page WebSocket URL, broadcast start and broadcaster identity", () => {
  const props = {
    site: { relive: { webSocketUrl: "wss://example.test/watch" } },
    program: {
      title: "過去配信テスト",
      beginTime: 1794400000,
      supplier: { name: "配信者", programProviderId: 12345678 }
    }
  };
  const encoded = JSON.stringify(props).replace(/"/g, "&quot;");
  const page = parseTimeshiftWatchPage(
    '<div id="embedded-data" data-props="' + encoded + '"></div>',
    "lv123456789"
  );
  assert.equal(page.liveId, "lv123456789");
  assert.equal(page.title, "過去配信テスト");
  assert.equal(page.webSocketUrl, "wss://example.test/watch");
  assert.equal(page.broadcasterName, "配信者");
  assert.equal(page.broadcasterId, "12345678");
  assert.equal(page.beginAt, new Date(1794400000000).toISOString());
});

test("decodes length-delimited protobuf frames through an injected decoder", () => {
  const bytes = Buffer.concat([
    encodeFrame({ id: "a" }),
    encodeFrame({ id: "b" })
  ]);
  const messages = decodeDelimitedMessages(bytes, {
    decode: (value) => JSON.parse(value.toString("utf8"))
  });
  assert.deepEqual(messages, [{ id: "a" }, { id: "b" }]);
});

test("maps past chat messages with their original timestamp and history marker", () => {
  const events = mapTimeshiftChunkedMessage({
    meta: { id: "server-1", at: { seconds: 1794400000, nanos: 500000000 } },
    payload: "message",
    message: {
      data: "chat",
      chat: {
        no: 42,
        content: "過去コメント",
        rawUserId: 987654,
        name: "コメント投稿者"
      }
    }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "comment");
  assert.equal(events[0].id, "42");
  assert.equal(events[0].content, "過去コメント");
  assert.equal(events[0].userId, "987654");
  assert.equal(events[0].userName, "コメント投稿者");
  assert.equal(events[0].timestamp, new Date(1794400000500).toISOString());
  assert.equal(events[0].isHistory, true);
});

test("fetches Previous and Backward archive segments and sorts comments chronologically", async () => {
  const oldComment = {
    meta: { at: { seconds: 1794399900, nanos: 0 } },
    payload: "message",
    message: { data: "chat", chat: { no: 1, content: "古いコメント", rawUserId: 1 } }
  };
  const recentComment = {
    meta: { at: { seconds: 1794399950, nanos: 0 } },
    payload: "message",
    message: { data: "chat", chat: { no: 2, content: "新しいコメント", rawUserId: 2 } }
  };
  const viewEntries = Buffer.concat([
    encodeFrame({ previous: { uri: "https://api.test/previous", until: { seconds: 1794399900 } } }),
    encodeFrame({ backward: { segment: { uri: "https://api.test/backward" } } }),
    encodeFrame({ segment: { uri: "https://api.test/live" } })
  ]);
  const calls = [];
  const fetchImpl = async (uri) => {
    const url = String(uri);
    calls.push(url);
    if (url.endsWith("?at=now")) return responseBytes(encodeFrame({ next: { at: "1794400000" } }));
    if (url.endsWith("?at=1794400000")) return responseBytes(viewEntries);
    if (url === "https://api.test/previous") return responseBytes(encodeFrame(oldComment));
    if (url === "https://api.test/backward") return responseBytes(Buffer.from(JSON.stringify({
      messages: [recentComment],
      next: null
    })));
    throw new Error("unexpected URL: " + url);
  };
  const decodeJson = { decode: (value) => JSON.parse(value.toString("utf8")) };
  const progress = [];
  const result = await fetchPastComments("https://api.test/view", "user_session=test", {
    fetchImpl,
    decodeEntry: decodeJson,
    decodeMessage: decodeJson,
    decodePackedSegment: decodeJson,
    delayMs: 0,
    onProgress: (value) => progress.push(value)
  });
  assert.equal(result.commentCount, 2);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.content), ["古いコメント", "新しいコメント"]);
  assert.equal(result.events.every((event) => event.isHistory), true);
  assert.equal(result.truncated, false);
  assert.ok(progress.length >= 2);
  assert.ok(calls.includes("https://api.test/view?at=now"));
  assert.ok(calls.includes("https://api.test/view?at=1794400000"));
});
