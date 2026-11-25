"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {SOURCES,parseRankingPage,buildRanking,createRankingService}=require("../electron/live-ranking.cjs");
const page=items=>'<script type="application/json">'+JSON.stringify({programs:items})+'</script>';
const program=(id,comments=20,visitors=100)=>({id,title:"番組 "+id,programProvider:{id:"123456",name:"配信者"},status:"ON_AIR",statistics:{commentCount:comments,watchCount:visitors},beginAt:1700000000});
test("ranking parses only real program IDs, skips ended and malformed rows, preserves missing metrics",()=>{
  const rows=parseRankingPage(page([program("lv123456"),{...program("lv234567"),status:"ENDED"},program("123456"),{id:"lv345678",title:"未取得"},program("lv123456")]));
  assert.deepEqual(rows.map(r=>r.liveId),["lv123456","lv345678"]);
  assert.equal(rows[0].comments,20);
  assert.equal(rows[1].comments,null);
  assert.equal(rows[1].visitors,null);
});
test("HTML fallback accepts watch links, not arbitrary user links or scripts",()=>{
  const rows=parseRankingPage('<a href="https://live.nicovideo.jp/watch/lv123456" title="番組 &amp; 話題">視聴</a><a href="https://bad.example/watch/lv999999">偽</a><a href="https://www.nicovideo.jp/user/234567">ユーザー</a><script><a href="/watch/lv567890">偽</a></script>');
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,"番組 & 話題");
});
test("independent points merge live IDs and never add duplicated cumulative counters",()=>{
  const a=parseRankingPage(page([program("lv123456"),program("lv234567")]));
  const b=parseRankingPage(page([program("lv234567",30,120),program("lv123456",25,110)]));
  const results=[{id:"a",ok:true,rows:a},{id:"b",ok:true,rows:b}];
  const rows=buildRanking(results);
  assert.equal(rows.length,2);
  assert.equal(rows[0].points,1909);
  assert.equal(rows.find(r=>r.liveId==="lv123456").comments,25);
  assert.equal(rows.find(r=>r.liveId==="lv234567").visitors,120);
  assert.equal(rows[0].commentRate,null);
  const next=buildRanking([{id:"a",ok:true,rows:parseRankingPage(page([program("lv123456",40)]))},{id:"b",ok:true,rows:b}],rows,120000,60000);
  assert.equal(next.find(r=>r.liveId==="lv123456").commentRate,10);
  const partial=buildRanking([results[0]],rows,120000,60000);
  assert.equal(partial[0].rankChange,null);
});
test("ranking caches requests and marks previous results stale when every source fails",async()=>{
  let now=1700000000000,requests=0,fail=false;
  const fetchImpl=async(url,opts)=>{
    requests++;
    assert.ok(SOURCES.some(s=>s.url===url));
    assert.equal(opts.redirect,"error");
    assert.equal(opts.headers.cookie,undefined);
    assert.equal(opts.headers.authorization,undefined);
    return {ok:!fail,status:fail?503:200,text:async()=>page([program("lv123456")])};
  };
  const get=createRankingService({fetchImpl,now:()=>now});
  const [first,other]=await Promise.all([get(),get()]);
  assert.equal(requests,4);
  assert.equal(first.rows.length,1);
  assert.equal(first.rows[0].points,4000);
  assert.deepEqual(first,other);
  await get();assert.equal(requests,4);
  now+=91000;fail=true;
  const stale=await get();
  assert.equal(requests,8);assert.equal(stale.stale,true);
  assert.equal(stale.rows[0].liveId,"lv123456");assert.equal(stale.dataAt,first.dataAt);
});
test("ranking UI and IPC are wired to the existing recording pathway",()=>{
  const root=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  const renderer=fs.readFileSync(path.join(root,"renderer.js"),"utf8");
  const main=fs.readFileSync(path.join(root,"electron/main.cjs"),"utf8");
  const preload=fs.readFileSync(path.join(root,"electron/preload.cjs"),"utf8");
  assert.match(html,/data-page-target="ranking"/);
  assert.match(html,/id="ranking-list"/);
  assert.match(renderer,/await startVideoRecording\(\{liveId:item.liveId/);
  assert.match(renderer,/configureRankingRefresh\(activePage === "ranking"\)/);
  assert.match(renderer,/record.disabled\|\|!isRankingFresh\(rankingSnapshot\)/);
  assert.match(preload,/ipcRenderer.invoke\("ranking:list"\)/);
  assert.match(main,/ipcMain.handle\("ranking:list",/);
});

test("comment velocity cannot jump when a different source supplies the counter",()=>{
  const a=parseRankingPage(page([program("lv123456",100)]));
  const b=parseRankingPage(page([program("lv123456",null)]));
  const before=buildRanking([{id:"a",ok:true,rows:a},{id:"b",ok:true,rows:b}]);
  const after=buildRanking([{id:"a",ok:true,rows:parseRankingPage(page([program("lv123456",105)]))},{id:"b",ok:true,rows:parseRankingPage(page([program("lv123456",900)]))}],before,120000,60000);
  assert.equal(after[0].comments,900);
  assert.equal(after[0].commentRate,5);
});
test("invalid timestamps and old snapshots cannot enable the record button",()=>{
  const vm=require("node:vm");
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=source.indexOf("function isRankingFresh(");
  const end=source.indexOf("function renderIndependentRanking(",start);
  const fresh=vm.runInNewContext(source.slice(start,end)+"\nisRankingFresh;");
  const now=1700000000000;
  assert.equal(fresh({dataAt:new Date(now-10000).toISOString(),stale:false},now),true);
  for(const value of ["",undefined,"not a date",new Date(now+5000).toISOString(),new Date(now-180001).toISOString()]){
    assert.equal(fresh({dataAt:value,stale:false},now),false);
  }
  assert.equal(fresh({dataAt:new Date(now).toISOString(),stale:true},now),false);
});
