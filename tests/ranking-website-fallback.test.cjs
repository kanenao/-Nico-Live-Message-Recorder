"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {fetchRankingImage,createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456",site="https://kanachin-app-collection.kanenao0224.workers.dev/api/live-thumbnail?service=nico&id="+id;
const jpeg=(n=4)=>{const bytes=new Uint8Array(n);bytes.set([255,216,255,217]);return new Response(bytes,{headers:{"Content-Type":"image/jpeg"}});};
test("website fallback uses only the currently listed public live ID after direct failure",async()=>{
 const calls=[];
 const proxy=createRankingImageProxy({websiteFallback:true,fetchImpl:async(url,opts)=>{
  calls.push(url);assert.equal(opts.headers.cookie,undefined);assert.equal(opts.headers.authorization,undefined);
  return url===site?jpeg():new Response(null,{status:404});
 }});
 proxy.update([{liveId:id}]);
 assert.equal(await proxy.get("lv999999",""),null);
 assert.equal(await proxy.get(id,site),null);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.deepEqual(calls,["https://live.nicovideo.jp/watch/"+id,site]);
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
