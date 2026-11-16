const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { findMatchingCommentLog, selectLiveArticleFrameHistory, buildLiveArticleFfmpegArgs } =
  require("../electron/article-media.cjs");
const { buildFfmpegSegmentArgs, formatAudioOffset } = require("../electron/audio-transcription.cjs");

const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("recorded video resolves exactly matching JSONL comments without guessing unrelated sessions", () => {
  const video = path.join("videos", "配信者", "lv123456_20261116_120000.mp4");
  const comments = [
    { path: path.join("comments", "配信者", "lv123456_20261116_120000.jsonl"), broadcaster: "配信者" },
    { path: path.join("comments", "配信者", "lv123456_20261116_150000.jsonl"), broadcaster: "配信者" }
  ];
  assert.equal(findMatchingCommentLog(video, comments), comments[0].path);
  assert.equal(findMatchingCommentLog(video, comments.slice(1)), "");
  assert.equal(findMatchingCommentLog(video, [...comments, { path: path.join("comments", "他人", "lv123456_20261116_120000.jsonl"), broadcaster: "他人" }]), comments[0].path);
  assert.equal(findMatchingCommentLog(video, [{ path: "some_other_video.jsonl", broadcaster: "配信者" }]), "");
  assert.equal(findMatchingCommentLog(video, [{ path: "lv123456_100000.jsonl", broadcaster: "他人" }]), "");
  assert.equal(findMatchingCommentLog(video, [
    { path: "lv123456_100000.jsonl", broadcaster: "配信者" },
    { path: "lv123456_110000.jsonl", broadcaster: "配信者" }
  ]), "");
});

test("live multimedia FFmpeg reads video and speech from a single Streamlink pipe", () => {
  const args = buildLiveArticleFfmpegArgs("video", "audio", true, 15, 25);
  assert.ok(args.includes("pipe:0"));
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), ["-map", "0:v:0"]);
  assert.ok(args.includes("0:a:0"));
  assert.ok(args.includes("fps=1/15,scale=640:-2"));
  assert.ok(args.includes("pcm_s16le"));
  assert.ok(args.at(-1).endsWith("audio-%05d.wav"));
  const visionOnly = buildLiveArticleFfmpegArgs("video", "audio", false);
  assert.ok(visionOnly.some(value => value.endsWith("frame-%06d.jpg")));
  assert.ok(!visionOnly.includes("0:a:0"));
});

test("live frame history preserves the beginning and recent frames across many updates", () => {
  let history = [];
  for (let index = 0; index < 80; index += 1) {
    history = selectLiveArticleFrameHistory([...history, { image: "image-" + index }], 16);
  }
  assert.equal(history.length, 16);
  assert.equal(history[0].image, "image-0");
  assert.equal(history.at(-1).image, "image-79");
  assert.ok(history.some(item => Number(item.image.slice(6)) >= 40 && Number(item.image.slice(6)) <= 60));
});

test("long recordings are split into bounded 120-second Whisper WAV segments", () => {
  const args = buildFfmpegSegmentArgs("video.mp4", "audio-%05d.wav");
  assert.ok(args.includes("-vn"));
  assert.ok(args.includes("16000"));
  assert.ok(args.includes("segment"));
  assert.equal(args[args.indexOf("-segment_time") + 1], "120");
  assert.equal(args.at(-1), "audio-%05d.wav");
  assert.equal(formatAudioOffset(250), "00:04:10");
});

test("article pipeline enriches finished recordings and supports on-demand reanalysis", () => {
  assert.match(main, /buildLiveArticleFfmpegArgs\(/);
  assert.match(main, /collectLiveArticleStreamFrames\(/);
  assert.match(main, /queueRecordedArticleAnalysis\(savedArticle\.articlePath\)/);
  assert.match(main, /await transcribeVideoAudio\(/);
  assert.match(main, /saved\.mediaAnalysis =/);
  assert.match(main, /ipcMain\.handle\("articles:reanalyze"/);
  assert.match(main, /deferAiForRecordedVideo/);
  assert.match(main, /liveUpdate: !options\.finalize/);
  assert.match(preload, /reanalyzeBroadcastArticle:.*ipcRenderer\.invoke\("articles:reanalyze"/);
  assert.match(renderer, /api\.reanalyzeBroadcastArticle\(article\.articlePath\)/);
  assert.match(renderer, /articles:analysis-state/);
  assert.match(html, /配信映像を15秒間隔のJPEG画像として抽出/);
});
