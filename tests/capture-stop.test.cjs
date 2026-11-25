const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

function captureStopHarness(overrides = {}) {
  const start = main.indexOf("async function stopCaptureSession() {");
  const end = main.indexOf('ipcMain.handle("capture:stop"', start);
  assert.ok(start >= 0 && end > start, "combined stop handler must exist");
  const steps = [];
  const context = {
    captureStopPromise: null,
    commentSessionEpoch: 3,
    timeshiftCommentFetchActive: false,
    provider: { disconnect: async () => { steps.push("disconnect-comments"); } },
    currentLiveId: "lv123456",
    commentFilePath: "comments/lv123456.jsonl",
    closeCommentWriter: async () => { steps.push("finalize-comments"); },
    stopStreamlinkRecording: async () => {
      steps.push("finalize-video");
      return { path: "videos/lv123456.mp4", converted: true };
    },
    send: (channel, value) => { steps.push(channel + ":" + value.state); },
    ...overrides
  };
  const stop = vm.runInNewContext(main.slice(start, end) + "\nstopCaptureSession;", context);
  return { stop, context, steps };
}

test("one-click stop finalizes video before disconnecting and closing comment file", async () => {
  const { stop, context, steps } = captureStopHarness();
  const result = await stop();
  assert.equal(result.video.path, "videos/lv123456.mp4");
  assert.equal(result.comment.commentFile, "comments/lv123456.jsonl");
  assert.equal(result.comment.disconnected, true);
  assert.deepEqual(steps, [
    "finalize-video", "disconnect-comments", "finalize-comments", "live:state:disconnected"
  ]);
  assert.equal(context.currentLiveId, "");
  assert.equal(context.commentSessionEpoch, 4);
  assert.equal(context.captureStopPromise, null);
});

test("double stop request shares a single finalization", async () => {
  const { stop, steps } = captureStopHarness({
    stopStreamlinkRecording: async () => {
      steps.push("finalize-video");
      await new Promise(resolve => setImmediate(resolve));
      return { path: "videos/recording.mp4" };
    }
  });
  const [first, second] = await Promise.all([stop(), stop()]);
  assert.equal(first.video.path, second.video.path);
  assert.equal(steps.filter(step => step === "finalize-video").length, 1);
  assert.equal(steps.filter(step => step === "finalize-comments").length, 1);
});

test("comment file still gets finalized when video stop fails", async () => {
  const { stop, steps } = captureStopHarness({
    stopStreamlinkRecording: async () => {
      steps.push("finalize-video");
      throw new Error("ffmpeg failed");
    }
  });
  await assert.rejects(stop(), /ffmpeg failed/);
  assert.deepEqual(steps, [
    "finalize-video", "disconnect-comments", "finalize-comments", "live:state:disconnected"
  ]);
});

test("archive comment fetch cannot be interrupted by closing its writer", async () => {
  const { stop, steps } = captureStopHarness({ timeshiftCommentFetchActive: true });
  await assert.rejects(stop(), /タイムシフト/);
  assert.deepEqual(steps, []);
});

test("primary stop control, IPC bridge and late-connection cancellation are wired", () => {
  assert.match(html, /id="stop-record-button"[^>]*>録画・コメントを停止<\/button>/);
  assert.match(preload, /stopCapture:.*ipcRenderer\.invoke\("capture:stop"\)/);
  assert.match(main, /commentSessionEpoch \+= 1;/);
  assert.match(main, /const epoch = commentSessionEpoch;/);
  assert.match(main, /if \(epoch !== commentSessionEpoch \|\| currentLiveId !== liveId\)/);
  assert.match(main, /if \(commentSessionEpoch !== commentEpochAtStart\) return null/);
  assert.match(renderer, /api\.stopCapture\(\)/);
  assert.match(renderer, /timeshift \? await api\.stopVideo\(\) : await api\.stopCapture\(\)/);
  const early = renderer.indexOf('stopRecordButton.addEventListener("click"');
  const initialization = renderer.indexOf("let connected = false");
  assert.ok(early > 0 && early < initialization, "stop must be bound before optional UI startup");
  assert.match(renderer, /if \(captureStopInProgress \|\| recordButton\.disabled \|\| recordStartedAt\) return/);
});


test("late normal recording start response cannot resurrect a finalized recording", async () => {
  const start=renderer.indexOf("async function startVideoRecording(");
  const end=renderer.indexOf("function startRecordClock(",start);
  assert.ok(start>=0&&end>start);
  let resolveStart;
  let queueCalls=0, clocks=0;
  const writes=[];
  const context={
    captureStopInProgress:false,recordStartInProgress:false,recordStartedAt:0,
    videoCaptureState:"idle",monitorAutoProcessing:false,connected:false,
    currentLiveId:"",currentProgramMetadata:{},currentCaptureTarget:null,currentRecordingIsTimeshift:false,
    liveInput:{value:""},recordButton:{disabled:false},stopRecordButton:{},
    normalizeId:v=>v,byId:()=>null,syncSelectedRecordingMode:()=>{},
    setCaptureText:(id,value)=>writes.push([id,value]),setCaptureDetail:()=>{},
    showToast:()=>{},renderSessionProgramInfo:()=>{},renderLiveBroadcasts:()=>{},
    setConnection:()=>{},requireCaptureApi:()=>{},updateMetadata:()=>{},
    setVideoState:recording=>{context.videoCaptureState=recording?"recording":"idle";},
    startRecordClock:()=>{clocks++;},processMonitorAutoQueue:()=>{queueCalls++;},
    api:{startCapture:()=>new Promise(resolve=>{resolveStart=resolve;})}
  };
  const begin=vm.runInNewContext(renderer.slice(start,end)+"\nstartVideoRecording;",context);
  const pending=begin({liveId:"lv123456"});
  assert.equal(context.recordStartInProgress,true);
  // Simulate the completion event arriving before the IPC reply.
  context.currentCaptureTarget=null;
  context.videoCaptureState="idle";
  context.recordStartedAt=0;
  writes.push(["video-file","確定済み.mp4"]);
  resolveStart({video:{path:"途中.ts"},commentsConnected:true});
  await pending;
  assert.equal(context.videoCaptureState,"idle");
  assert.equal(context.recordStartedAt,0);
  assert.equal(clocks,0);
  assert.equal(context.recordStartInProgress,false);
  assert.equal(context.recordButton.disabled,false);
  assert.equal(queueCalls,1);
  assert.deepEqual(writes.filter(([id])=>id==="video-file"),[["video-file","確定済み.mp4"]]);
});
