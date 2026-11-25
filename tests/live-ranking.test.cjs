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

test("ranking monitor registration uses only verified official user identity",async()=>{
  const {resolveRankingMonitorTarget}=require("../electron/live-ranking.cjs");
  const actual={liveId:"lv123456",broadcasterType:"user",broadcasterId:"123456",broadcasterName:"公式確認名"};
  const resolved=await resolveRankingMonitorTarget("lv123456",async id=>{
    assert.equal(id,"lv123456");
    return actual;
  });
  assert.deepEqual(resolved,{userId:"123456",name:"公式確認名"});
  for(const page of [null,{...actual,broadcasterType:"channel"},{...actual,broadcasterType:"official"},{...actual,broadcasterType:""},{...actual,liveId:"lv234567"},{...actual,broadcasterId:"invalid"},{...actual,broadcasterName:""}]){
    await assert.rejects(resolveRankingMonitorTarget("lv123456",async()=>page),/確認できません/);
  }
  let requested=false;
  await assert.rejects(resolveRankingMonitorTarget("https://example.com/",async()=>{requested=true;}),/正しい放送ID/);
  assert.equal(requested,false);
});
test("ranking monitor button confirms identity before using the existing registration IPC",()=>{
  const root=path.join(__dirname,"..");
  const renderer=fs.readFileSync(path.join(root,"renderer.js"),"utf8");
  const main=fs.readFileSync(path.join(root,"electron/main.cjs"),"utf8");
  const preload=fs.readFileSync(path.join(root,"electron/preload.cjs"),"utf8");
  const start=renderer.indexOf("async function registerRankingMonitor(");
  const end=renderer.indexOf("function renderIndependentRanking(",start);
  const block=renderer.slice(start,end);
  assert.ok(block.indexOf("await api.resolveRankingMonitorTarget(item.liveId)")<block.indexOf("window.confirm("));
  assert.ok(block.indexOf("window.confirm(")<block.indexOf("await api.addMonitorTarget(target)"));
  assert.match(block,/rankingMonitorPending\.has\(item\.liveId\)/);
  assert.match(block,/rankingMonitorPending\.delete\(item\.liveId\)/);
  assert.match(main,/ipcMain.handle\("ranking:resolve-monitor"/);
  assert.match(preload,/ipcRenderer.invoke\("ranking:resolve-monitor", liveId\)/);
});

test("ranking images accept only Nico image CDN HTTPS URLs",()=>{
  const {rankingImageUrl}=require("../electron/live-ranking.cjs");
  const icon="https://secure-dcdn.cdn.nimg.jp/usericon/123/123456.jpg";
  const thumbnail="https://live.cdn.nimg.jp/thumb/example.jpg";
  const row=parseRankingPage(page([{...program("lv123456"),programProvider:{name:"配信者",icon},thumbnail:{large:thumbnail}}]))[0];
  assert.equal(row.iconUrl,icon);
  assert.equal(row.thumbnailUrl,thumbnail);
  for(const url of ["http://nimg.jp/a","https://nimg.jp.evil.example/a","https://user:pw@nimg.jp/a","https://nimg.jp:8443/a","file:///etc/passwd","data:image/svg+xml,abc","https://example.com/a"]){
    assert.equal(rankingImageUrl(url),"");
  }
  const unsafe=parseRankingPage(page([{...program("lv123456"),thumbnailUrl:"https://example.com/a",programProvider:{icon:"file:///a"}}]))[0];
  assert.equal(unsafe.thumbnailUrl,"");
  assert.equal(unsafe.iconUrl,"");
});
test("rank trend is bounded and only joins comparable continuous snapshots",()=>{
  const a={id:"a",ok:true,rows:parseRankingPage(page([program("lv123456"),program("lv234567")]))};
  const b={id:"b",ok:true,rows:parseRankingPage(page([program("lv234567"),program("lv123456")]))};
  let now=1700000000000;
  let rows=buildRanking([a],[],now,0);
  assert.equal(rows[0].rankHistory.length,1);
  for(let i=0;i<50;i++){
    const prevAt=now;now+=90000;
    rows=buildRanking([a],rows,now,prevAt);
  }
  assert.ok(rows[0].rankHistory.length<=40);
  assert.ok(rows[0].rankHistory.every(sample=>sample.at>=now-3600000));
  assert.equal(rows[0].rankHistory.at(-1).rank,rows[0].rank);
  const changed=buildRanking([a,b],rows,now+90000,now);
  assert.equal(changed[0].rankHistory.length,1);
  assert.equal(changed[0].rankChange,null);
  const gap=buildRanking([a],rows,now+360001,now);
  assert.equal(gap[0].rankHistory.length,1);
  assert.equal(gap[0].rankChange,null);
  const reversed=buildRanking([a],rows,now-1000,now);
  assert.equal(reversed[0].rankChange,null);
  const missing=buildRanking([{...a,rows:[a.rows[1]]}],rows,now+90000,now);
  const returned=buildRanking([a],missing,now+180000,now+90000);
  assert.equal(returned.find(row=>row.liveId==="lv123456").rankHistory.length,1);
});
test("ranking artwork and trend render without rebuilding the list every five seconds",()=>{
  const renderer=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  assert.match(renderer,/appendRankingImage\(picture,item\.thumbnailUrl/);
  assert.match(renderer,/appendRankingImage\(picture,item\.iconUrl/);
  assert.match(renderer,/appendRankingTrend\(rankCell,item\)/);
  assert.match(renderer,/rankingTimer=setInterval\(\(\)=>\{\s*refreshRankingActions\(\)/);
  assert.match(renderer,/img\.referrerPolicy="no-referrer"/);
});

const officialPage=program=>'<script data-props="'+JSON.stringify({program,site:{relive:{webSocketUrl:"wss://private.invalid/session"}}}).replace(/&/g,"&amp;").replace(/"/g,"&quot;")+'" id="embedded-data"></script>';
test("official watch enrichment extracts only bounded public metadata and trusted artwork",()=>{
  const {parseOfficialRankingDetails}=require("../electron/live-ranking.cjs");
  const p={nicoliveProgramId:"lv123456",title:"公式番組",beginTime:1700000000,supplier:{name:"公式配信者",programProviderType:"user",programProviderId:"123456",iconUrl:"https://cdn.nimg.jp/icon.jpg"},thumbnail:{huge:"https://cdn.nimg.jp/large.jpg"}};
  const row=parseOfficialRankingDetails(officialPage(p),"lv123456");
  assert.equal(row.name,"公式配信者");
  assert.equal(row.broadcasterId,"123456");
  assert.equal(row.iconUrl,p.supplier.iconUrl);
  assert.equal(row.thumbnailUrl,p.thumbnail.huge);
  assert.equal(row.startedAt,new Date(1700000000000).toISOString());
  assert.equal(JSON.stringify(row).includes("private.invalid"),false);
  assert.equal(parseOfficialRankingDetails(officialPage(p),"lv654321"),null);
  assert.equal(parseOfficialRankingDetails(officialPage({...p,supplier:{...p.supplier,programProviderType:"channel"}}),"lv123456").broadcasterId,"");
  assert.equal(parseOfficialRankingDetails(officialPage({...p,thumbnail:{huge:"https://evil.example/a"}}),"lv123456").thumbnailUrl,"");
});
test("official enrichment limits each refresh to six requests and caches by program ID",async()=>{
  const {createRankingDetailEnricher}=require("../electron/live-ranking.cjs");
  let calls=0,profileCalls=0,active=0,maxActive=0,now=1700000000000;
  const enrich=createRankingDetailEnricher(async(url,options)=>{
    if(url==="https://nvapi.nicovideo.jp/v1/users/123456"){
      profileCalls++;assert.equal(options.redirect,"error");assert.equal(options.headers.cookie,undefined);
      return {ok:true,text:async()=>JSON.stringify({data:{user:{id:123456,icons:{large:"https://cdn.nimg.jp/icon.jpg"}}}})};
    }
    calls++;active++;maxActive=Math.max(active,maxActive);
    assert.match(url,/^https:\/\/live\.nicovideo\.jp\/watch\/lv\d+$/);
    assert.equal(options.redirect,"error");
    assert.equal(options.headers.cookie,undefined);
    const id=url.split("/").at(-1);
    await new Promise(resolve=>setImmediate(resolve));active--;
    return {ok:true,text:async()=>officialPage({nicoliveProgramId:id,title:"公式番組",supplier:{name:"確認名",programProviderType:"user",programProviderId:"123456"},thumbnail:{large:"https://cdn.nimg.jp/a.jpg"}})};
  },()=>now);
  const rows=Array.from({length:10},(_,i)=>({liveId:"lv"+(123456+i),title:"元の番組",points:100-i,rank:i+1}));
  const first=await enrich(rows);
  assert.equal(calls,6);assert.ok(maxActive<=2);
  assert.equal(first.filter(r=>r.thumbnailUrl).length,6);
  assert.equal(first.filter(r=>r.iconUrl).length,6);assert.equal(profileCalls,1);
  assert.equal(first[0].rank,1);assert.equal(first[0].points,100);
  const second=await enrich(rows);
  assert.equal(calls,10);assert.equal(second.filter(r=>r.thumbnailUrl).length,10);
  await enrich(rows);assert.equal(calls,10);assert.equal(profileCalls,1);
  now+=1800001;await enrich(rows);assert.equal(calls,16);
});

test("profile fallback rejects unverified IDs, mismatched identities and untrusted icons",async()=>{
  const {fetchOfficialRankingProfileIcon}=require("../electron/live-ranking.cjs");
  let calls=0;
  const response=payload=>async()=>{calls++;return {ok:true,text:async()=>JSON.stringify(payload)};};
  assert.equal(await fetchOfficialRankingProfileIcon("ch123",response({})), "");
  assert.equal(calls,0);
  assert.equal(await fetchOfficialRankingProfileIcon("123456",response({data:{user:{id:234567,icons:{large:"https://cdn.nimg.jp/icon.jpg"}}}})), "");
  assert.equal(await fetchOfficialRankingProfileIcon("123456",response({data:{user:{id:123456,icons:{large:"https://evil.example/icon.jpg"}}}})), "");
  assert.equal(await fetchOfficialRankingProfileIcon("123456",response({data:{user:{id:123456,icons:{large:"https://cdn.nimg.jp/icon.jpg"}}}})), "https://cdn.nimg.jp/icon.jpg");
});

test("ranking chase action is explicit, confirmed and uses the standalone chase mode",()=>{
  const renderer=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=renderer.indexOf('chase.addEventListener("click"');
  const end=renderer.indexOf("actions.append(record,watch,monitor,chase)",start);
  assert.ok(start>=0&&end>start);
  const block=renderer.slice(start,end);
  assert.match(block,/if\(!window.confirm\(/);
  assert.match(block,/!isRankingFresh\(rankingSnapshot\)/);
  assert.match(block,/await startVideoRecording\(\{liveId:item.liveId,chase:true\}\)/);
  assert.match(renderer,/selectedTarget\?\.chase === true \|\| \(!selectedTarget && byId\("record-mode"\)\?\.value === "chase"\)/);
  assert.match(renderer,/await startVideoRecording\(\{liveId:item.liveId,title:item.title/);
  assert.match(renderer,/api\.startVideo\(liveId, quality, \{ chase: true \}\)/);
});


test("expired ranking detail entries do not starve unvisited lower-ranked programs",async()=>{
  const {createRankingDetailEnricher}=require("../electron/live-ranking.cjs");
  let now=1700000000000;
  const requested=[];
  const enrich=createRankingDetailEnricher(async(url)=>{
    const id=url.split("/").at(-1);
    requested.push(id);
    return {ok:true,text:async()=>officialPage({nicoliveProgramId:id,title:"公式番組",supplier:{name:"配信者"},thumbnail:{large:"https://cdn.nimg.jp/a.jpg"}})};
  },()=>now);
  const rows=Array.from({length:18},(_,i)=>({liveId:"lv"+(123456+i),title:"元の番組"}));
  const first=await enrich(rows);
  assert.equal(first.filter(r=>r.thumbnailUrl).length,6);
  now+=1800001;
  const second=await enrich(rows);
  assert.equal(second[0].thumbnailUrl,undefined);
  assert.equal(second[6].thumbnailUrl,"https://cdn.nimg.jp/a.jpg");
  now+=1800001;
  await enrich(rows);
  assert.deepEqual(requested,rows.map(r=>r.liveId));
  now+=1800001;
  await enrich(rows);
  assert.deepEqual(requested.slice(18),rows.slice(0,6).map(r=>r.liveId));
});


test("dashboard ranking labels use exact live IDs, distinguish partial and stale coverage",()=>{
  const vm=require("node:vm");
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=source.indexOf("function isRankingFresh(");
  const end=source.indexOf("function createLiveRankingLabel(",start);
  assert.ok(start>=0&&end>start);
  const label=vm.runInNewContext(source.slice(start,end)+"\nliveRankingLabel;");
  const now=1700000000000;
  const snapshot={dataAt:new Date(now).toISOString(),stale:false,partial:false,rows:[{liveId:"lv123456",rank:3,rankChange:2}]};
  assert.equal(label(snapshot,"LV123456",now),"独自順位：3位 ↑2");
  assert.equal(label({...snapshot,partial:true},"lv123456",now),"独自順位：3位 ↑2（一部取得）");
  assert.equal(label(snapshot,"lv234567",now),"独自順位：取得範囲外");
  assert.equal(label(snapshot,"123456",now),"独自順位：未確認");
  assert.equal(label(snapshot,"lv123456",now+180001),"独自順位：更新待ち");
  assert.equal(label({...snapshot,stale:true},"lv123456",now),"独自順位：更新待ち");
  assert.equal(label(null,"lv123456",now),"独自順位：未取得");
  assert.equal(label({...snapshot,rows:[{liveId:"lv123456",rank:0}]},"lv123456",now),"独自順位：取得範囲外");
});
test("live dashboard and monitor use shared ranking labels and only poll with live demand",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  assert.match(source,/meta\.append\(liveId, elapsed, createLiveRankingLabel\(status\.liveId\)\)/);
  assert.match(source,/if\(status\?\.isLive&&!status\.error&&status\.liveId\)main\.appendChild\(createLiveRankingLabel/);
  assert.match(source,/const showLiveRanks=page==="dashboard"\|\|page==="monitor"/);
  assert.match(source,/\(active\|\|\(showLiveRanks&&hasLive\(\)\)\)&&byId\("ranking-auto"\)\.checked/);
});
