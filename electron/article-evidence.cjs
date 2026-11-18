"use strict";

// AI article evidence is a bounded, read-only view of saved comments.
// Counts always refer to the original log; repeated posts are omitted only
// from the model prompt, never from the user's comment file or statistics.
function commentTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" || /^\d{10,13}$/.test(String(value))
    ? Number(value) : NaN;
  const milliseconds = Number.isFinite(number)
    ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function cleanEvidenceText(value, maxLength = 170) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function prepareCommentEvidence(records, limit = 96, bucketCount = 6) {
  const all = (Array.isArray(records) ? records : []).filter(row =>
    row && row.type === "comment" && cleanEvidenceText(row.content));
  const uniqueCommenters = new Set(all.map(row =>
    String(row.userId || row.userName || "").trim()).filter(Boolean)).size;
  const maxItems = Math.max(1, Math.min(180, Math.floor(Number(limit) || 96)));
  const phases = Math.max(1, Math.min(12, Math.floor(Number(bucketCount) || 6)));
  const timed = all.map((row, index) => ({ row, index, at: commentTime(row.timestamp) }));
  const timestamped = timed.filter(item => item.at !== null);
  const timedCount = timestamped.length;
  let start = Infinity, end = -Infinity;
  for (const item of timestamped) {
    if (item.at < start) start = item.at;
    if (item.at > end) end = item.at;
  }
  if (!timedCount) { start = 0; end = 0; }
  const buckets = Array.from({ length: phases }, (_, index) => ({
    phase: index + 1, total: 0, omittedRepeated: 0, samples: [], seen: new Set()
  }));
  for (const item of timed) {
    const bucket = timedCount && end > start && item.at !== null
      ? Math.min(phases - 1, Math.floor((item.at - start) / (end - start + 1) * phases))
      : Math.min(phases - 1, Math.floor(item.index / Math.max(1, all.length) * phases));
    const slot = buckets[bucket];
    slot.total++;
    const content = cleanEvidenceText(item.row.content);
    const normalized = content.replace(/\s+/g, "").toLowerCase();
    if (slot.seen.has(normalized)) {
      slot.omittedRepeated++;
      continue;
    }
    slot.seen.add(normalized);
    slot.samples.push({ time: item.at === null ? "時刻不明" : new Date(item.at).toISOString(), text: content });
  }
  // Allocate a proportional but non-zero share to each populated part.
  const active = buckets.filter(bucket => bucket.samples.length);
  const selected = new Map(buckets.map(bucket => [bucket, []]));
  let available = maxItems;
  for (const bucket of active) {
    if (available <= 0) break;
    selected.get(bucket).push(bucket.samples[0]);
    available--;
  }
  while (available > 0) {
    let chosen = null;
    let score = -1;
    for (const bucket of active) {
      const current = selected.get(bucket).length;
      if (current >= bucket.samples.length) continue;
      const candidateScore = bucket.samples.length / (current + 1);
      if (candidateScore > score) { chosen = bucket; score = candidateScore; }
    }
    if (!chosen) break;
    const current = selected.get(chosen).length;
    const span = chosen.samples.length;
    const nextIndex = Math.min(span - 1, Math.floor(current * span / Math.max(1, Math.min(span, maxItems))));
    let sample = chosen.samples[nextIndex];
    if (selected.get(chosen).includes(sample)) sample = chosen.samples.find(item => !selected.get(chosen).includes(item));
    if (!sample) break;
    selected.get(chosen).push(sample);
    available--;
  }
  const segments = buckets.map(bucket => ({
    phase: bucket.phase,
    total: bucket.total,
    omittedRepeated: bucket.omittedRepeated,
    samples: selected.get(bucket).sort((a, b) => commentTime(a.time) - commentTime(b.time))
  }));
  const sampleCount = segments.reduce((sum, segment) => sum + segment.samples.length, 0);
  return {
    totalCount: all.length,
    uniqueCommenters,
    timestampedCount: timedCount,
    sampleCount,
    sampledCount: sampleCount,
    repeatedOmittedCount: buckets.reduce((sum, slot) => sum + slot.omittedRepeated, 0),
    segments,
    phaseCount: phases,
    coverage: timedCount ? "timestamped" : "record-order"
  };
}

function summarizeEvidenceSources(evidence = {}) {
  const notes = [];
  if (!evidence.commentCount) notes.push("コメント記録がありません");
  if (!evidence.audioAvailable) notes.push("音声認識結果がありません");
  if (!evidence.videoAvailable) notes.push("映像AI解析結果がありません");
  if (evidence.compactRetry) notes.push("AI出力不完全のため、短縮本文に切り替えました");
  return notes;
}

// Preserve a previously completed live article when a periodic model refresh
// fails. The saved statistics and current broadcast status remain fresh, while
// the old AI wording is explicitly identified as an older snapshot.
function preserveLastGoodLiveArticle(current, previous) {
  if (!current || !previous || current.status !== "generated" ||
      previous.status !== "generated" || current.aiGenerationStatus !== "fallback" ||
      !previous.aiProvider || previous.aiGenerationStatus === "fallback" ||
      previous.liveStatus !== "live" || current.liveStatus !== "live") return current;
  const previousBody = Array.isArray(previous.aiSections) && previous.aiSections.some(item => item && item.body) ||
    Array.isArray(previous.paragraphs) && previous.paragraphs.some(item => typeof item === "string" && item.trim());
  if (!previousBody) return current;
  const preserved = { ...current };
  for (const key of [
    "title", "summary", "paragraphs", "aiSections", "aiHighlights", "aiTimeline",
    "aiAudienceReaction", "aiProvider", "aiModel", "aiEvidence", "aiSourceCoverage",
    "videoAiAnalyzed", "aiCommentSampleCount", "aiCommentTotalCount"
  ]) {
    if (previous[key] !== undefined) preserved[key] = previous[key];
  }
  preserved.aiGenerationStatus = "stale";
  preserved.aiLastSuccessfulAt = previous.aiLastSuccessfulAt || previous.generatedAt || "";
  preserved.aiQualityNotes = [
    "新しいAI本文の生成に失敗したため、前回成功した配信中の本文を表示しています。コメント件数などの統計は最新です。",
    ...(Array.isArray(previous.aiQualityNotes) ? previous.aiQualityNotes : [])
  ].slice(0, 8);
  return preserved;
}

module.exports = { commentTime, cleanEvidenceText, prepareCommentEvidence, summarizeEvidenceSources, preserveLastGoodLiveArticle };
