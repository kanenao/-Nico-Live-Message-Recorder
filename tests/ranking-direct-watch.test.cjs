"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {parseOfficialRankingDetails}=require("../electron/live-ranking.cjs");
const {createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
const id="lv123456",shot="https://live.simg.jp/live/shot.jpg",old="https://live.simg.jp/live/old.jpg",poster="https://live.nicovideo.jp/liveimg/poster.jpg";
const page=(p,extra="")=>'<script id="embedded-data" data-props="'+JSON.stringify({program:p}).replaceAll('"',"&quot;")+'"></script>'+extra;
const jpg=()=>new Response(Buffer.from([255,216,255,217]),{headers:{"Content-Type":"image/jpeg"}});
test("website direct screenshot and relative OGP precede generic program artwork",()=>{
 const html=page({id:123456,thumbnail:{screenshot:shot,small:old}},'<meta property="og:url" content="https://live.nicovideo.jp/watch/'+id+'"><meta property="og:image" content="/liveimg/poster.jpg">');
 const d=parseOfficialRankingDetails(html,id);
 assert.deepEqual(d.directThumbnailCandidates,[shot,poster]);assert.equal(d.thumbnailUrl,shot);
 assert.equal(parseOfficialRankingDetails(html,"lv123457"),null);
 assert.equal(parseOfficialRankingDetails(html.replace("watch/"+id,"watch/lv123457"),id),null);
});
test("official direct screenshot wins over a working but older ranking image",async()=>{
 const seen=[];
 const proxy=createRankingImageProxy({fetchImpl:async url=>{seen.push(url);return url.includes("/watch/")?new Response(page({id,title:"live",thumbnail:{screenshot:shot}})):jpg();}});
 proxy.update([{liveId:id,thumbnailUrl:old}]);
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.deepEqual(seen,["https://live.nicovideo.jp/watch/"+id,shot]);
});
test("saved source is retried after watch failure and is cleared on removal",async()=>{
 let at=1000,good=true;const seen=[];
 const proxy=createRankingImageProxy({now:()=>at,fetchImpl:async url=>{
  seen.push(url);
  if(url.includes("/watch/"))return good?new Response(page({id,title:"live",thumbnail:{screenshot:shot}})):new Response(null,{status:404});
  return jpg();
 }});
 proxy.update([{liveId:id}]);await proxy.get(id,"");good=false;at+=31000;
 assert.match(await proxy.get(id,""),/^data:image\/jpeg;base64,/);
 assert.deepEqual(seen.slice(-2),["https://live.nicovideo.jp/watch/"+id,shot]);
 proxy.update([]);proxy.update([{liveId:id}]);at+=3000;
 assert.equal(await proxy.get(id,"preview"),null);
});
