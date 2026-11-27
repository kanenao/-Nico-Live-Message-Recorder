"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {summarizeRankingCoverage}=require("../electron/ranking-coverage.cjs");
const {createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456",url="https://live.simg.jp/live/current.jpg";
const jpeg=()=>new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
test("coverage distinguishes provider groups, missing data and real zero",()=>{
 const rows=[{rank:1,liveId:id,broadcasterId:"123456",publicActive10m:0,adPoints:0,thumbnailUrl:url},{rank:2,liveId:"lv123457",channelOwner:"1234",giftPoints:5},{rank:3,liveId:"lv123458",broadcasterId:"123456",channelOwner:"1234"},{rank:101,liveId:"lv123459",broadcasterId:"234567"}];
 const c=summarizeRankingCoverage(rows,x=>({attempted:x===id,revision:x===id?1:0}));
 assert.equal(c.all.programs,3);assert.equal(c.user.programs,1);assert.equal(c.channel.programs,1);assert.equal(c.unknown.programs,1);
 assert.equal(c.user.publicActive10m,1);assert.equal(c.user.adPoints,1);assert.equal(c.channel.adPoints,0);assert.equal(c.channel.giftPoints,1);
 assert.equal(c.all.posterValidated,1);assert.equal(c.user.posterAttempted,1);assert.equal(c.channel.posterAttempted,0);
});
test("new provider identity clears a negative image cache before the retry interval",async()=>{
 const proxy=createRankingImageProxy({now:()=>1000,fetchImpl:async value=>{
  if(value.includes("user-broadcast-history"))return Response.json({data:{programsList:[{id,thumbnail:{screenshot:url}}]}});
  return value===url?jpeg():new Response(null,{status:404});
 }});
 proxy.update([{liveId:id}]);await proxy.prefetch();assert.equal(proxy.status(id).revision,0);
 proxy.update([{liveId:id,channelOwner:"1234"}]);await proxy.prefetch();assert.ok(proxy.status(id).revision>0);
});
test("departure invalidates cached previews and in-flight image responses",async()=>{
 let resolve;const proxy=createRankingImageProxy({now:()=>1000,fetchImpl:async()=>new Promise(r=>{resolve=r;})});
 proxy.update([{liveId:id,thumbnailUrl:url}]);const old=proxy.get(id,url);
 proxy.update([]);proxy.update([{liveId:id,thumbnailUrl:url}]);resolve(jpeg());
 assert.equal(await old,null);assert.equal(proxy.status(id).revision,0);
 const fresh=proxy.get(id,url);resolve(jpeg());assert.match(await fresh,/^data:image\/jpeg;base64,/);
 const preview=proxy.get(id,"preview");resolve(jpeg());assert.match(await preview,/^data:image\/jpeg;base64,/);
 proxy.update([]);proxy.update([{liveId:id,thumbnailUrl:url}]);
 assert.equal(await proxy.get(id,"preview"),null);
});
