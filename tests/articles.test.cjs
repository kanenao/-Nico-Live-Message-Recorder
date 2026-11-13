const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCommentLog,
  isArticleOptOut,
  generateBroadcastArticle
} = require("../electron/articles.cjs");

function log(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("generates a broadcaster article from program metadata and saved comments", () => {
  const input = log([
    {
      type: "sessionStart",
      liveId: "lv123456789",
      broadcasterName: "テスト配信者",
      broadcasterId: "48495285",
      sessionStartedAt: "2026-11-12T10:00:00.000Z"
    },
    {
      type: "programMetadata",
      programTitle: "福岡の屋台を巡る夜の散歩",
      description: "福岡市内を散策して名物を紹介します。",
      startedAt: "2026-11-12T10:00:00.000Z"
    },
    { type: "comment", liveId: "lv123456789", content: "イルミネーションが綺麗", userId: "1", userName: "A", timestamp: "2026-11-12T10:20:00Z" },
    { type: "comment", liveId: "lv123456789", content: "イルミネーション綺麗ですね", userId: "2", userName: "B", timestamp: "2026-11-12T10:21:00Z" },
    { type: "comment", liveId: "lv123456789", content: "福岡の屋台楽しみです", userId: "3", userName: "C", timestamp: "2026-11-12T10:22:00Z" },
    { type: "videoStop", liveId: "lv123456789", videoStoppedAt: "2026-11-12T11:00:00.000Z" }
  ]);

  const article = generateBroadcastArticle(input);
  assert.equal(article.status, "generated");
  assert.equal(article.liveId, "lv123456789");
  assert.equal(article.broadcasterName, "テスト配信者");
  assert.equal(article.programTitle, "福岡の屋台を巡る夜の散歩");
  assert.equal(article.commentCount, 3);
  assert.equal(article.uniqueCommenters, 3);
  assert.equal(article.visitorCount, null);
  assert.equal(article.durationMinutes, 60);
  assert.ok(article.topics.some((topic) => topic.term.includes("イルミネーション")));
  assert.ok(article.paragraphs.some((paragraph) => paragraph.includes("3件")));
  assert.ok(article.note.includes("文字起こししたものではなく"));
});

test("does not generate articles when the program description prohibits reposting or AI use", () => {
  assert.equal(isArticleOptOut("雑談", "転載禁止の放送です"), "転載禁止");
  assert.equal(isArticleOptOut("雑談", "生成AI禁止"), "生成AI禁止");
  const article = generateBroadcastArticle(log([
    { type: "sessionStart", liveId: "lv123456789" },
    { type: "programMetadata", programTitle: "雑談", description: "AI利用禁止です。" },
    { type: "comment", content: "こんにちは", userId: "1" }
  ]));
  assert.equal(article.status, "skipped");
  assert.match(article.reason, /指定/);
});

test("ignores malformed trailing JSONL rows without inventing missing visitor totals", () => {
  const records = parseCommentLog(
    '{"type":"sessionStart","liveId":"lv123456789"}\n' +
    '{"type":"comment","content":"楽しい放送でした","userId":"1"}\n' +
    '{"type":'
  );
  assert.equal(records.length, 2);
  const article = generateBroadcastArticle(records, { broadcasterName: "配信者" });
  assert.equal(article.status, "generated");
  assert.equal(article.visitorCount, null);
  assert.equal(article.uniqueCommenters, 1);
});

test("can generate a limited article from comments even when the program title is missing", () => {
  const article = generateBroadcastArticle([
    { type: "comment", content: "今日も楽しかったです", userName: "視聴者" }
  ], { liveId: "lv123456789", broadcasterName: "配信者" });
  assert.equal(article.status, "generated");
  assert.match(article.title, /配信者/);
  assert.ok(article.paragraphs.some((paragraph) => paragraph.includes("コメントログ")));
});


test("live article drafts are marked as live and report elapsed time instead of a finish time", () => {
  const article = generateBroadcastArticle(log([
    { type: "sessionStart", liveId: "lv123456789", sessionStartedAt: "2026-11-12T10:00:00.000Z" },
    { type: "programMetadata", programTitle: "生放送のテスト", description: "配信中の説明です。" },
    { type: "comment", content: "今の展開が面白い", userId: "1", userName: "A", timestamp: "2026-11-12T10:15:00Z" },
    { type: "videoStop", liveId: "lv123456789", videoStoppedAt: "2026-11-12T10:20:00.000Z" }
  ]), {
    liveUpdate: true,
    generatedAt: "2026-11-12T10:30:00.000Z"
  });
  assert.equal(article.status, "generated");
  assert.equal(article.liveStatus, "live");
  assert.equal(article.isLive, true);
  assert.equal(article.endedAt, "");
  assert.equal(article.durationMinutes, 30);
  assert.ok(article.paragraphs.some(paragraph => paragraph.includes("現在配信中")));
  assert.ok(article.paragraphs.some(paragraph => paragraph.includes("配信中（約30分経過）")));
});

test("article status can remain unknown when only comment capture was stopped", () => {
  const article = generateBroadcastArticle(log([
    { type: "sessionStart", liveId: "lv123456789", sessionStartedAt: "2026-11-12T10:00:00.000Z" },
    { type: "videoStop", liveId: "lv123456789", videoStoppedAt: "2026-11-12T10:20:00.000Z" },
    { type: "comment", content: "記録したコメントです", userId: "1" }
  ]), {
    liveStatus: "unknown",
    generatedAt: "2026-11-12T10:30:00.000Z"
  });
  assert.equal(article.liveStatus, "unknown");
  assert.equal(article.isLive, false);
  assert.equal(article.endedAt, "");
});

test("article generation accepts an unregistered broadcaster and title-only metadata", () => {
  const article = generateBroadcastArticle([], {
    broadcasterName: "未登録の配信者",
    programTitle: "単発記事用の番組",
    description: "監視登録も録画も行わず記事だけを作成する。"
  });
  assert.equal(article.status, "generated");
  assert.equal(article.broadcasterName, "未登録の配信者");
  assert.equal(article.commentCount, 0);
  assert.ok(article.paragraphs.some(paragraph => paragraph.includes("コメントログはありません")));
});
