"use strict";

const OPT_OUT_TERMS = [
  "無断転載禁止", "転載禁止", "転載不可", "切り抜き禁止", "切り抜き不可",
  "生成AI禁止", "AI生成禁止", "AI利用禁止", "AI学習禁止", "AI禁止",
  "記事化禁止", "記事作成禁止", "まとめ記事禁止"
];

const STOP_WORDS = new Set([
  "これ", "それ", "あれ", "ここ", "そこ", "こと", "もの", "ため", "よう", "ところ",
  "さん", "ちゃん", "くん", "今回", "今日", "昨日", "明日", "配信", "放送", "番組",
  "コメント", "視聴者", "みんな", "自分", "私", "僕", "俺", "www", "ｗｗｗ",
  "です", "ます", "した", "する", "いる", "ある", "なる", "ない", "そう", "かな",
  "だね", "だよ", "ですね", "ました", "だった", "けど", "ので", "から", "まで"
]);

function cleanText(value, maxLength = 2000) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseCommentLog(input) {
  const records = [];
  for (const line of String(input || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch (_) {
      // Ignore an incomplete last line in a log that is still being written.
    }
  }
  return records;
}

function firstValue(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return "";
}

function validIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isArticleOptOut(title, description) {
  const text = cleanText(String(title || "") + " " + String(description || ""), 10000)
    .replace(/\s/g, "");
  return OPT_OUT_TERMS.find((term) => text.includes(term)) || "";
}

function extractTopics(comments, limit = 5) {
  const counts = new Map();
  for (const comment of comments) {
    const text = cleanText(comment.content, 500);
    const tokens = text.match(/[一-龯々〆ヵヶ]{2,10}|[ァ-ヶー]{3,14}|[A-Za-z][A-Za-z0-9_-]{2,16}/g) || [];
    const seen = new Set();
    for (const tokenValue of tokens) {
      const token = tokenValue.toLowerCase();
      if (STOP_WORDS.has(token) || seen.has(token) || /^[ｗw]+$/i.test(token)) continue;
      if (/^\d+$/.test(token)) continue;
      seen.add(token);
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function selectFeaturedComments(comments, limit = 3) {
  const chosen = [];
  const seenUsers = new Set();
  const candidates = comments
    .map((comment) => ({
      content: cleanText(comment.content, 90),
      user: cleanText(comment.userName || comment.userId || "", 80),
      timestamp: validIso(comment.timestamp)
    }))
    .filter((comment) => comment.content.length >= 5 && comment.content.length <= 90)
    .sort((a, b) => b.content.length - a.content.length);
  for (const comment of candidates) {
    const userKey = comment.user || comment.content;
    if (seenUsers.has(userKey)) continue;
    seenUsers.add(userKey);
    chosen.push(comment);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

function generateBroadcastArticle(input, context = {}) {
  const records = Array.isArray(input) ? input : parseCommentLog(input);
  const metadataRecords = records.filter((record) => record.type === "programMetadata");
  const sessionStart = records.find((record) => record.type === "sessionStart") || {};
  const videoStart = records.find((record) => record.type === "videoStart") || {};
  const videoStop = records.filter((record) => record.type === "videoStop").slice(-1)[0] || {};
  const programMetadata = metadataRecords.slice(-1)[0] || {};
  const liveId = cleanText(firstValue([context.liveId, programMetadata.liveId, sessionStart.liveId, records[0] && records[0].liveId]), 32);
  const broadcasterName = cleanText(firstValue([
    context.broadcasterName, programMetadata.broadcasterName, sessionStart.broadcasterName
  ]), 80);
  const broadcasterId = cleanText(firstValue([
    context.broadcasterId, programMetadata.broadcasterId, sessionStart.broadcasterId
  ]), 40);
  const programTitle = cleanText(firstValue([
    context.programTitle, context.title, programMetadata.programTitle, programMetadata.title
  ]), 300);
  const description = cleanText(firstValue([
    context.description, programMetadata.description, programMetadata.programDescription
  ]), 3000);
  const startedAt = validIso(firstValue([
    context.startedAt, programMetadata.startedAt, programMetadata.beginTime,
    videoStart.videoStartedAt, sessionStart.sessionStartedAt
  ]));
  const endedAt = validIso(firstValue([
    context.endedAt, videoStop.videoStoppedAt, videoStop.timestamp
  ]));

  const optOut = isArticleOptOut(programTitle, description);
  if (optOut) {
    return { status: "skipped", reason: "放送者の説明または番組タイトルに記事生成を避ける指定があります。", optOutTerm: optOut, liveId };
  }

  const comments = records.filter((record) =>
    record.type === "comment" && cleanText(record.content, 1000)
  ).map((record) => ({
    content: cleanText(record.content, 1000),
    userId: cleanText(record.userId, 80),
    userName: cleanText(record.userName, 80),
    timestamp: record.timestamp
  }));
  const uniqueCommenters = new Set(comments.map((item) => item.userId || item.userName).filter(Boolean)).size;
  const topics = extractTopics(comments);
  const featuredComments = selectFeaturedComments(comments);
  const visitorCountValue = firstValue([
    context.visitorCount, programMetadata.visitorCount, programMetadata.totalVisitors,
    programMetadata.viewCount, programMetadata.totalViewCount
  ]);
  const visitorCount = Number.isFinite(Number(visitorCountValue)) && visitorCountValue !== ""
    ? Math.max(0, Math.floor(Number(visitorCountValue))) : null;
  const durationMinutes = startedAt && endedAt
    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60000))
    : null;

  if (!programTitle && !description && comments.length === 0) {
    return { status: "skipped", reason: "記事にできる番組情報・コメントがありません。", liveId };
  }

  const broadcaster = broadcasterName || (broadcasterId ? "ユーザー " + broadcasterId : "登録配信者");
  const displayDate = startedAt
    ? new Date(startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })
    : "日時未取得";
  const title = programTitle
    ? programTitle + "｜放送内容・コメントまとめ"
    : broadcaster + "の放送内容まとめ " + (liveId || "");
  const paragraphs = [];

  if (programTitle || description) {
    let opening = broadcaster + "は" + displayDate + "、";
    opening += programTitle ? "「" + programTitle + "」と題した生配信を実施した。" : "生配信を実施した。";
    if (description) opening += " 番組説明には「" + description.slice(0, 420) + (description.length > 420 ? "…" : "") + "」と記載されている。";
    paragraphs.push(opening);
  }

  if (comments.length) {
    let commentParagraph = "保存されたコメントログには" + comments.length.toLocaleString("ja-JP") + "件のコメントが記録され、";
    commentParagraph += uniqueCommenters
      ? "投稿者は" + uniqueCommenters.toLocaleString("ja-JP") + "人だった。"
      : "投稿者数は取得できなかった。";
    if (topics.length) {
      commentParagraph += " コメント内で複数回確認された語句は、" +
        topics.map((item) => "「" + item.term + "」").join("、") + "など。";
    }
    paragraphs.push(commentParagraph);

    if (featuredComments.length) {
      paragraphs.push("コメント欄には「" + featuredComments.map((item) => item.content).join("」「") +
        "」などの投稿が記録されている。これらは保存ログから抜粋したもので、視聴者全体の意見を代表するものではない。");
    }
  } else {
    paragraphs.push("この記事に利用できるコメントログはありません。番組タイトルと説明から作成した概要のため、配信中の具体的な会話や展開は確認できていません。");
  }

  if (startedAt || endedAt) {
    const timeText = startedAt ? displayDate : "開始時刻未取得";
    const endText = endedAt
      ? new Date(endedAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }) + "終了"
      : "終了時刻未取得";
    paragraphs.push("放送日時：" + timeText + " ／ " + endText +
      (durationMinutes !== null ? "（約" + durationMinutes + "分）" : "") + "。");
  }

  const note = "自動生成記事です。番組タイトル・番組説明・保存済みコメントログを整理しています。映像・音声の発言内容を文字起こししたものではなく、コメントの抜粋も投稿者個人の意見です。";
  return {
    status: "generated",
    schemaVersion: 1,
    title,
    broadcasterName: broadcasterName || broadcaster,
    broadcasterId,
    liveId,
    programTitle,
    description,
    startedAt,
    endedAt,
    durationMinutes,
    visitorCount,
    uniqueCommenters,
    commentCount: comments.length,
    topics,
    featuredComments,
    paragraphs,
    note,
    generatedAt: validIso(context.generatedAt) || new Date().toISOString()
  };
}

module.exports = {
  OPT_OUT_TERMS,
  cleanText,
  parseCommentLog,
  isArticleOptOut,
  extractTopics,
  generateBroadcastArticle
};
