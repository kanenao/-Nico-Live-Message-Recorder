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

test("program-ID fallback fetches official screenshot without an existing URL",async()=>{
 const image="https://live.simg.jp/live/fresh.jpg";
 const calls=[];
 const proxy=createRankingImageProxy({fetchImpl:async(url,opts)=>{
   calls.push(url);
   if(url==="https://live.nicovideo.jp/watch/lv123456"){
     const data=JSON.stringify({program:{nicoliveProgramId:"lv123456",title:"番組",thumbnail:{screenshot:{large:image}}}}).replaceAll('"',"&quot;");
     return new Response('<script id="embedded-data" data-props="'+data+'"></script>');
   }
   assert.equal(url,image);assert.equal(opts.headers.Referer,"https://live.nicovideo.jp/");
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456"}]);
 assert.equal(await proxy.get("lv999999",""),null);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
 assert.equal(calls.length,2);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
 assert.equal(calls.length,2);
});
test("program-ID fallback tries verified user broadcast history if image candidates fail",async()=>{
 const bad="https://live.simg.jp/live/old.jpg",good="https://live.simg.jp/live/new.jpg";
 const proxy=createRankingImageProxy({fetchImpl:async(url)=>{
   if(url.includes("/watch/")){
     const data=JSON.stringify({program:{nicoliveProgramId:"lv123456",title:"番組",supplier:{supplierType:"user",programProviderId:"123456"},thumbnail:{screenshot:bad}}}).replaceAll('"',"&quot;");
     return new Response('<script id="embedded-data" data-props="'+data+'"></script>');
   }
   if(url===bad)return new Response("missing",{status:404});
   if(url.includes("/user-broadcast-history"))return new Response(JSON.stringify({data:{programsList:[{id:{value:"lv123456"},thumbnail:{screenshot:good}}]}}));
   assert.equal(url,good);
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456"}]);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
});

test("hover preview refreshes the official image after two seconds without expanding allowed IDs",async()=>{
 let now=100000,calls=0;
 const proxy=createRankingImageProxy({now:()=>now,fetchImpl:async(url)=>{
   calls++;
   if(url.includes("/watch/")){
     const data=JSON.stringify({program:{nicoliveProgramId:"lv123456",title:"番組",thumbnail:{screenshot:"https://live.simg.jp/live/fresh.jpg"}}}).replaceAll('"',"&quot;");
     return new Response('<script id="embedded-data" data-props="'+data+'"></script>');
   }
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456"}]);
 assert.equal(await proxy.get("lv999999","preview"),null);
 await proxy.get("lv123456","preview");assert.equal(calls,2);
 now+=1000;await proxy.get("lv123456","preview");assert.equal(calls,2);
 now+=1000;await proxy.get("lv123456","preview");assert.equal(calls,4);
 proxy.update([]);assert.equal(await proxy.get("lv123456","preview"),null);
});
