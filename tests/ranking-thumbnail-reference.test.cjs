"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {programThumbnailCandidates,parseNicoFeedImages,mergeNicoFeedImages}=require("../electron/live-ranking.cjs");
const {fetchRankingImage,createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const image="https://live.simg.jp/live/sample.jpg?signature=a%2Fb";
test("reference thumbnail.screenshot supports string and size object",()=>{
 assert.deepEqual(programThumbnailCandidates({thumbnail:{screenshot:{large:image},small:"https://cdn.nimg.jp/static.jpg"}}),[image,"https://cdn.nimg.jp/static.jpg"]);
 assert.deepEqual(programThumbnailCandidates({thumbnail:{screenshot:image}}),[image]);
});
test("RSS thumbnail joins only by explicit program ID",()=>{
 const map=parseNicoFeedImages('<rss><item><link>https://live.nicovideo.jp/watch/lv123456</link><media:thumbnail url="'+image+'"/></item><item><link>https://evil.example/watch/lv987654</link><media:thumbnail url="'+image+'"/></item></rss>');
 const rows=mergeNicoFeedImages([{liveId:"lv123456"},{liveId:"lv987654"}],map);
 assert.equal(rows[0].thumbnailUrl,image);assert.equal(rows[1].thumbnailUrl,undefined);
});
test("official referer proxy preserves signed URL and rejects nonimage data",async()=>{
 const fetchImpl=async(url,options)=>{assert.equal(url,image);assert.equal(options.headers.Referer,"https://live.nicovideo.jp/");assert.equal(options.redirect,"error");return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});};
 assert.match(await fetchRankingImage(image,fetchImpl),/^data:image\/jpeg;base64,/);
 assert.equal(await fetchRankingImage("https://evil.example/a.jpg",fetchImpl),null);
 assert.equal(await fetchRankingImage(image,async()=>new Response("html",{headers:{"Content-Type":"image/jpeg"}})),null);
 assert.equal(await fetchRankingImage(image,async()=>new Response(new Uint8Array(1048577),{headers:{"Content-Type":"image/jpeg"}})),null);
});
test("image proxy restricts URLs to current program and deduplicates requests",async()=>{
 let calls=0;const proxy=createRankingImageProxy({fetchImpl:async()=>{calls++;return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});}});
 proxy.update([{liveId:"lv123456",thumbnailUrl:image}]);
 assert.equal(await proxy.get("lv999999",image),null);
 assert.equal(await proxy.get("lv123456",image+"x"),null);
 const values=await Promise.all([proxy.get("lv123456",image),proxy.get("lv123456",image)]);
 assert.equal(values[0],values[1]);assert.equal(calls,1);
 proxy.update([]);assert.equal(await proxy.get("lv123456",image),null);
});
