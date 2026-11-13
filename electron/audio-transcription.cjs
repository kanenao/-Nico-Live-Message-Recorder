"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

function buildFfmpegAudioArgs(inputPath, outputPath) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath];
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
  const wavPath = path.join(directory, "audio-16khz-mono.wav");
  const outputPrefix = path.join(directory, "transcript");
  try {
    await runProcess(ffmpegPath, buildFfmpegAudioArgs(videoPath, wavPath), 10 * 60 * 1000, "FFmpeg音声抽出");
    await runProcess(whisperCliPath, buildWhisperArgs(modelPath, wavPath, outputPrefix), 45 * 60 * 1000, "Whisper音声認識");
    const jsonPath = outputPrefix + ".json";
    if (!fs.existsSync(jsonPath)) throw new Error("Whisperの文字起こし結果(JSON)が見つかりません。whisper-cliの対応バージョンを確認してください。");
    const result = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"));
    if (!result.text) throw new Error("音声から文字を認識できませんでした。");
    return result;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { buildFfmpegAudioArgs, buildWhisperArgs, normalizeTimestamp, parseWhisperJson, transcribeVideoAudio };
