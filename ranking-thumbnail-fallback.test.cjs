"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createRankingImageProxy}=require("./electron/ranking-image-proxy.cjs");
const id="lv123456",other="lv123457",user="123456";
const good="https://live-thumbnail.nimg.jp/liveimg/current.jpg",wrong="https://live-thumbnail.nimg.jp/liveimg/other.jpg";
const listing="https://www.chikuwachan.com/live/thumb/current.jpg";
const jpeg=()=>new Response(Uint8Array.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
const missing=()=>new Response("missing",{status:404});
test("watch failure still falls back to matching user history, not another program",async()=>{
 const seen=[];
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
  seen.push(url);
  if(url.includes("user-broadcast-history"))return Response.json({data:{programsList:[{program:{id:other,thumbnail:{screenshot:wrong}}},{program:{id,thumbnail:{screenshot:good}}}]}});
  if(url===good)return jpeg();
  return missing();
 }});
 proxy.update([{liveId:id,broadcasterId:user}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.ok(seen.some(u=>u.includes("user-broadcast-history")));
 assert.ok(!seen.includes(wrong));
 assert.ok(proxy.status(id).revision>0);
});
test("listing proxy uses the listing referer and rejects unlisted and profile URLs",async()=>{
 const seen=[];
 const proxy=createRankingImageProxy({fetchImpl:async(url,options)=>{
  seen.push([url,options.headers.Referer]);
  return url===listing?jpeg():missing();
 }});
 proxy.update([{liveId:id,thumbnailUrl:listing}]);
 assert.equal(await proxy.get(id,"https://www.chikuwachan.com/live/thumb/unlisted.jpg"),null);
 assert.equal(await proxy.get(id,"https://www.chikuwachan.com/live/profile.jpg"),null);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.deepEqual(seen.at(-1),[listing,"https://www.chikuwachan.com/live/NCU/"]);
 assert.ok(!seen.some(([u])=>u.includes("unlisted")||u.includes("profile")));
});
test("failed poster is retried after 30 seconds without starving unvisited programs",async()=>{
 let now=1000,requests=0;
 const proxy=createRankingImageProxy({now:()=>now,fetchImpl:async()=>{requests++;return missing();}});
 proxy.update([{liveId:id}]);
 await proxy.prefetch();const first=requests;assert.ok(first>0);
 now+=29999;await proxy.prefetch();assert.equal(requests,first);
 now++;await proxy.prefetch();assert.ok(requests>first);
});
