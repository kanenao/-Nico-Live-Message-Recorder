const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { findArticleVideoCandidate } = require("../electron/article-thumbnail.cjs");
const { renderArticleHtml } = require("../electron/article-export.cjs");
const { generateArticleWithOllama } = require("../electron/ollama.cjs");

const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");

test("article previews find the exact video after a stale original path", () => {
  const article = {
    liveId: "lv123456",
    commentFile: path.join("comments", "nico", "lv123456_20261116_121500.jsonl"),
    videoFile: path.join("videos", "missing", "lv123456_20261116_121500.ts")
  };
  const recordings = [
    { path: path.join("videos", "new", "lv123456_20261116_121500.ts") },
    { path: path.join("videos", "new", "lv123456_20261116_121500.mp4") },
    { path: path.join("videos", "new", "lv123456_20261116_130000.mp4") }
  ];
  const exists = value => !value.includes("missing");
  assert.equal(findArticleVideoCandidate(article, recordings, exists),
    path.join("videos", "new", "lv123456_20261116_121500.mp4"));
});

test("article previews never pick arbitrary recording when multiple sessions exist", () => {
  const article = { liveId: "lv123456", commentFile: "unknown.jsonl" };
  const list = ["lv123456_20261116_121500.mp4", "lv123456_20261116_130000.mp4"];
  assert.equal(findArticleVideoCandidate(article, list), "");
  assert.equal(findArticleVideoCandidate(article, [list[0]]), list[0]);
  assert.equal(findArticleVideoCandidate(article, ["unrelated.mp4"]), "");
  assert.equal(findArticleVideoCandidate(article, ["lv123456_20261116_121500.txt"]), "");
});

test("newspaper HTML includes JPEG cover and safe editorial chapters", () => {
  const cover = Buffer.from("jpeg test data".repeat(40)).toString("base64");
  const result = renderArticleHtml({
    title: "記事見出し",
    coverImage: "data:image/jpeg;base64," + cover,
    aiSections: [{ heading: "前半の展開", body: "実際の放送のまとめ" },
      { heading: "<script>alert(1)</script>", body: "<img src=x onerror=alert(1)>" }],
    paragraphs: ["fallback paragraph"]
  });
  assert.match(result, /class="cover"/);
  assert.match(result, /data:image\/jpeg;base64,/);
  assert.match(result, /前半の展開/);
  assert.doesNotMatch(result, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(result, /<img src=x onerror=/);
  assert.doesNotMatch(result, /fallback paragraph/);
});

test("rendering gets the article's actual image via a bounded, dedicated IPC", () => {
  assert.match(main, /ipcMain\.handle\("articles:thumbnail"/);
  assert.match(main, /findArticleVideoCandidate\(article, articleVideoIndex\.items/);
  assert.match(main, /extractArticleThumbnailFrame\(videoPath, ffmpegPath, "00:00:00"\)/);
  assert.match(preload, /getArticleThumbnail:.*ipcRenderer\.invoke\("articles:thumbnail"/);
  assert.match(renderer, /scheduleArticleThumbnail\(thumbnail, mediaPlaceholder, article\)/);
  assert.match(renderer, /articleThumbnailRequests < 2/);
  assert.match(renderer, /article\.coverImage = imageUrl/);
  assert.match(renderer, /broadcast-article-chapter/);
  assert.match(renderer, /article\.aiSections/);
});

test("Ollama accepts evidence-labelled sections without legacy paragraphs", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: { content: JSON.stringify({
        title: "新しい記事タイトル",
        summary: "概要",
        sections: [
          { heading: "大事な出来事", body: "配信中に確認した内容です。", source: "comments" },
          { heading: "動画の様子", body: "映像の内容です。", source: "untrusted" }
        ],
        paragraphs: [],
        highlights: ["話題の要点"]
      }) }
    })
  });
  try {
    const result = await generateArticleWithOllama({
      records: [{ type: "comment", content: "こんにちは", timestamp: new Date().toISOString() }],
      context: { liveId: "lv123456", programTitle: "テスト配信" },
      model: "qwen2.5:3b"
    });
    assert.equal(result.paragraphs.length, 2);
    assert.equal(result.sections.length, 2);
    assert.equal(result.sections[0].source, "comments");
    assert.equal(result.sections[1].source, "mixed");
  } finally { global.fetch = originalFetch; }
});
