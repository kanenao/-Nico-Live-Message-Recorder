"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456";
const image=n=>"https://live.simg.jp/live/"+n+".jpg";
const jpeg=()=>new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
const missing=()=>new Response("missing",{status:404});
test("channel image fallback skips already attempted URLs and tries remaining official artwork",async()=>{
 const seen=[];
 const proxy=createRankingImageProxy({fetchImpl:async url=>{
  seen.push(url);
  if(url.includes("/watch/")){
   const data=JSON.stringify({program:{id,title:"channel live",providerType:"channel",thumbnail:{screenshot:{large:image(1),middle:image(2),small:image(3)}}}}).replaceAll('"',"&quot;");
   return new Response('<script id="embedded-data" data-props="'+data+'"></script>');
  }
  return url===image(3)?jpeg():missing();
 }});
 proxy.update([{liveId:id,thumbnailUrl:image(1),thumbnailCandidates:[image(2)]}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.equal(seen.filter(u=>u===image(1)).length,1);
 assert.equal(seen.filter(u=>u===image(2)).length,1);
 assert.ok(seen.includes(image(3)));
});
test("new listing image invalidates negative result for same live ID",async()=>{
 const proxy=createRankingImageProxy({now:()=>1000,fetchImpl:async url=>url===image(3)?jpeg():missing()});
 proxy.update([{liveId:id}]);
 assert.equal(await proxy.get(id,""),null);
 proxy.update([{liveId:id,thumbnailUrl:image(3)}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
});
test("renderer accepts official thumbnail paths without allowing arbitrary official pages",()=>{
 const source=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
 const start=source.indexOf("function appendRankingImage("),end=source.indexOf("// One hover preview",start);
 const run=url=>{
  const img={addEventListener(){},remove(){}};
  const append=vm.runInNewContext(source.slice(start,end)+"\nappendRankingImage",{URL,Date,document:{createElement:()=>img}});
  append({dataset:{},appendChild(){}},url,"ranking-thumbnail","番組",[]);
  return img.src;
 };
 assert.equal(run("https://live.nicovideo.jp/liveimg/channel.jpg"),"https://live.nicovideo.jp/liveimg/channel.jpg");
 assert.equal(run("https://live.nicovideo.jp/watch/lv123456"),undefined);
 assert.equal(run("https://evil.example/liveimg/channel.jpg"),undefined);
});

test("static channel artwork may use nested thumbnail URL sets",()=>{
 const {programThumbnailCandidates}=require("../electron/live-ranking.cjs");
 assert.deepEqual(programThumbnailCandidates({thumbnail:{urlSet:{large:{url:image(1)}},urls:{small:image(2)}}}),[image(1),image(2)]);
});
