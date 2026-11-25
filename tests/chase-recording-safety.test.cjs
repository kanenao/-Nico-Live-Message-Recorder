"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { verifyStreamlinkPlugin } = require("../electron/streamlink-probe.cjs");

function fakeProbe(exitCode, message = "") {
  let args;
  const spawnProcess = (_exe, captured) => {
    args = captured;
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (message) child.stderr.write(message);
      child.emit("close", exitCode, null);
    });
    return child;
  };
  return {spawnProcess, args: () => args};
}

test("chase capability preflight verifies both CLI options without starting a recording", async () => {
  const fake = fakeProbe(0);
  await verifyStreamlinkPlugin("streamlink.exe", "lv123456", "config", {
    spawnProcess: fake.spawnProcess, chase: true
  });
  assert.deepEqual(fake.args(), [
    "--config", "config", "--niconico-chase-play", "--hls-live-restart",
    "--can-handle-url-no-redirect", "https://live.nicovideo.jp/watch/lv123456"
  ]);
  assert.equal(fake.args().includes("--output"), false);
});

test("unsupported chase plugin rejects with explicit guidance and no normal fallback", async () => {
  const fake = fakeProbe(2, "unrecognized arguments: --niconico-chase-play");
  await assert.rejects(verifyStreamlinkPlugin("streamlink.exe", "lv123456", "config", {
    spawnProcess: fake.spawnProcess, chase: true
  }), /追っかけ録画対応を確認できません[\s\S]*通常録画へは切り替えません/);
});

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8").replace(/\r\n/g, "\n");

function handlerHarness() {
  const start = main.indexOf('ipcMain.handle("video:start"');
  const end = main.indexOf('  if (!(options && options.timeshift)) {', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    chaseStartPending:false, chaseRecordingActive:false,
    provider:null, commentWriter:null, commentFinalizing:false,
    liveArticleSessionActive:false, streamlinkProcess:null,
    streamlinkFinalizePromise:null, timeshiftCommentFetchActive:false,
    captureStopPromise:null, calls:0, handler:null
  };
  context.ipcMain = { handle: (_channel, handler) => { context.handler=handler; } };
  let resolve, reject;
  context.startVideoInternal = () => {
    context.calls += 1;
    return new Promise((res, rej) => { resolve=res; reject=rej; });
  };
  vm.runInNewContext(main.slice(start,end) + '\n  return null;\n});',context);
  return { context, resolve: value => resolve(value), reject: error => reject(error) };
}

test("chase startup reserves recording before awaiting the plugin", async () => {
  const h = handlerHarness();
  const first = h.context.handler(null,"lv123456","best",{chase:true});
  assert.equal(h.context.chaseStartPending,true);
  await assert.rejects(h.context.handler(null,"lv123456","best",{chase:true}), /追っかけ録画を準備中/);
  await assert.rejects(h.context.handler(null,"lv123456","best",{timeshift:true}), /追っかけ録画を準備中/);
  assert.equal(h.context.calls,1);
  h.context.chaseRecordingActive=true;
  h.resolve({path:"recording.ts"});
  await first;
  assert.equal(h.context.chaseStartPending,false);
  await assert.rejects(h.context.handler(null,"lv123456","best",{}), /追っかけ録画を準備中/);
});

test("failed chase startup releases the reservation for retry", async () => {
  const h = handlerHarness();
  const pending=h.context.handler(null,"lv123456","best",{chase:true});
  h.reject(new Error("unsupported plugin"));
  await assert.rejects(pending,/unsupported plugin/);
  assert.equal(h.context.chaseStartPending,false);
  const retry=h.context.handler(null,"lv123456","best",{chase:true});
  h.resolve({path:"retry.ts"});
  await retry;
  assert.equal(h.context.calls,2);
});

test("chase mode cannot accidentally attach live comments and a late IPC cannot replace final status", () => {
  const preparation = main.slice(main.indexOf("async function prepareCommentSession("),main.indexOf("async function connectPreparedCommentSession("));
  assert.equal((preparation.match(/chaseStartPending \|\| chaseRecordingActive/g)||[]).length,2);
  assert.match(main,/chaseRecordingActive = false;\n  streamlinkRuntimeDirectory/);
  assert.match(main,/verifyStreamlinkPlugin\(streamlinkPath, liveId, runtime\.configPath, \{ env: runtime\.env, chase \}\)/);
  assert.match(renderer,/async function connectLive\(\) \{\n  if \(currentRecordingIsChase\)/);
  assert.match(renderer,/if \(currentRecordingIsChase && videoCaptureState === "recording"\)/);
  assert.match(renderer,/async function processMonitorAutoQueue\(\) \{\n  if \(recordStartInProgress \|\| currentRecordingIsChase\) return/);
});
