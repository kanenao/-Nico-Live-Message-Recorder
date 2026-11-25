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
  assert.equal(rows[0].points,382);
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
  assert.equal(requests,3);
  assert.equal(first.rows.length,1);
  assert.equal(first.rows[0].points,600);
  assert.deepEqual(first,other);
  await get();assert.equal(requests,3);
  now+=91000;fail=true;
  const stale=await get();
  assert.equal(requests,6);assert.equal(stale.stale,true);
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
  assert.doesNotMatch(renderer,/appendRankingImage\(picture,item\.iconUrl/);
  assert.match(renderer,/picture\.addEventListener\("click",openPicture\)/);
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
  const end=renderer.indexOf("actions.append(record,watch,monitor,chase,preview)",start);
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


test("comment rate survives partial source failure without comparing unrelated counters",()=>{
  const source=(id,value)=>({id,ok:true,rows:parseRankingPage(page([program("lv123456",value)]))});
  const failed={id:"b",ok:false,rows:[]};
  const now=1700000000000;
  const before=buildRanking([source("a",100),source("b",900)],[],now,0);
  const partial=buildRanking([source("a",115),failed],before,now+90000,now);
  assert.equal(partial[0].commentRate,10);
  assert.equal(partial[0].commentRateSourceCount,1);
  assert.equal(partial[0].rankChange,null);
  const restored=buildRanking([source("a",130),source("b",1500)],partial,now+180000,now+90000);
  assert.equal(restored[0].commentRate,10);
  assert.equal(restored[0].commentRateSourceCount,1);
  assert.equal(restored[0].rankChange,null);
  const reset=buildRanking([source("a",5),source("b",1499)],restored,now+270000,now+180000);
  assert.equal(reset[0].commentRate,null);
  assert.equal(reset[0].commentRateSourceCount,0);
  const short=buildRanking([source("a",140)],restored,now+190000,now+180000);
  assert.equal(short[0].commentRate,null);
  const expired=buildRanking([source("a",140)],restored,now+180000+16*60000,now+180000);
  assert.equal(expired[0].commentRate,null);
  const zero=buildRanking([source("a",130)],restored,now+270000,now+180000);
  assert.equal(zero[0].commentRate,0);
  assert.equal(zero[0].commentRateSourceCount,1);
});


test("official ranking identity accepts explicit Nico user page links without guessing channel IDs",()=>{
  const {parseOfficialRankingDetails}=require("../electron/live-ranking.cjs");
  const parse=supplier=>parseOfficialRankingDetails(officialPage({nicoliveProgramId:"lv123456",title:"番組",supplier}),"lv123456");
  assert.equal(parse({name:"配信者",url:"https://www.nicovideo.jp/user/123456"}).broadcasterId,"123456");
  assert.equal(parse({name:"配信者",type:"user",userPageUrl:"https://www.nicovideo.jp/user/123456"}).broadcasterId,"123456");
  assert.equal(parse({id:123456}).broadcasterId,"");
  assert.equal(parse({type:"channel",url:"https://www.nicovideo.jp/user/123456"}).broadcasterId,"");
  assert.equal(parse({type:"user",id:654321,url:"https://www.nicovideo.jp/user/123456"}).broadcasterId,"");
  assert.equal(parse({url:"https://www.nicovideo.jp.evil.example/user/123456"}).broadcasterId,"");
  assert.equal(parse({url:"https://www.nicovideo.jp/user/123456",profileUrl:"https://www.nicovideo.jp/user/654321"}).broadcasterId,"");
  assert.equal(parse({type:"user",id:123456,icons:{large:"https://cdn.nimg.jp/icon.jpg"}}).iconUrl,"https://cdn.nimg.jp/icon.jpg");
});
test("ranking profile falls back to bounded official user page and rejects generic OGP",async()=>{
  const {fetchOfficialRankingProfileIcon}=require("../electron/live-ranking.cjs");
  const icon="https://secure-dcdn.cdn.nimg.jp/usericon/123/123456.jpg";
  const calls=[];
  const fetcher=async(url,opts)=>{
    calls.push(url);assert.equal(opts.redirect,"error");assert.equal(opts.headers.cookie,undefined);
    if(url.includes("nvapi"))return {ok:false,status:503};
    return {ok:true,text:async()=>'<meta property="og:image" content="'+icon+'">'};
  };
  assert.equal(await fetchOfficialRankingProfileIcon("123456",fetcher),icon);
  assert.deepEqual(calls,["https://nvapi.nicovideo.jp/v1/users/123456","https://www.nicovideo.jp/user/123456"]);
  const generic=async(url)=>url.includes("nvapi")?{ok:false}:{ok:true,text:async()=>'<meta property="og:image" content="https://cdn.nimg.jp/generic.jpg">'};
  assert.equal(await fetchOfficialRankingProfileIcon("123456",generic),"");
});


test("ranking cache does not lock out updates when the system clock moves backwards",async()=>{
  let now=1700000000000,calls=0;
  const get=createRankingService({now:()=>now,fetchImpl:async()=>{
    calls++;
    return {ok:true,text:async()=>page([program("lv123456")])};
  }});
  await get();assert.equal(calls,3);
  now-=3600000;
  const snapshot=await get();assert.equal(calls,6);
  assert.equal(snapshot.dataAt,new Date(now).toISOString());
  assert.equal(snapshot.rows[0].rankChange,null);
  assert.equal(snapshot.rows[0].commentRate,null);
  await get();assert.equal(calls,6);
});
test("ranking poll retries respect the refresh interval and recover after clock changes",()=>{
  const vm=require("node:vm");
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=source.indexOf("function isRankingFresh(");
  const end=source.indexOf("function liveRankingLabel(",start);
  const {due,status}=vm.runInNewContext(source.slice(start,end)+"\n({due:isRankingRefreshDue,status:rankingStatusText});");
  const now=1700000000000;
  assert.equal(due(null,now),true);
  assert.equal(due(now-5000,now),false);
  assert.equal(due(now-29999,now),false);
  assert.equal(due(now-30000,now),true);
  assert.equal(due(now+1000,now),true);
  const snapshot={dataAt:new Date(now).toISOString(),stale:false,partial:true,rows:[{}]};
  assert.match(status(snapshot,1,now+10000),/一部取得不可.*10秒前/);
  assert.match(status(snapshot,1,now+180001),/古いデータ（録画無効）/);
  assert.match(status({...snapshot,stale:true},1,now+10000),/更新失敗/);
  assert.match(status(snapshot,1,now-1000),/古いデータ/);
});


test("duplicate ranking records preserve listing position and fill missing metrics and artwork",()=>{
  const rows=parseRankingPage(page([
    {id:"lv123456",title:"先頭",statistics:{watchCount:0}},
    program("lv234567"),
    {id:"lv123456",title:"別表示",programProvider:{id:"123456",name:"配信者",icon:"https://cdn.nimg.jp/icon.jpg"},statistics:{watchCount:999,commentCount:15},thumbnailUrl:"https://cdn.nimg.jp/thumb.jpg"}
  ]));
  assert.deepEqual(rows.map(r=>r.liveId),["lv123456","lv234567"]);
  assert.equal(rows[0].title,"先頭");
  assert.equal(rows[0].visitors,0);
  assert.equal(rows[0].comments,15);
  assert.equal(rows[0].name,"配信者");
  assert.equal(rows[0].iconUrl,"https://cdn.nimg.jp/icon.jpg");
  assert.equal(rows[0].thumbnailUrl,"https://cdn.nimg.jp/thumb.jpg");
});
test("duplicate ranking records reject conflicting provider identity and icon",()=>{
  const rows=parseRankingPage(page([
    {id:"lv123456",title:"先頭",programProvider:{id:"123456"}},
    {id:"lv123456",title:"先頭",programProvider:{id:"234567",name:"別人",icon:"https://cdn.nimg.jp/other.jpg"}}
  ]));
  assert.equal(rows[0].broadcasterId,"123456");
  assert.equal(rows[0].name,"");
  assert.equal(rows[0].iconUrl,"");
});
test("ranking wrappers can expose provider and statistics beside the program",()=>{
  const rows=parseRankingPage(page([{
    program:{id:"lv123456",title:"番組",status:"ON_AIR"},
    programProvider:{id:"123456",name:"配信者",icon:"https://cdn.nimg.jp/icon.jpg"},
    statistics:{commentCount:0,watchCount:42}
  }]));
  assert.equal(rows[0].name,"配信者");
  assert.equal(rows[0].iconUrl,"https://cdn.nimg.jp/icon.jpg");
  assert.equal(rows[0].comments,0);
  assert.equal(rows[0].visitors,42);
});


test("explicit recording targets synchronize the mode selector without changing manual selection",()=>{
  const vm=require("node:vm");
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=source.indexOf("function syncSelectedRecordingMode(");
  const end=source.indexOf("async function startVideoRecording(",start);
  assert.ok(start>=0&&end>start);
  let changes=0;
  const selector={value:"timeshift",dispatchEvent(event){assert.equal(event.type,"change");changes++;}};
  const sync=vm.runInNewContext(source.slice(start,end)+"\nsyncSelectedRecordingMode;",{
    byId:id=>id==="record-mode"?selector:null,Event:class {constructor(type){this.type=type;}}
  });
  sync(null);
  assert.equal(selector.value,"timeshift");
  assert.equal(changes,0);
  sync({liveId:"lv123456"});
  assert.equal(selector.value,"live");
  assert.equal(changes,1);
  sync({liveId:"lv123456",chase:true});
  assert.equal(selector.value,"chase");
  assert.equal(changes,2);
  sync({liveId:"lv123456",chase:true});
  assert.equal(changes,2);
  sync({liveId:"lv234567",chase:false});
  assert.equal(selector.value,"live");
  assert.equal(changes,3);
  assert.match(source,/syncSelectedRecordingMode\(selectedTarget\);\s*if \(selectedTarget\?\.chase/);
});


test("rank trend compares actual source coverage even when a source falls outside the visible 200",()=>{
  const shared=Array.from({length:200},(_,i)=>({liveId:"lv"+(100000+i),title:"番組",comments:10}));
  const extra={liveId:"lv999999",title:"別サイト",comments:10};
  const results=[{id:"a",ok:true,rows:shared},{id:"b",ok:true,rows:shared},{id:"c",ok:true,rows:[...shared.slice(0,199),extra]},{id:"d",ok:true,rows:[...shared.slice(0,199),shared[199]]}];
  // A source can be entirely excluded when all its rows have a lower score.
  const crowded=[{id:"a",ok:true,rows:shared},{id:"b",ok:true,rows:shared},{id:"c",ok:true,rows:shared},{id:"d",ok:true,rows:[...shared.slice(0,199),extra]}];
  // Use a single low-ranking unique program at rank 200, with the earlier
  // entries overlapping the other sources. Test explicit source coverage
  // against a truncated historical list, including missing source keys.
  const now=1700000000000;
  const first=buildRanking(results,[],now,0);
  const truncated=first.map(row=>({...row,sourceRanks:Object.fromEntries(Object.entries(row.sourceRanks).filter(([id])=>id!=="d"))}));
  const next=buildRanking(crowded,truncated,now+90000,now,["a","b","c","d"]);
  assert.equal(next[0].rankChange,0);
  assert.equal(next[0].rankHistory.length,2);
  const failed=buildRanking(crowded.slice(0,3),next,now+180000,now+90000,["a","b","c","d"]);
  assert.equal(failed[0].rankChange,null);
  assert.equal(failed[0].rankHistory.length,1);
});
test("ranking service preserves full source coverage across refreshes",async()=>{
  let now=1700000000000,drop=false;
  const get=createRankingService({now:()=>now,fetchImpl:async(url)=>{
    if(drop&&url===SOURCES[2].url)return {ok:false,status:503};
    return {ok:true,text:async()=>page([program("lv123456")])};
  }});
  await get();now+=90000;
  const next=await get();assert.equal(next.rows[0].rankChange,0);
  now+=90000;drop=true;
  const partial=await get();assert.equal(partial.rows[0].rankChange,null);
  assert.equal(partial.rows[0].rankHistory.length,1);
});


test("ranking hides per-source badges without disabling collection or freshness status",()=>{
  const root=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  const renderer=fs.readFileSync(path.join(root,"renderer.js"),"utf8");
  const css=fs.readFileSync(path.join(root,"styles.css"),"utf8");
  assert.doesNotMatch(html,/id="ranking-sources"/);
  assert.doesNotMatch(renderer,/ranking-sources|ranking-source/);
  assert.doesNotMatch(css,/\.ranking-sources?\b/);
  assert.match(html,/id="ranking-status"/);
  assert.match(renderer,/rankingStatusText\(rankingSnapshot,rankingVisibleCount/);
  assert.match(renderer,/api\.getLiveRanking\(\)/);
  assert.equal(SOURCES.length,3);
});


test("momentum ranking uses 30-second same-source growth and preserves unknown counters",()=>{
  const now=1700000000000;
  const rows=(a,b)=>[{id:"a",ok:true,rows:parseRankingPage(page([program("lv123456",a,100),program("lv234567",b,100)]))}];
  const first=buildRanking(rows(100,100),[],now,0);
  const next=buildRanking(rows(100,125),first,now+30000,now);
  assert.equal(next[0].liveId,"lv234567");
  assert.equal(next[0].commentRate,50);
  assert.equal(next[0].commentDelta,25);
  assert.equal(next[0].visitorDelta,0);
  assert.equal(next[0].pointDelta,null);
  const next2=buildRanking(rows(100,150),next,now+60000,now+30000);
  assert.equal(next2[0].pointDelta,0);
  const reset=buildRanking(rows(100,1),next2,now+90000,now+60000);
  assert.equal(reset.find(x=>x.liveId==="lv234567").commentDelta,null);
});
test("ranking movement distinguishes new, unchanged and incomparable snapshots",()=>{
  const vm=require("node:vm");
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const start=source.indexOf("function rankingMovement(");
  const end=source.indexOf("function appendRankingDelta(",start);
  const label=vm.runInNewContext(source.slice(start,end)+"\nrankingMovement;");
  assert.equal(label({rankNew:true}),"NEW");
  assert.equal(label({rankChange:null}),"—");
  assert.match(label({rankChange:0,previousRank:3}),/KEEP.*3位/);
  assert.match(label({rankChange:2,previousRank:3}),/UP 2/);
  assert.match(label({rankChange:-1,previousRank:3}),/DOWN 1/);
});


test("point difference requires the same actual comparison sources, not just equal source counts",()=>{
  const now=1700000000000;
  const sample=(a,b)=>[
    {id:"a",ok:true,rows:[{liveId:"lv123456",title:"番組",comments:a,visitors:100}]},
    {id:"b",ok:true,rows:[{liveId:"lv123456",title:"番組",comments:b,visitors:100}]}
  ];
  const first=buildRanking(sample(10,null),[],now,0);
  const second=buildRanking(sample(20,100),first,now+30000,now);
  assert.deepEqual(second[0].commentRateSourceIds,["a"]);
  const third=buildRanking(sample(null,150),second,now+60000,now+30000);
  assert.deepEqual(third[0].commentRateSourceIds,["b"]);
  assert.equal(third[0].commentRateSourceCount,1);
  assert.equal(third[0].pointDelta,null);
  const fourth=buildRanking(sample(null,160),third,now+90000,now+60000);
  assert.ok(Number.isFinite(fourth[0].pointDelta));
});
test("ranking elapsed time uses the existing per-second clock and hidden rows are not mislabeled NEW",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
  const block=source.slice(source.indexOf("function renderIndependentRanking("),source.indexOf("async function refreshIndependentRanking("));
  assert.match(block,/elapsed\.className="live-broadcast-elapsed"/);
  assert.match(block,/elapsed\.dataset\.startedAt=item\.startedAt/);
  const now=1700000000000;
  const rows=Array.from({length:200},(_,i)=>({liveId:"lv"+(100000+i),title:"番組"}));
  const first=buildRanking([{id:"a",ok:true,rows}],[],now,0);
  const next=buildRanking([{id:"a",ok:true,rows:[{liveId:"lv999999",title:"番組"},...rows.slice(0,199)]}],first,now+30000,now);
  assert.equal(next.find(x=>x.liveId==="lv999999").rankNew,false);
});


test("ranking watch links supply only a single trusted thumbnail without changing structured membership",()=>{
  const thumb="https://live.cdn.nimg.jp/thumb/program.jpg";
  const icon="https://cdn.nimg.jp/usericon/123.jpg";
  const link=(id,content)=>'<a href="https://live.nicovideo.jp/watch/'+id+'" title="番組">'+content+'</a>';
  const rows=parseRankingPage(page([program("lv123456"),{...program("lv234567"),status:"ENDED"}])+
    link("lv123456",'<img class="avatar" src="'+icon+'"><img data-src="'+thumb+'" src="https://evil.example/pixel">')+
    link("lv234567",'<img src="'+thumb+'">')+
    link("lv345678",'<img src="'+thumb+'">'));
  assert.deepEqual(rows.map(r=>r.liveId),["lv123456"]);
  assert.equal(rows[0].thumbnailUrl,thumb);
  assert.equal(rows[0].iconUrl,"");
});
test("HTML-only ranking rejects untrusted and ambiguous thumbnails",()=>{
  const link=(id,content)=>'<a href="https://live.nicovideo.jp/watch/'+id+'" title="番組">'+content+'</a>';
  const rows=parseRankingPage(link("lv123456",'<img data-src="https://cdn.nimg.jp/a.jpg">')+
    link("lv234567",'<img src="https://evil.example/a.jpg">')+
    link("lv345678",'<img src="https://cdn.nimg.jp/a.jpg"><img src="https://cdn.nimg.jp/b.jpg">')+
    link("lv456789",'<img src="https://cdn.nimg.jp/usericon/123.jpg">'));
  assert.deepEqual(rows.map(r=>r.thumbnailUrl),["https://cdn.nimg.jp/a.jpg","","",""]);
});


test("ranking JSON understands official provider identifiers, rejects explicit channels and preserves official artwork",()=>{
  const provider={name:"配信者",programProviderType:"user",programProviderId:"123456"};
  const p={id:"lv123456",title:"番組",beginTime:1700000000,programProvider:provider,thumbnail:{huge:"https://cdn.nimg.jp/thumb.jpg"}};
  const [row,channel]=parseRankingPage(page([p,{...p,id:"lv234567",programProvider:{...provider,programProviderType:"channel",id:"654321"}}]));
  assert.equal(row.broadcasterId,"123456");
  assert.equal(row.startedAt,new Date(1700000000000).toISOString());
  assert.equal(row.thumbnailUrl,p.thumbnail.huge);
  assert.equal(channel.broadcasterId,"");
});
test("cross-source duplicate metadata never fills artwork from a conflicting provider",()=>{
  const a={id:"a",ok:true,rows:[{liveId:"lv123456",title:"番組",broadcasterId:"123456",comments:10}]};
  const b={id:"b",ok:true,rows:[{liveId:"lv123456",title:"番組",broadcasterId:"654321",name:"別人",iconUrl:"https://cdn.nimg.jp/other.jpg",comments:20}]};
  const [row]=buildRanking([a,b]);
  assert.equal(row.broadcasterId,"123456");
  assert.ok(!row.name);
  assert.ok(!row.iconUrl);
  assert.equal(row.comments,20);
});
test("official enrichment does not keep conflicting artwork when verified supplier changes",async()=>{
  const {createRankingDetailEnricher}=require("../electron/live-ranking.cjs");
  const enrich=createRankingDetailEnricher(async(url)=>{
    if(url.includes("/watch/"))return {ok:true,text:async()=>officialPage({nicoliveProgramId:"lv123456",title:"番組",supplier:{type:"user",id:"654321",name:"正しい配信者"}})};
    return {ok:false,status:404};
  });
  const [row]=await enrich([{liveId:"lv123456",title:"番組",name:"別人",broadcasterId:"123456",iconUrl:"https://cdn.nimg.jp/other.jpg"}]);
  assert.equal(row.broadcasterId,"654321");
  assert.equal(row.name,"正しい配信者");
  assert.equal(row.iconUrl,"");
});
test("official watch payload uses top-level supplier only for the matching declared program",()=>{
  const {parseOfficialRankingDetails}=require("../electron/live-ranking.cjs");
  const payload={program:{nicoliveProgramId:"lv123456",title:"番組"},supplier:{type:"user",id:"123456",name:"配信者"}};
  const html='<script id="embedded-data" data-props="'+JSON.stringify(payload).replace(/&/g,"&amp;").replace(/"/g,"&quot;")+'"></script>';
  assert.equal(parseOfficialRankingDetails(html,"lv123456").broadcasterId,"123456");
  assert.equal(parseOfficialRankingDetails(html,"lv999999"),null);
});


test("composite ranking uses all four indicators and distinguishes missing from measured zero",()=>{
  const {applyCompositeScores}=require("../electron/live-ranking.cjs");
  const rows=applyCompositeScores([
    {points:100,visitors:100,comments:100,commentRate:10},
    {points:100,visitors:0,comments:0,commentRate:0},
    {points:100,visitors:null,comments:null,commentRate:null}
  ]);
  assert.ok(rows[0].compositeScore>rows[1].compositeScore);
  assert.equal(rows[0].scoreCoverage,100);
  assert.equal(rows[2].scoreCoverage,35);
  assert.equal(rows[2].scoreParts.visitors,null);
  assert.equal(rows[1].scoreParts.visitors,0);
  for(const field of ["points","visitors","comments","commentRate"])assert.ok(rows[0].scoreParts[field]>0);
});
test("ranking activity counts unique live commenters only, expires samples and resets at disconnect",()=>{
  const {createRankingActivityTracker}=require("../electron/live-ranking.cjs");
  let now=1700000000000;
  const tracker=createRankingActivityTracker(()=>now);
  tracker.state("lv123456",true);
  const event={liveId:"lv123456",type:"comment",userId:"a",isHistory:false};
  tracker.observe(event);tracker.observe(event);
  tracker.observe({...event,userId:"b",isHistory:true});
  tracker.observe({...event,userId:"c",liveId:"lv234567"});
  tracker.observe({...event,userId:"d"});
  assert.equal(tracker.snapshot("lv123456").count,2);
  assert.equal(tracker.snapshot("lv123456").complete,false);
  assert.equal(tracker.snapshot("lv234567"),null);
  now+=300001;
  assert.equal(tracker.snapshot("lv123456").count,0);
  assert.equal(tracker.snapshot("lv123456").complete,true);
  tracker.state("lv123456",false);
  assert.equal(tracker.snapshot("lv123456"),null);
});


test("active commenter expiry follows latest observation without scanning all active IDs",()=>{
  const {createRankingActivityTracker}=require("../electron/live-ranking.cjs");
  let now=1700000000000;
  const tracker=createRankingActivityTracker(()=>now);
  tracker.state("lv123456",true);
  const observe=id=>tracker.observe({liveId:"lv123456",type:"comment",userId:id});
  observe("a");now+=1000;observe("b");now+=1000;observe("a");
  now+=299000;
  assert.equal(tracker.snapshot("lv123456").count,1);
  now+=1000;
  assert.equal(tracker.snapshot("lv123456").count,0);
  observe("c");now-=1000;
  assert.equal(tracker.snapshot("lv123456"),null);
  tracker.state("lv123456",true);
  assert.equal(tracker.snapshot("lv123456").complete,false);
});
test("ranking activity is not exposed while recording or comment termination is underway",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","electron/main.cjs"),"utf8");
  assert.match(source,/provider&&commentWriter&&!captureStopPromise&&!commentFinalizing&&!timeshiftCommentFetchActive\?rankingActivity\.snapshot/);
});
