"use strict";

const WebSocket = require("ws");
const proto = require("@n-air-app/nicolive-comment-protobuf");
const edge = proto.dwango.nicolive.chat.service.edge;
const ChunkedEntry = edge.ChunkedEntry;
const ChunkedMessage = edge.ChunkedMessage;
const PackedSegment = edge.PackedSegment;

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCodePoint(Number(code)); })
    .replace(/&#x([\da-f]+);/gi, function (_, code) { return String.fromCodePoint(parseInt(code, 16)); });
}

function parseTimeshiftWatchPage(html, liveId) {
  const source = String(html || "");
  const match = source.match(/id=["']embedded-data["'][^>]*data-props=["']([^"']+)["']/i);
  if (!match) throw new Error("番組ページからコメント接続情報を読み取れませんでした。");
  let props;
  try {
    props = JSON.parse(decodeHtmlEntities(match[1]));
  } catch (error) {
    throw new Error("番組ページのメタデータを解析できません: " + error.message);
  }
  const program = props && props.program || {};
  const supplier = program.supplier || {};
  const rawBegin = program.beginTime;
  const beginSeconds = rawBegin && typeof rawBegin === "object" && typeof rawBegin.toNumber === "function"
    ? rawBegin.toNumber() : Number(rawBegin);
  const beginAt = Number.isFinite(beginSeconds) && beginSeconds > 0
    ? new Date(beginSeconds * 1000).toISOString() : "";
  const webSocketUrl = props && props.site && props.site.relive &&
    typeof props.site.relive.webSocketUrl === "string"
    ? props.site.relive.webSocketUrl : "";
  return {
    liveId: String(liveId || ""),
    title: String(program.title || ""),
    beginAt,
    webSocketUrl,
    broadcasterName: String(supplier.name || ""),
    broadcasterId: String(supplier.programProviderId || "")
  };
}

async function fetchTimeshiftProgramPage(liveId, cookieHeader, options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");
  const headers = {
    "User-Agent": opts.userAgent || DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetchImpl("https://live.nicovideo.jp/watch/" + encodeURIComponent(liveId), {
    method: "GET",
    headers,
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(Number(opts.timeoutMs) || 25000) : undefined
  });
  if (!response || !response.ok) {
    throw new Error("過去番組ページを取得できませんでした（HTTP " +
      (response ? response.status : "応答なし") + "）。");
  }
  return parseTimeshiftWatchPage(await response.text(), liveId);
}

function resolveViewApiUri(webSocketUrl, cookieHeader, options) {
  const opts = options || {};
  const WsClass = opts.WebSocket || WebSocket;
  const timeoutMs = Math.max(3000, Number(opts.webSocketTimeoutMs) || 20000);
  return new Promise(function (resolve, reject) {
    let socket;
    let settled = false;
    let keepSeatTimer = null;
    const finish = function (error, uri) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (keepSeatTimer) clearInterval(keepSeatTimer);
      if (socket) {
        try { socket.close(); } catch (_) {}
      }
      if (error) reject(error);
      else resolve(uri);
    };
    const timeout = setTimeout(function () {
      finish(new Error("過去番組のコメントサーバーから接続先URIを取得できませんでした（タイムアウト）。"));
    }, timeoutMs);
    const headers = { "User-Agent": opts.userAgent || DEFAULT_USER_AGENT };
    if (cookieHeader) headers.Cookie = cookieHeader;
    try {
      socket = new WsClass(webSocketUrl, { headers });
    } catch (error) {
      finish(new Error("コメントサーバーへ接続できません: " + error.message));
      return;
    }
    socket.on("open", function () {
      socket.send(JSON.stringify({
        type: "startWatching",
        data: {
          stream: { quality: "abr", protocol: "hls", latency: "low", chasePlay: false },
          room: { protocol: "webSocket", commentable: false },
          reconnect: false
        }
      }));
    });
    socket.on("message", function (raw) {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.type === "messageServer" && message.data && message.data.viewUri) {
        finish(null, String(message.data.viewUri));
        return;
      }
      if (message.type === "ping") {
        try { socket.send(JSON.stringify({ type: "pong" })); } catch (_) {}
      }
      if (message.type === "seat") {
        if (keepSeatTimer) clearInterval(keepSeatTimer);
        const seconds = Math.max(10, Math.min(300, Number(message.data && message.data.keepIntervalSec) || 30));
        keepSeatTimer = setInterval(function () {
          if (socket && socket.readyState === 1) {
            try { socket.send(JSON.stringify({ type: "keepSeat" })); } catch (_) {}
          }
        }, seconds * 1000);
      }
      if (message.type === "disconnect" || message.type === "error") {
        finish(new Error("コメントサーバーが接続を終了しました: " +
          String(message.data && (message.data.reason || message.data.message) || "理由不明")));
      }
    });
    socket.on("error", function (error) {
      finish(new Error("コメントサーバーへの接続に失敗しました: " + error.message));
    });
    socket.on("close", function () {
      if (!settled) finish(new Error("コメントサーバーが接続先URIを返す前に切断しました。"));
    });
  });
}

function decodeDelimitedMessages(buffer, decoder) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const decode = decoder || ChunkedMessage;
  const messages = [];
  let offset = 0;
  while (offset < bytes.length) {
    let length = 0;
    let shift = 0;
    let terminated = false;
    for (let index = 0; index < 5; index += 1) {
      if (offset >= bytes.length) throw new Error("コメントデータの長さ情報が途中で終わっています。");
      const part = bytes[offset++];
      length += (part & 0x7f) * Math.pow(2, shift);
      if ((part & 0x80) === 0) {
        terminated = true;
        break;
      }
      shift += 7;
    }
    if (!terminated) throw new Error("コメントデータの長さ情報が不正です。");
    if (length > MAX_MESSAGE_BYTES) throw new Error("コメントメッセージが上限サイズを超えています。");
    if (offset + length > bytes.length) throw new Error("コメントデータが途中で切れています。");
    messages.push(decode.decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return messages;
}

function numberValue(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value.toString ? value.toString() : value);
}

function timestampToIso(value) {
  if (!value || value.seconds === undefined || value.seconds === null) return "";
  const seconds = numberValue(value.seconds);
  const nanos = numberValue(value.nanos || 0);
  if (!Number.isFinite(seconds)) return "";
  const timestamp = seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1000000 : 0);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function mapTimeshiftChunkedMessage(message) {
  if (!message || typeof message !== "object") return [];
  const at = timestampToIso(message.meta && message.meta.at);
  if (!at) return [];
  const result = [];
  const payload = message.payload;
  if (payload === "message" && message.message) {
    const inner = message.message;
    const dataType = inner.data;
    if ((dataType === "chat" && inner.chat) || (dataType === "overflowedChat" && inner.overflowedChat)) {
      const chat = inner.chat || inner.overflowedChat;
      const rawId = chat.rawUserId;
      const userId = chat.hashedUserId || (rawId !== null && rawId !== undefined ? String(rawId) : "");
      const userName = typeof chat.name === "string" && !chat.name.startsWith("a:") ? chat.name : "";
      result.push({
        type: "comment",
        id: chat.no !== undefined ? String(chat.no) : String(message.meta.id || ""),
        content: String(chat.content || ""),
        userId: String(userId || ""),
        userName,
        mail: Array.isArray(chat.mail) ? chat.mail.join(" ") : String(chat.mail || ""),
        timestamp: at,
        receivedAt: new Date().toISOString(),
        isHistory: true
      });
    } else if (dataType === "gift" && inner.gift) {
      const gift = inner.gift;
      result.push({
        type: "gift",
        itemId: String(gift.itemId || ""),
        itemName: String(gift.itemName || ""),
        userId: String(gift.advertiserUserId || ""),
        userName: String(gift.advertiserName || ""),
        point: String(gift.point || ""),
        message: String(gift.message || ""),
        timestamp: at,
        receivedAt: new Date().toISOString(),
        isHistory: true
      });
    } else if (dataType === "simpleNotification" && inner.simpleNotification) {
      const notification = inner.simpleNotification;
      const names = ["ichiba", "quote", "emotion", "cruise", "programExtended", "rankingIn", "visited", "supporterRegistered", "userLevelUp"];
      for (const name of names) {
        if (notification[name]) {
          result.push({
            type: name === "emotion" ? "emotion" : "notification",
            name,
            message: String(notification[name]),
            content: String(notification[name]),
            timestamp: at,
            receivedAt: new Date().toISOString(),
            isHistory: true
          });
          break;
        }
      }
    }
  } else if (payload === "state" && message.state) {
    const operatorComment = message.state.marquee && message.state.marquee.display &&
      message.state.marquee.display.operatorComment;
    if (operatorComment && operatorComment.content) {
      result.push({
        type: "operatorComment",
        content: String(operatorComment.content),
        name: String(operatorComment.name || ""),
        link: String(operatorComment.link || ""),
        timestamp: at,
        receivedAt: new Date().toISOString(),
        isHistory: true
      });
    }
  }
  return result;
}

async function fetchResponseBytes(uri, cookieHeader, options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("HTTP通信機能を利用できません。");
  const headers = {
    "User-Agent": opts.userAgent || DEFAULT_USER_AGENT,
    Accept: "application/octet-stream, application/x-protobuf, */*"
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 25000);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  try {
    const response = await fetchImpl(uri, {
      method: "GET",
      headers,
      signal: controller ? controller.signal : undefined
    });
    if (!response || !response.ok) {
      throw new Error("過去コメントAPIがHTTP " + (response ? response.status : "応答なし") + " を返しました。");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > (Number(opts.maxResponseBytes) || MAX_RESPONSE_BYTES)) {
      throw new Error("過去コメントの応答サイズが上限を超えています。");
    }
    return bytes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function fetchPastComments(viewApiUri, cookieHeader, options) {
  const opts = options || {};
  const viewBase = String(viewApiUri || "").split("?")[0];
  if (!/^https?:\/\//i.test(viewBase)) throw new Error("コメントAPIのURIが正しくありません。");
  const decodeEntry = opts.decodeEntry || ChunkedEntry;
  const decodeMessage = opts.decodeMessage || ChunkedMessage;
  const decodePacked = opts.decodePackedSegment || PackedSegment;
  const decodeFrames = function (data, decoder) {
    if (typeof decoder === "function") return decodeDelimitedMessages(data, decoder);
    return decodeDelimitedMessages(data, decoder);
  };
  const nowBytes = await fetchResponseBytes(viewBase + "?at=now", cookieHeader, opts);
  const nowEntries = decodeFrames(nowBytes, decodeEntry);
  const nowEntry = nowEntries.find(function (entry) { return entry && entry.next && entry.next.at !== undefined; });
  const at = nowEntry && nowEntry.next ? String(nowEntry.next.at) : "";
  if (!at || at === "0") throw new Error("過去コメント取得用の時刻情報を取得できませんでした。");

  const viewBytes = await fetchResponseBytes(viewBase + "?at=" + encodeURIComponent(at), cookieHeader, opts);
  const viewEntries = decodeFrames(viewBytes, decodeEntry);
  const previous = [];
  let backward = null;
  for (const entry of viewEntries) {
    if (entry && entry.previous && entry.previous.uri) previous.push(entry.previous);
    else if (entry && entry.backward && entry.backward.segment && entry.backward.segment.uri) backward = entry.backward;
    else if (entry && entry.segment) break;
  }
  previous.sort(function (a, b) {
    const left = a.until ? numberValue(a.until.seconds) : 0;
    const right = b.until ? numberValue(b.until.seconds) : 0;
    return right - left;
  });

  const maxSegments = Math.max(1, Number(opts.maxSegments) || 500);
  const maxEvents = Math.max(100, Number(opts.maxEvents) || 150000);
  const gapMs = Math.max(0, Number(opts.delayMs === undefined ? 80 : opts.delayMs));
  const events = [];
  const seen = new Set();
  let segmentsFetched = 0;
  let truncated = false;
  const addMessages = function (messages) {
    for (const message of messages) {
      for (const event of mapTimeshiftChunkedMessage(message)) {
        const key = [event.type, event.timestamp, event.id || "", event.content || "", event.userId || ""].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        if (events.length >= maxEvents) {
          truncated = true;
          return;
        }
        events.push(event);
      }
    }
  };

  for (const segment of previous) {
    if (segmentsFetched >= maxSegments || events.length >= maxEvents) {
      truncated = true;
      break;
    }
    const bytes = await fetchResponseBytes(segment.uri, cookieHeader, opts);
    addMessages(decodeFrames(bytes, decodeMessage));
    segmentsFetched += 1;
    if (typeof opts.onProgress === "function") {
      opts.onProgress({ segmentsFetched, eventCount: events.length, phase: "previous" });
    }
    if (gapMs) await delay(gapMs);
  }

  if (backward && backward.segment && backward.segment.uri && !truncated) {
    let uri = backward.segment.uri;
    while (uri && segmentsFetched < maxSegments && events.length < maxEvents) {
      const bytes = await fetchResponseBytes(uri, cookieHeader, opts);
      const packed = typeof decodePacked === "function" ? decodePacked(bytes) : decodePacked.decode(bytes);
      addMessages(packed.messages || []);
      segmentsFetched += 1;
      if (typeof opts.onProgress === "function") {
        opts.onProgress({ segmentsFetched, eventCount: events.length, phase: "backward" });
      }
      uri = packed.next && packed.next.uri ? packed.next.uri : "";
      if (gapMs && uri) await delay(gapMs);
    }
    if (uri) truncated = true;
  } else if (backward && truncated) {
    // The segment cap or event cap was reached before the older chain.
    truncated = true;
  }

  events.sort(function (a, b) {
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });
  return {
    events,
    commentCount: events.filter(function (event) { return event.type === "comment"; }).length,
    segmentsFetched,
    truncated
  };
}

async function fetchTimeshiftArchive(webSocketUrl, cookieHeader, options) {
  const opts = options || {};
  const viewApiUri = opts.viewApiUri || await resolveViewApiUri(webSocketUrl, cookieHeader, opts);
  return fetchPastComments(viewApiUri, cookieHeader, opts);
}

module.exports = {
  parseTimeshiftWatchPage,
  fetchTimeshiftProgramPage,
  resolveViewApiUri,
  decodeDelimitedMessages,
  timestampToIso,
  mapTimeshiftChunkedMessage,
  fetchPastComments,
  fetchTimeshiftArchive
};
