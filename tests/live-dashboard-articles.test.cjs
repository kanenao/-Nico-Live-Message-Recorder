const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeLiveArticleIds, selectLiveArticlePreviews } =
  require("../electron/live-article-preview.cjs");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("LIVE article previews only match exact broadcast IDs, never broadcaster or a different session", () => {
  const articles = [
    { status: "generated", liveId: "lv123456", broadcasterName: "同じ名前", title: "旧記事", summary: "古い放送の要約", generatedAt: "2026-11-14T10:00:00Z" },
    { status: "generated", liveId: "lv1234567", broadcasterName: "同じ名前", title: "別の放送", generatedAt: "2026-11-17T10:00:00Z" },
    { status: "generated", liveId: "lv123456", broadcasterName: "同じ名前", title: "新しい記事", summary: "最新情報", aiProvider: "ollama", commentCount: 12, generatedAt: "2026-11-17T12:00:00Z" },
    { status: "skipped", liveId: "lv987654", title: "表示禁止" },
    { status: "generated", liveId: "lv987654", title: "他の配信" }
  ];
  const result = selectLiveArticlePreviews(articles, ["LV123456", "lv999999"]);
  assert.equal(result.requested, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "新しい記事");
  assert.equal(result.items[0].liveId, "lv123456");
  assert.equal(result.items[0].aiProvider, "ollama");
  assert.equal(result.items[0].commentCount, 12);
});

test("invalid IDs, duplicates and unexpectedly large LIVE queries are bounded", () => {
  assert.deepEqual(normalizeLiveArticleIds([" lv12345 ", "LV12345", "lv54321", "../files", "lv3"]), ["lv12345", "lv54321"]);
  const values = Array.from({ length: 200 }, (_, index) => "lv" + (100000 + index));
  assert.equal(normalizeLiveArticleIds(values).length, 100);
});

test("LIVE preview excludes full article, local paths, large images and transcripts", () => {
  const previews = selectLiveArticlePreviews([{
    status: "generated",
    liveId: "lv12345",
    title: "<script>alert('x')</script>",
    summary: "A ".repeat(500),
    coverImage: "data:image/jpeg;base64," + "A".repeat(10000),
    audioTranscript: "SECRET",
    paragraphs: ["BODY"],
    articlePath: "C:/private/article.json",
    videoFile: "C:/private/video.mp4",
    aiModel: "qwen2.5vl:3b",
    generatedAt: "2026-11-17T10:30:00Z"
  }], ["lv12345"]);
  const article = previews.items[0];
  assert.ok(article.summary.length <= 260);
  assert.equal(article.aiModel, "qwen2.5vl:3b");
  assert.equal(article.hasAudio, true);
  assert.equal(article.articlePath, undefined);
  assert.equal(article.videoFile, undefined);
  assert.equal(article.coverImage, undefined);
  assert.equal(article.audioTranscript, undefined);
});

test("LIVE dashboard displays article previews without disturbing recording and watch controls", () => {
  assert.match(main, /ipcMain\.handle\("articles:live-previews"/);
  assert.match(preload, /getLiveArticlePreviews:.*ipcRenderer\.invoke\("articles:live-previews"/);
  assert.match(renderer, /function renderLiveBroadcasts\(/);
  assert.match(renderer, /liveArticlePreviews\.get\(String\(status\.liveId/);
  assert.match(renderer, /live-broadcast-ai-article/);
  assert.match(renderer, /記事を読む/);
  assert.match(renderer, /記事を作成/);
  assert.match(renderer, /byId\("manual-article-live-id"\)\.value = status\.liveId/);
  assert.match(renderer, /byId\("articles-search"\)\.value = hasArticle \? status\.liveId/);
  assert.match(renderer, /startVideoRecording\(\{\s*liveId: status\.liveId/);
  assert.match(renderer, /api\.openWatch\(status\.liveId\)/);
  assert.match(renderer, /refreshLiveArticlePreviews\(true\)/);
  assert.match(renderer, /channel === "articles:generated"/);
  assert.match(css, /\.live-broadcast-ai-article/);
  assert.match(html, /AI記事の見出し・要約/);
});
