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

test("reference card parser matches sibling image only in unique program container",()=>{
 const {parseRankingCardImages}=require("../electron/live-ranking.cjs");
 const html='<div><article><img src="https://live.simg.jp/live/a.jpg"><a href="https://live.nicovideo.jp/watch/lv123456">A</a></article><article><img src="https://cdn.nimg.jp/usericon/a.jpg"><a href="https://live.nicovideo.jp/watch/lv234567">B</a></article><article><img src="https://live.simg.jp/live/c.jpg"><a href="https://live.nicovideo.jp/watch/lv345678">C</a><a href="https://live.nicovideo.jp/watch/lv456789">D</a></article></div>';
 const result=parseRankingCardImages(html);
 assert.equal(result.get("lv123456"),"https://live.simg.jp/live/a.jpg");
 assert.equal(result.has("lv234567"),false);assert.equal(result.has("lv345678"),false);assert.equal(result.has("lv456789"),false);
});
test("official image fallback tries distinct second URL after first returns 404",async()=>{
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
   if(url.includes("/watch/")){
     const data=JSON.stringify({program:{nicoliveProgramId:"lv123456",title:"番組",thumbnail:{screenshot:{large:"https://live.simg.jp/old.jpg",small:"https://live.simg.jp/new.jpg"}}}}).replaceAll('"',"&quot;");
     return new Response('<script id="embedded-data" data-props="'+data+'"></script>');
   }
   if(url.endsWith("old.jpg"))return new Response("missing",{status:404});
   assert.ok(url.endsWith("new.jpg"));
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456"}]);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
});

test("all one hundred ranked programs receive a bounded image attempt and retain their successful poster",async()=>{
 let now=100000,calls=0,active=0,maxActive=0;
 const proxy=createRankingImageProxy({now:()=>now,fetchImpl:async url=>{
   calls++;active++;maxActive=Math.max(maxActive,active);
   await new Promise(r=>setImmediate(r));active--;
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 const rows=Array.from({length:100},(_,i)=>({liveId:"lv"+(123456+i),thumbnailUrl:"https://live.simg.jp/live/"+i+".jpg"}));
 proxy.update(rows);
 for(let i=0;i<25;i++){await proxy.prefetch();now+=10000;}
 assert.equal(calls,100);assert.ok(maxActive<=4);
 assert.ok(rows.every(r=>proxy.status(r.liveId).revision>0));
 assert.match(await proxy.get(rows[99].liveId,"poster"),/^data:image\/jpeg;base64,/);
 proxy.update(rows.slice(0,99));assert.equal(await proxy.get(rows[99].liveId,"poster"),null);
});
test("failed images do not monopolize queue; unattempted lower ranks take precedence",async()=>{
 let now=100000;
 const proxy=createRankingImageProxy({now:()=>now,fetchImpl:async url=>{
   if(url.includes("watch/")||url.includes("/bad"))return new Response("missing",{status:404});
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 const rows=Array.from({length:8},(_,i)=>({liveId:"lv"+(123456+i),thumbnailUrl:"https://live.simg.jp/"+(i<4?"bad":"good")+i+".jpg"}));
 proxy.update(rows);await proxy.prefetch();now+=100000;await proxy.prefetch();
 assert.ok(rows.slice(0,4).every(r=>proxy.status(r.liveId).attempted&&!proxy.status(r.liveId).revision));
 assert.ok(rows.slice(4).every(r=>proxy.status(r.liveId).revision>0));
});
test("official program providerType verifies user for broadcast history",()=>{
 const {parseOfficialRankingDetails}=require("../electron/live-ranking.cjs");
 const data=JSON.stringify({program:{nicoliveProgramId:"lv123456",title:"番組",providerType:"user",supplier:{programProviderId:"123456"}}}).replaceAll('"',"&quot;");
 const row=parseOfficialRankingDetails('<script id="embedded-data" data-props="'+data+'"></script>',"lv123456");
 assert.equal(row.broadcasterId,"123456");
});

test("hover preview result never replaces or blocks the ordinary poster cache",async()=>{
 let now=100000,calls=0;
 const proxy=createRankingImageProxy({now:()=>now,fetchImpl:async url=>{
   calls++;
   if(url.includes("/watch/"))return new Response("missing",{status:404});
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456",thumbnailUrl:"https://live.simg.jp/live/sample.jpg"}]);
 assert.equal(await proxy.get("lv123456","preview"),null);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
 assert.equal(calls,2);
 assert.ok(proxy.status("lv123456").revision>0);
 assert.match(await proxy.get("lv123456","poster"),/^data:image\/jpeg;base64,/);
});

test("explicit Chikuwa listing screenshot can be fetched through the bounded image proxy",async()=>{
 const url="https://www.chikuwachan.com/live/images/lv123456.jpg";
 const proxy=createRankingImageProxy({fetchImpl:async(value,options)=>{
   assert.equal(value,url);assert.equal(options.headers.Referer,"https://www.chikuwachan.com/live/NCU/");
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456",thumbnailUrl:url}]);
 assert.match(await proxy.get("lv123456",url),/^data:image\/jpeg;base64,/);
 assert.equal(await proxy.get("lv123456","https://www.chikuwachan.com/live/usericon/a.jpg"),null);
});

test("user broadcast history can recover exact current image even if official watch page is unavailable",async()=>{
 const image="https://live.simg.jp/live/user.jpg";
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
   if(url.includes("/watch/"))return new Response("missing",{status:404});
   if(url.includes("/user-broadcast-history")){
     assert.match(url,/providerId=123/);
     return new Response(JSON.stringify({data:{programsList:[{id:{value:"lv999999"},thumbnail:{screenshot:"https://live.simg.jp/wrong.jpg"}},{id:{value:"lv123456"},thumbnail:{screenshot:{large:image}}}]}}));
   }
   assert.equal(url,image);
   return new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
 }});
 proxy.update([{liveId:"lv123456",broadcasterId:"123"}]);
 assert.match(await proxy.get("lv123456",""),/^data:image\/jpeg;base64,/);
});
