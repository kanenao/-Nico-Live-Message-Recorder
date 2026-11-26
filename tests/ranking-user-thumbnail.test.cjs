"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {parseRankingPage,parseChikuwaUserHints,extractJsonRows,parseOfficialRankingDetails,programThumbnailCandidates}=require("../electron/live-ranking.cjs");
const {createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const source="https://www.chikuwachan.com/live/NCU/";
const id="lv123456",user="12345678",other="lv123457";
const card=(liveId,label)=>'<article><img alt="'+label+'"><a href="https://live.nicovideo.jp/watch/'+liveId+'">番組タイトル</a></article>';
test("Chikuwa user hint is scoped to one program, not a verified broadcaster ID",()=>{
 const html=card(id,"NCU_"+user)+card(other,"NCU_ch12345");
 const rows=parseRankingPage(html,source);
 assert.equal(rows.length,2);
 assert.equal(rows[0].thumbnailHistoryUserId,user);
 assert.equal(rows[0].broadcasterId,"");
 assert.equal(rows[1].thumbnailHistoryUserId,undefined);
 assert.equal(parseRankingPage(html)[0].thumbnailHistoryUserId,undefined);
 assert.equal(parseChikuwaUserHints(card(id,"NCU_"+user)+card(id,"NCU_87654321")).has(id),false);
});
test("user hint enables exact program history thumbnail even when watch page fails",async()=>{
 const good="https://live.simg.jp/live/current.jpg",bad="https://live.simg.jp/live/other.jpg";
 const seen=[];
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
  seen.push(url);
  if(url.includes("user-broadcast-history")){
   assert.equal(new URL(url).searchParams.get("providerId"),user);
   return Response.json({data:{programsList:[{id:{value:other},program:{thumbnail:{screenshot:bad}}},{id:{value:id},program:{thumbnail:{screenshot:good}}}]}});
  }
  if(url===good)return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
  return new Response("missing",{status:404});
 }});
 proxy.update(parseRankingPage(card(id,"NCU_"+user),source));
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.ok(!seen.includes(bad));
});
test("split provider types and wrapped IDs recover user thumbnails without accepting channels",()=>{
 const thumb={screenshot:{urls:{large:{uri:"https://live.simg.jp/live/current.jpg"}}}};
 const row=(id,providerType,supplier)=>({program:{id,title:"live",providerType,thumbnail:thumb},supplier});
 const rows=extractJsonRows([row(id,"user",{programProviderId:user}),row(other,"channel",{id:user}),row("lv123458","channel",{programProviderType:"user",programProviderId:user})]);
 assert.equal(rows[0].broadcasterId,user);
 assert.equal(rows[1].broadcasterId,"");
 assert.equal(rows[2].broadcasterId,"");
 assert.deepEqual(programThumbnailCandidates({thumbnail:thumb}),["https://live.simg.jp/live/current.jpg"]);
 const data=JSON.stringify({program:{id:{value:id},title:"live",providerType:"user",thumbnail:thumb},supplier:{programProviderId:user}}).replaceAll('"',"&quot;");
 const html='<script id="embedded-data" data-props="'+data+'"></script>';
 assert.equal(parseOfficialRankingDetails(html,id).broadcasterId,user);
 assert.equal(parseOfficialRankingDetails(html,other),null);
});
