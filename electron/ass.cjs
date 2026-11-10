"use strict";

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1000000000000 ? value * 1000 : value;
  }
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function assTime(milliseconds) {
  const centiseconds = Math.max(0, Math.floor(milliseconds / 10));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return String(hours) + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0") + "." +
    String(fraction).padStart(2, "0");
}

function escapeAssText(value) {
  return String(value == null ? "" : value)
    .replace(/\0/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\N")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const character of Array.from(text)) {
    units += /^[\x00-\x7f]$/.test(character) ? 0.58 : 1;
  }
  return Math.max(fontSize, Math.ceil(units * fontSize));
}

function takeLane(lanes, requestedStart) {
  const availableIndex = lanes.findIndex((end) => end <= requestedStart);
  if (availableIndex >= 0) return { index: availableIndex, start: requestedStart };
  let earliestIndex = 0;
  for (let index = 1; index < lanes.length; index += 1) {
    if (lanes[index] < lanes[earliestIndex]) earliestIndex = index;
  }
  return { index: earliestIndex, start: Math.max(requestedStart, lanes[earliestIndex]) };
}

function generateAssFromRecords(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("コメントログの形式が正しくありません。");

  const comments = records
    .filter((record) => record && record.type === "comment" && String(record.content || "").trim())
    .map((record) => ({
      record,
      timestamp: parseTimestamp(record.timestamp) ?? parseTimestamp(record.receivedAt)
    }))
    .filter((item) => item.timestamp !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (comments.length === 0) {
    throw new Error("ASSに変換できるコメントがありません。");
  }

  const videoMarker = records.find((record) => record && record.type === "videoStart");
  const sessionMarker = records.find((record) => record && record.type === "sessionStart");
  const origin =
    parseTimestamp(videoMarker && (videoMarker.videoStartedAt || videoMarker.timestamp)) ??
    parseTimestamp(sessionMarker && (sessionMarker.sessionStartedAt || sessionMarker.timestamp)) ??
    comments[0].timestamp;

  const fontName = String(options.fontName || "Meiryo").replace(/[,\r\n]/g, " ");
  const baseFontSize = Math.max(18, Math.min(72, Number(options.fontSize) || 40));
  const playResX = 1920;
  const playResY = 1080;
  const scrollLanes = Array(18).fill(0);
  const topLanes = Array(5).fill(0);
  const bottomLanes = Array(5).fill(0);
  const dialogue = [];

  const colorTags = {
    red: "\\c&H000000FF&",
    blue: "\\c&H00FF0000&",
    green: "\\c&H0000FF00&",
    yellow: "\\c&H0000FFFF&",
    white: "\\c&H00FFFFFF&",
    black: "\\c&H00000000&"
  };

  for (const item of comments) {
    const relativeMs = item.timestamp - origin;
    // History comments received before video recording starts are not overlaid.
    if (relativeMs < -250) continue;

    const record = item.record;
    const text = escapeAssText(record.content);
    if (!text) continue;

    const commands = String(record.mail || "").toLowerCase().split(/\s+/).filter(Boolean);
    let fontSize = baseFontSize;
    if (commands.includes("big")) fontSize = Math.min(72, baseFontSize + 10);
    if (commands.includes("small")) fontSize = Math.max(18, baseFontSize - 8);
    const color = commands.find((command) => Object.prototype.hasOwnProperty.call(colorTags, command));
    const styleTags = "\\fs" + fontSize + (color ? colorTags[color] : "");

    const requestedStart = Math.max(0, relativeMs) / 1000;
    const isTop = commands.includes("ue") || commands.includes("top");
    const isBottom = commands.includes("shita") || commands.includes("bottom");

    if (isTop || isBottom) {
      const lanes = isTop ? topLanes : bottomLanes;
      const lane = takeLane(lanes, requestedStart);
      const duration = 5;
      lanes[lane.index] = lane.start + duration + 0.15;
      const y = isTop ? 48 + lane.index * 42 : playResY - 48 - lane.index * 42;
      const align = isTop ? 8 : 2;
      const position = "{\\an" + align + "\\pos(960," + y + ")" + styleTags + "}";
      dialogue.push(
        "Dialogue: 0," + assTime(lane.start * 1000) + "," +
        assTime((lane.start + duration) * 1000) +
        ",Default,,0,0,0,," + position + text
      );
      continue;
    }

    const width = estimateTextWidth(record.content, fontSize);
    const duration = Math.max(4, Math.min(18, (playResX + width) / 360));
    const lane = takeLane(scrollLanes, requestedStart);
    const y = 52 + lane.index * 48;
    scrollLanes[lane.index] = lane.start + duration + 0.25;
    const movement = "{\\move(" + playResX + "," + y + "," + (-width) + "," + y + ")" + styleTags + "}";

    dialogue.push(
      "Dialogue: 0," + assTime(lane.start * 1000) + "," +
      assTime((lane.start + duration) * 1000) +
      ",Default,,0,0,0,," + movement + text
    );
  }

  if (dialogue.length === 0) {
    throw new Error("録画開始後のコメントがありません。録画開始時刻とコメント時刻を確認してください。");
  }

  const header = [
    "[Script Info]",
    "Title: NicoLive Recorder - ASS Comments",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "PlayResX: " + playResX,
    "PlayResY: " + playResY,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default," + fontName + "," + baseFontSize + ",&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogue
  ];

  return {
    content: header.join("\r\n") + "\r\n",
    commentCount: dialogue.length
  };
}

module.exports = { generateAssFromRecords, escapeAssText, assTime };
