const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"renderer.js"),"utf8");
const code=source.slice(source.indexOf("function rankingRecordButtonState("),source.indexOf("function refreshRankingActions("));
function harness({fresh=true,busy=false,rows=[{liveId:"lv123",title:"latest"}]}={}){
 const calls=[],liveInput={value:""};
 const context={rankingCaptureBusy:()=>busy,normalizeId:id=>/^lv\d+$/.test(id)?id:null,
 rankingSnapshot:{rows},isRankingFresh:()=>fresh,liveInput,
 setActivePage:p=>calls.push(["page",p]),syncSelectedRecordingMode:t=>calls.push(["mode",t.liveId]),
 startVideoRecording:async t=>calls.push(["start",t.liveId,t.title]),
 showToast:msg=>calls.push(["toast",msg]),refreshRankingActions:()=>calls.push(["refresh"])};
 const api=vm.runInNewContext(code+"\n({open:openRankingRecording,state:rankingRecordButtonState})",context);
 return {api,calls,liveInput};
}
test("stale ranking permits manual handoff but never auto-starts",async()=>{
 const {api,calls,liveInput}=harness({fresh:false});
 assert.equal(api.state(false,false,false).disabled,false);
 await api.open({liveId:"lv123"});assert.equal(liveInput.value,"lv123");
 assert.ok(calls.some(c=>c[0]==="toast"));assert.ok(!calls.some(c=>c[0]==="start"));
});
test("fresh ranking starts with latest metadata; busy and missing rows do not start",async()=>{
 const fresh=harness();await fresh.api.open({liveId:"lv123",title:"old"});
 assert.deepEqual(fresh.calls.find(c=>c[0]==="start"),["start","lv123","latest"]);
 const busy=harness({busy:true});await busy.api.open({liveId:"lv123"});
 assert.equal(busy.api.state(true,true,false).disabled,true);
 assert.ok(!busy.calls.some(c=>c[0]==="page"||c[0]==="start"));
 const missing=harness({rows:[]});await missing.api.open({liveId:"lv123"});
 assert.equal(missing.liveInput.value,"lv123");assert.ok(!missing.calls.some(c=>c[0]==="start"));
});
test("cached ranking is rendered on return and decoded fallback is preferred",()=>{
 assert.match(source,/if\(active&&rankingSnapshot\)\{renderIndependentRanking\(\);refreshRankingActions\(\);\}/);
 assert.match(source,/\.find\(img=>img\.complete&&img\.naturalWidth>0\)/);
});
