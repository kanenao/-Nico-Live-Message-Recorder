"use strict";
const {rankingImageUrl}=require("./live-ranking.cjs");
const MAX=1024*1024;
async function fetchRankingImage(url,fetchImpl=globalThis.fetch){
  const safe=rankingImageUrl(url);
  if(!safe)return null;
  try{
    const r=await fetchImpl(safe,{redirect:"error",signal:AbortSignal.timeout(7000),headers:{Referer:"https://live.nicovideo.jp/",Accept:"image/jpeg,image/png,image/webp,image/gif,image/avif"}});
    const type=(r.headers?.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(!r.ok||!/^image\/(?:jpeg|png|webp|gif|avif)$/.test(type)||Number(r.headers.get("content-length")||0)>MAX){await r.body?.cancel();return null;}
    if(!r.body?.getReader)return null;
    const reader=r.body.getReader(),chunks=[];let size=0;
    try{
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX){await reader.cancel();return null;}chunks.push(Buffer.from(value));}
    }finally{reader.releaseLock();}
    const b=Buffer.concat(chunks);
    const ascii=(a,z)=>b.subarray(a,z).toString("ascii");
    const valid=type==="image/jpeg"?b[0]===255&&b[1]===216&&b[2]===255:
      type==="image/png"?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      type==="image/webp"?ascii(0,4)==="RIFF"&&ascii(8,12)==="WEBP":
      type==="image/gif"?/^GIF8[79]a$/.test(ascii(0,6)):
      ascii(4,8)==="ftyp"&&/^(avif|avis)$/.test(ascii(8,12));
    return valid?"data:"+type+";base64,"+b.toString("base64"):null;
  }catch{return null;}
}
function createRankingImageProxy({fetchImpl=globalThis.fetch,now=Date.now}={}){
  let allowed=new Map();const cache=new Map(),pending=new Map();
  function update(rows){
    allowed=new Map(rows.map(r=>[r.liveId,new Set([r.thumbnailUrl,...(r.thumbnailCandidates||[])].map(rankingImageUrl).filter(Boolean))]));
  }
  async function get(id,url){
    const safe=rankingImageUrl(url);
    if(!safe||!allowed.get(id)?.has(safe))return null;
    const key=id+" "+safe,old=cache.get(key),at=now();
    if(old&&at>=old.at&&at-old.at<30000)return old.data;
    if(pending.has(key))return pending.get(key);
    if(pending.size>=4)return null;
    const task=fetchRankingImage(safe,fetchImpl).then(data=>{
      cache.delete(key);cache.set(key,{at:now(),data});
      while(cache.size>24)cache.delete(cache.keys().next().value);
      return allowed.get(id)?.has(safe)?data:null;
    }).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  }
  return {update,get};
}
module.exports={fetchRankingImage,createRankingImageProxy};
