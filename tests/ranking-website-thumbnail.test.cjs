"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {rankingChannelOwner,extractJsonRows,programThumbnailCandidates,fetchUserRankingThumbnails}=require("../electron/live-ranking.cjs");
const {fetchRankingImage,createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456",other="lv123457",good="https://live.simg.jp/live/current.jpg",wrong="https://live.simg.jp/live/other.jpg";
const jpeg=()=>new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
test("website channel owner metadata is not a user identity",()=>{
 const row=extractJsonRows([{program:{id,title:"live",providerType:"channel"},supplier:{programProviderId:"ch1234",pageUrl:"https://ch.nicovideo.jp/ch1234"}}])[0];
 assert.equal(row.channelOwner,"1234");assert.equal(row.broadcasterId,"");
 assert.equal(rankingChannelOwner({providerType:"user",supplier:{programProviderId:"ch1234"}}),"");
 assert.equal(rankingChannelOwner({providerType:"channel",supplier:{programProviderId:"ch1234",url:"https://ch.nicovideo.jp/ch5678"}}),"");
});
test("channel history uses public v1 and requires exact program ID",async()=>{
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
  if(url.includes("user-broadcast-history")){
   const u=new URL(url);
   assert.ok(u.pathname.includes("/v1/"));assert.equal(u.searchParams.get("providerType"),"channel");assert.equal(u.searchParams.get("providerId"),"1234");
   return Response.json({data:{programsList:[{id:{value:other},program:{thumbnail:wrong}},{id:{value:id},program:{thumbnail:{screenshot:good}}}]}});
  }
  if(url===good)return jpeg();
  assert.notEqual(url,wrong);return new Response(null,{status:404});
 }});
 proxy.update([{liveId:id,channelOwner:"1234"}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
});
test("bounded redirect accepts official CDN only and rejects branding",async()=>{
 const calls=[];
 assert.match(await fetchRankingImage(wrong,async(url,opts)=>{calls.push(url);assert.equal(opts.redirect,"manual");return url===wrong?new Response(null,{status:302,headers:{location:good}}):jpeg();}),/^data:image\/jpeg;base64,/);
 assert.deepEqual(calls,[wrong,good]);
 assert.equal(await fetchRankingImage(wrong,async()=>new Response(null,{status:302,headers:{location:"https://evil.example/current.jpg"}})),null);
 assert.equal(await fetchRankingImage("https://live.simg.jp/default.jpg",async()=>{throw Error("must not fetch");}),null);
 assert.deepEqual(programThumbnailCandidates({thumbnail:{screenshot:{large:{src:good},small:"https://live.simg.jp/default.jpg"}}}),[good]);
});

test("channel NCF listing contributes only matching program artwork",async()=>{
 const {fetchChannelListingImages,mergeNicoFeedImages}=require("../electron/live-ranking.cjs");
 const images=await fetchChannelListingImages(async url=>{
  assert.equal(url,"https://www.chikuwachan.com/live/NCF/");
  return new Response('<a href="https://live.nicovideo.jp/watch/'+id+'" title="channel"><img src="/live/images/'+id+'.jpg"></a>');
 });
 assert.equal(images.get(id),"https://www.chikuwachan.com/live/images/"+id+".jpg");
 const rows=mergeNicoFeedImages([{liveId:id},{liveId:other}],images);
 assert.equal(rows[0].thumbnailUrl,images.get(id));assert.equal(rows[1].thumbnailUrl,undefined);
});
