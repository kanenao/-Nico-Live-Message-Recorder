"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

function buildFfmpegAudioArgs(inputPath, outputPath) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath];
}
function buildFfmpegSegmentArgs(inputPath, outputPattern, seconds = 120) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "segment",
    "-segment_time", String(seconds), "-reset_timestamps", "1",
    "-segment_format", "wav", outputPattern];
}
function formatAudioOffset(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}
function buildWhisperArgs(modelPath, audioPath, outputPrefix) {
  return ["-m", modelPath, "-f", audioPath, "-l", "ja", "-oj", "-of", outputPrefix, "-np", "-nt", "-ng"];
}
function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 10000 ? value / 1000 : value;
    const whole = Math.max(0, Math.floor(seconds));
    return [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60].map(part => String(part).padStart(2, "0")).join(":");
  }
  const match = String(value || "").trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?/);
  if (!match) return "";
  return [Number(match[1] || 0), Number(match[2]), Number(match[3])].map(part => String(part).padStart(2, "0")).join(":");
}
function parseWhisperJson(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const raw = Array.isArray(data && data.transcription) ? data.transcription : (Array.isArray(data && data.segments) ? data.segments : []);
  const segments = raw.map(segment => {
    const text = String(segment && (segment.text || segment.tokens?.map(token => token.text || "").join("")) || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const times = segment.timestamps || {};
    return { start: normalizeTimestamp(times.from ?? segment.start), end: normalizeTimestamp(times.to ?? segment.end), text };
  }).filter(Boolean);
  const transcript = segments.length
    ? segments.map(segment => (segment.start ? "[" + segment.start + (segment.end ? "–" + segment.end : "") + "] " : "") + segment.text).join("\n")
    : String(data && data.text || "").trim();
  return { text: transcript.slice(0, 30000), segments: segments.slice(0, 500), segmentCount: segments.length };
}
function runProcess(executable, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); }
    catch (error) { reject(new Error(label + "を起動できません: " + error.message)); return; }
    let stderr = "", settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(new Error(label + "がタイムアウトしました。短い動画または軽量モデルで再試行してください。"));
    }, timeoutMs);
    if (child.stderr) child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-3000); });
    child.once("error", error => finish(new Error(label + "を起動できません: " + error.message)));
    child.once("close", code => code === 0 ? finish() : finish(new Error(label + "に失敗しました。" + (stderr.trim() ? " " + stderr.trim().slice(-1400) : "終了コード: " + code))));
  });
}
async function transcribeAudioFile(options = {}) {
  const audioPath = path.resolve(String(options.audioPath || ""));
  const whisperCliPath = path.resolve(String(options.whisperCliPath || ""));
  const modelPath = path.resolve(String(options.modelPath || ""));
  if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) throw new Error("音声セグメントが見つかりません。");
  if (!whisperCliPath || !fs.existsSync(whisperCliPath)) throw new Error("whisper-cli実行ファイルが選択されていません。");
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error("Whisperの日本語モデルファイルが選択されていません。");
  const outputPrefix = path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)) + ".transcript");
  await runProcess(whisperCliPath, buildWhisperArgs(modelPath, audioPath, outputPrefix), 5 * 60 * 1000, "Whisper音声認識");
  const jsonPath = outputPrefix + ".json";
  if (!fs.existsSync(jsonPath)) throw new Error("Whisperの文字起こし結果(JSON)が見つかりません。");
  try {
    const result = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"));
    if (!result.text) throw new Error("音声から文字を認識できませんでした。");
    return result;
  } finally { await fs.promises.rm(jsonPath, { force: true }).catch(() => {}); }
}
async function transcribeVideoAudio(options = {}) {
  const videoPath = path.resolve(String(options.videoPath || ""));
  const ffmpegPath = String(options.ffmpegPath || "");
  const whisperCliPath = path.resolve(String(options.whisperCliPath || ""));
  const modelPath = path.resolve(String(options.modelPath || ""));
  if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) throw new Error("音声解析に使う動画ファイルが見つかりません。");
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error("音声抽出用FFmpegが見つかりません。");
  if (!whisperCliPath || !fs.existsSync(whisperCliPath)) throw new Error("whisper-cli実行ファイルが選択されていません。");
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error("Whisperの日本語モデルファイルが選択されていません。");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nico-article-audio-"));
  const pattern = path.join(directory, "audio-%05d.wav");
  const segmentSeconds = 120;
  try {
    await runProcess(ffmpegPath, buildFfmpegSegmentArgs(videoPath, pattern, segmentSeconds),
      60 * 60 * 1000, "FFmpeg音声分割");
    const names = fs.readdirSync(directory).filter(name => /^audio-\d{5}\.wav$/.test(name)).sort();
    if (!names.length) throw new Error("録画から音声トラックを取得できませんでした。");
    const segments = [];
    let segmentCount = 0;
    const errors = [];
    for (const name of names) {
      const audioPath = path.join(directory, name);
      try {
        const part = await transcribeAudioFile({ audioPath, whisperCliPath, modelPath });
        const index = Number((name.match(/\d{5}/) || [])[0]) || 0;
        segments.push("【配信経過 " + formatAudioOffset(index * segmentSeconds) + "】\n" + part.text);
        segmentCount += part.segmentCount;
        if (typeof options.onProgress === "function") {
          options.onProgress({ processed: segments.length, total: names.length, segmentCount });
        }
      } catch (error) {
        errors.push(name + ": " + (error.message || String(error)));
      } finally {
        await fs.promises.rm(audioPath, { force: true }).catch(() => {});
      }
    }
    if (!segments.length) throw new Error("録画音声の文字起こしに失敗しました。" + errors.slice(0, 2).join(" / "));
    return {
      text: segments.join("\n").slice(0, 250000),
      segmentCount,
      processedChunks: segments.length,
      totalChunks: names.length,
      partialErrors: errors.slice(0, 10)
    };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { buildFfmpegAudioArgs, buildFfmpegSegmentArgs, formatAudioOffset, buildWhisperArgs, normalizeTimestamp, parseWhisperJson, transcribeAudioFile, transcribeVideoAudio };
