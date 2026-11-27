"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {fetchRankingImage,createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456",site="https://kanachin-app-collection.kanenao0224.workers.dev/api/live-thumbnail?service=nico&id="+id;
const jpeg=(n=4)=>{const bytes=new Uint8Array(n);bytes.set([255,216,255,217]);return new Response(bytes,{headers:{"Content-Type":"image/jpeg"}});};
test("website primary uses only the currently listed public live ID and supports preview",async()=>{
 const calls=[];
 const proxy=createRankingImageProxy({websiteFallback:true,fetchImpl:async(url,opts)=>{
  calls.push(url);assert.equal(opts.headers.cookie,undefined);assert.equal(opts.headers.authorization,undefined);
  assert.equal(opts.cache,"no-store");
  return url.startsWith(site+"&")?jpeg():new Response(null,{status:404});
 }});
 proxy.update([{liveId:id}]);
 assert.equal(await proxy.get("lv999999",""),null);
 assert.equal(await proxy.get(id,site),null);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.equal(calls.length,1);assert.match(calls[0],/\/api\/live-thumbnail\?service=nico&id=lv123456&slot=\d+$/);
 assert.match(await proxy.get(id,"preview"),/^data:image\/jpeg;base64,/);
 assert.equal(calls.length,2);assert.ok(calls[1].startsWith(site+"&preview=1&slot="));
 assert.ok(proxy.status(id).revision>0);
});
test("website endpoint cannot redirect or return HTML disguised as an image",async()=>{
 const redirect=await fetchRankingImage(site,async()=>new Response(null,{status:302,headers:{location:"https://live.simg.jp/live/a.jpg"}}),id);
 assert.equal(redirect,null);
 assert.equal(await fetchRankingImage(site,async()=>new Response("HTML",{headers:{"Content-Type":"image/jpeg"}}),id),null);
 assert.equal(await fetchRankingImage(site,async()=>{throw Error("unexpected network")}),null);
});
test("4 MiB website-size image is accepted, larger images are rejected",async()=>{
 const url="https://live.simg.jp/live/a.jpg";
 assert.match(await fetchRankingImage(url,async()=>jpeg(2*1024*1024)),/^data:image\/jpeg;base64,/);
 assert.equal(await fetchRankingImage(url,async()=>jpeg(4*1024*1024+1)),null);
});

test("direct official lookup still works when website returns 404",async()=>{
 const calls=[],image="https://live.simg.jp/live/fresh.jpg";
 const proxy=createRankingImageProxy({websiteFallback:true,fetchImpl:async url=>{
  calls.push(url);
  if(url.startsWith(site+"&slot="))return new Response(null,{status:404});
  if(url.includes("/watch/"))return new Response('<script id="embedded-data" data-props="'+JSON.stringify({program:{id,title:"番組",thumbnail:{screenshot:image}}}).replaceAll('"',"&quot;")+'"></script>');
  return url===image?jpeg():new Response(null,{status:404});
 }});
 proxy.update([{liveId:id}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.equal(calls.length,3);assert.ok(calls[0].startsWith(site+"&slot="));assert.equal(calls[2],image);
});
