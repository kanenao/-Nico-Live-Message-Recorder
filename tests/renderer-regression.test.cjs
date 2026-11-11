const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");

test("comment overlay preserves the video frame drawn to the canvas", () => {
  const start = renderer.indexOf("function drawCommentOverlay(");
  const end = renderer.indexOf("function setCompositionProgress(", start);
  assert.ok(start >= 0 && end > start, "drawCommentOverlay must exist");
  const drawFunction = renderer.slice(start, end);
  assert.doesNotMatch(drawFunction, /clearRect\s*\(/);
  assert.match(renderer, /context\.drawImage\(videoElement, 0, 0, canvas\.width, canvas\.height\)/);
  assert.match(drawFunction, /context\.fillText\(/);
});

test("settings and broadcaster monitor controls are present in the Japanese UI", () => {
  for (const id of [
    "settings-button",
    "settings-modal",
    "setting-monitor-interval",
    "setting-monitor-quality",
    "setting-auto-record",
    "setting-auto-start",
    "monitor-user-id",
    "monitor-add-button",
    "monitor-start-button",
    "monitor-stop-button",
    "monitor-target-list"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "missing UI element: " + id);
  }
  assert.match(main, /ipcMain\.handle\("monitor:get-state"/);
  assert.match(main, /ipcMain\.handle\("monitor:add-target"/);
  assert.match(main, /ipcMain\.handle\("monitor:start"/);
  assert.match(main, /ipcMain\.handle\("monitor:stop"/);
});

test("saved monitor user IDs are validated with a numeric pattern", () => {
  assert.ok(main.includes("/^\\d{5,}$/"), "saved numeric user IDs must load after restart");
  assert.ok(!main.includes("/^\\\\d{5,}$/"), "the digit pattern must not match a literal backslash");
  assert.ok(main.includes("stopMonitor();"), "monitor timer must stop during app shutdown");
});

test("automatic monitor recording is queued instead of interrupting an active recording", () => {
  assert.match(renderer, /const monitorAutoQueue = \[\]/);
  assert.match(renderer, /if \(recordButton\.disabled \|\| recordStartedAt\) return/);
  assert.match(renderer, /monitorAutoQueue\.push\(payload\)/);
});
