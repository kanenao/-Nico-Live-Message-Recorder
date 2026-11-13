const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFfmpegAudioArgs,
  buildWhisperArgs,
  normalizeTimestamp,
  parseWhisperJson
} = require("../electron/audio-transcription.cjs");

test("audio extraction converts source audio to mono 16 kHz PCM", () => {
  const args = buildFfmpegAudioArgs("source.mp4", "audio.wav");
  assert.ok(args.includes("-vn"));
  assert.ok(args.includes("16000"));
  assert.ok(args.includes("pcm_s16le"));
  assert.equal(args.at(-1), "audio.wav");
});

test("Whisper CLI is configured for Japanese JSON output and CPU compatibility", () => {
  const args = buildWhisperArgs("ggml-base.bin", "audio.wav", "transcript");
  assert.deepEqual(args.slice(0, 6), ["-m", "ggml-base.bin", "-f", "audio.wav", "-l", "ja"]);
  assert.ok(args.includes("-oj"));
  assert.ok(args.includes("-ng"));
});

test("Whisper JSON segments are normalized into a timestamped Japanese transcript", () => {
  const result = parseWhisperJson({
    transcription: [
      { timestamps: { from: "00:00:01.200", to: "00:00:03.500" }, text: "  こんにちは  " },
      { timestamps: { from: "00:00:04.000", to: "00:00:05.000" }, text: "今日は配信です" }
    ]
  });
  assert.equal(result.segmentCount, 2);
  assert.match(result.text, /00:00:01/);
  assert.match(result.text, /こんにちは/);
  assert.match(result.text, /今日は配信です/);
});

test("Whisper timestamps accept numeric seconds and milliseconds", () => {
  assert.equal(normalizeTimestamp(65), "00:01:05");
  assert.equal(normalizeTimestamp(65000), "00:01:05");
  assert.equal(normalizeTimestamp("00:02:03.400"), "00:02:03");
});
