const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseVideoDuration, videoPreviewTimes, formatVideoTime } =
  require("../electron/library-video-preview.cjs");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("extracts the full FFmpeg video duration without decoding the whole movie", () => {
  const text = `Input #0, mpegts, from 'example.ts':
  Duration: 01:12:34.56, start: 0.000000, bitrate: 2912 kb/s`;
  assert.equal(parseVideoDuration(text), 4354.56);
  assert.equal(parseVideoDuration("Duration: N/A, start: 0.0"), 0);
  assert.equal(parseVideoDuration(""), 0);
  assert.equal(parseVideoDuration("Duration: 00:00:02.50"), 2.5);
});

test("scene positions span start through end without over-seeking", () => {
  assert.deepEqual(videoPreviewTimes(0), [0]);
  assert.equal(videoPreviewTimes(2.4).length, 1);
  const samples = videoPreviewTimes(400);
  assert.equal(samples.length, 5);
  assert.equal(samples[0], 20);
  assert.equal(samples[2], 200);
  assert.equal(samples[4], 380);
  assert.ok(samples.every((value, index) => value >= 0 && value < 400 &&
    (index === 0 || value > samples[index - 1])));
  assert.deepEqual(videoPreviewTimes(10, 5).length, 2);
  assert.deepEqual(videoPreviewTimes(Number.POSITIVE_INFINITY), [0]);
});

test("video scene timestamps show readable minute and hour offsets", () => {
  assert.equal(formatVideoTime(0), "00:00");
  assert.equal(formatVideoTime(63.8), "01:03");
  assert.equal(formatVideoTime(3661), "1:01:01");
  assert.equal(formatVideoTime(-100), "00:00");
});

test("library video thumbnail and scene gallery use verified local media only", () => {
  assert.match(main, /ipcMain\.handle\("library:thumbnail"/);
  assert.match(main, /ipcMain\.handle\("library:video-preview"/);
  assert.match(main, /async function getLibraryVideoPreview\(value, mode = "poster"\)/);
  assert.match(main, /const videoPath = safeLibraryVideoPath\(value\)/);
  assert.match(main, /resolveLibraryItemPath\(value\)/);
  assert.match(main, /path\.relative\(videosRoot, videoPath\)/);
  assert.match(main, /await articleThumbnailSlot\(\)/);
  assert.match(main, /releaseArticleThumbnailSlot\(\)/);
  assert.match(main, /const storyboard = await getOrCreateVideoStoryboard\(/);
  assert.match(main, /libraryVideoPreviewCache\.size > 72/);
  assert.match(preload, /getLibraryThumbnail:.*ipcRenderer\.invoke\("library:thumbnail"/);
  assert.match(preload, /getLibraryVideoPreview:.*ipcRenderer\.invoke\("library:video-preview"/);
});

test("regression: library frame previews use the installed recorder's FFmpeg, not a missing bundle root", () => {
  // In alpha.115 this caller invoked findBundledFfmpegExecutable() without its
  // mandatory bundleRoot. That always returns null even though the installer
  // includes FFmpeg in resources/streamlink and recording itself works.
  const gallery = main.match(/async function getLibraryVideoPreview\(value, mode = "poster"\) \{[\s\S]*?\n\}/)?.[0] || "";
  const article = main.match(/async function getArticleThumbnail\(articlePath\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(gallery, /const ffmpegPath = getVideoToolStatus\(\)\.ffmpegPath;/);
  assert.match(article, /const ffmpegPath = getVideoToolStatus\(\)\.ffmpegPath;/);
  assert.doesNotMatch(gallery, /findBundledFfmpegExecutable\(/);
  assert.doesNotMatch(article, /findBundledFfmpegExecutable\(/);
  assert.match(main, /function getVideoToolStatus\(\) \{/);
  assert.match(main, /const bundleRoot = getStreamlinkBundleRoot\(\);/);
  assert.match(main, /findBundledFfmpegExecutable\(bundleRoot\)/);
  assert.match(main, /streamlinkPath/);
  const packageConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(packageConfig.build.extraResources.some(entry =>
    entry.to === "streamlink" && entry.from === "vendor/streamlink"
  ), "Windows installer must include the Streamlink and FFmpeg portable binaries");
});

test("each recorded video shows a poster and on-demand selectable inside-video scenes", () => {
  assert.match(renderer, /function scheduleLibraryThumbnail\(image, placeholder, item\)/);
  assert.match(renderer, /function makeLibraryVideoScenesPanel\(item\)/);
  assert.match(renderer, /api\.getLibraryThumbnail\(item\.path\)/);
  assert.match(renderer, /api\.getLibraryVideoPreview\(item\.path\)/);
  assert.match(renderer, /if \(expanded\) scheduleLibraryThumbnail\(image, placeholder, item\)/);
  assert.match(renderer, /aria-pressed/);
  assert.match(renderer, /library-video-thumbnail/);
  assert.match(renderer, /library-video-filmstrip/);
  assert.match(renderer, /scenesButton\.textContent = "動画内を見る"/);
  assert.match(renderer, /function makeVideoStoryboardPanel\(/);
  assert.match(renderer, /makeArticleVideoScenesPanel\(article\)/);
  assert.match(renderer, /video\.currentTime = Math\.min\(selectedSeconds/);
  assert.match(main, /ipcMain\.handle\("articles:video-preview"/);
  assert.match(main, /safeLibraryVideoPath\(videoPath\)/);
  assert.match(preload, /getArticleVideoPreview:.*ipcRenderer\.invoke\("articles:video-preview"/);
  assert.match(css, /\.video-storyboard-layout/);
  assert.match(css, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(renderer, /openButton\.textContent = item\.type === "video" \? "再生" : "開く"/);
  assert.match(renderer, /api\.deleteLibraryVideo\(item\.path\)/);
  assert.match(css, /\.library-video-scenes\[hidden\]/);
  assert.match(css, /\.library-video-thumbnail img\[hidden\]/);
  assert.match(html, /動画内を見る/);
});
