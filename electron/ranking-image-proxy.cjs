"use strict";
const {rankingImageUrl,rankingListingImage,fetchOfficialRankingDetails,fetchUserRankingThumbnails,isRankingBrandImage}=require("./live-ranking.cjs");
const LISTING_URL="https://www.chikuwachan.com/live/NCU/";
function safePosterUrl(value){
  if(isRankingBrandImage(value))return "";
  return rankingImageUrl(value)||(typeof value==="string"&&value.startsWith("https://www.chikuwachan.com/")?rankingListingImage(value,LISTING_URL):"");
}
const MAX=1024*1024;
async function fetchRankingImage(url,fetchImpl=globalThis.fetch){
  const safe=safePosterUrl(url);
  if(!safe)return null;
  try{
    // Website worker follows a bounded redirect chain; revalidate every hop.
    const signal=AbortSignal.timeout(7000);
    let target=safe,r;
    for(let hop=0;hop<3;hop++){
      r=await fetchImpl(target,{redirect:"manual",signal,headers:{Referer:new URL(target).origin==="https://www.chikuwachan.com"?LISTING_URL:"https://live.nicovideo.jp/",Accept:"image/jpeg,image/png,image/webp,image/gif,image/avif"}});
      if(![301,302,303,307,308].includes(r.status))break;
      const location=r.headers?.get("location");await r.body?.cancel();
      if(!location||hop===2)return null;
      const next=safePosterUrl(new URL(location,target).href);
      if(!next||!rankingImageUrl(next))return null;
      target=next;
    }
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
  let allowed=new Map(),users=new Map(),channels=new Map(),topIds=new Set(),posterBytes=0,revision=0;const cache=new Map(),pending=new Map(),posters=new Map(),attempted=new Map();
  const POSTER_BUDGET=64*1024*1024;
  function dropPoster(id){const old=posters.get(id);if(old){posterBytes-=old.data.length;posters.delete(id);}}
  function storePoster(id,data){
    if(!topIds.has(id)||!data)return;
    const old=posters.get(id);if(old?.data===data){old.at=now();return;}
    dropPoster(id);
    posters.set(id,{data,at:now(),revision:++revision});posterBytes+=data.length;
    while(posterBytes>POSTER_BUDGET||posters.size>100)dropPoster(posters.keys().next().value);
  }
  function update(rows){
    const previous=allowed;
    allowed=new Map(rows.map(r=>[r.liveId,new Set([r.thumbnailUrl,...(r.thumbnailCandidates||[])].map(safePosterUrl).filter(Boolean))]));
    // Newly discovered program URLs should not be suppressed by a cached failure.
    for(const [id,urls] of allowed){
      if([...urls].some(url=>!previous.get(id)?.has(url))&&cache.get(id+" official")?.data===null){
        cache.delete(id+" official");
      }
    }
    users=new Map(rows.map(r=>[r.liveId,String(r.broadcasterId||r.thumbnailHistoryUserId||"")]).filter(([,id])=>/^\d{5,15}$/.test(id)));
    channels=new Map(rows.map(r=>[r.liveId,String(r.channelOwner||"")]).filter(([,id])=>/^[1-9]\d{0,14}$/.test(id)));
    topIds=new Set(rows.slice(0,100).map(r=>r.liveId));
    for(const id of posters.keys())if(!topIds.has(id))dropPoster(id);
    for(const id of attempted.keys())if(!topIds.has(id))attempted.delete(id);
  }
  async function get(id,url){
    // Empty URL requests a fresh official lookup for a currently listed program.
    // Never turn a renderer-supplied URL into an arbitrary network request.
    if(url==="poster")return topIds.has(id)?posters.get(id)?.data??null:null;
    const preview=url==="preview";
    const lookup=url===""||preview;
    const safe=lookup?"":safePosterUrl(url);
    if(!/^lv\d{5,15}$/.test(String(id))||!allowed.has(id)||(!lookup&&(!safe||!allowed.get(id).has(safe))))return null;
    const key=id+" "+(preview?"preview":lookup?"official":safe),old=cache.get(key),at=now();
    if(old&&at>=old.at&&at-old.at<(preview?2000:30000)){if(!preview&&old.data)storePoster(id,old.data);return old.data;}
    if(pending.has(key))return pending.get(key);
    if(lookup&&pending.has(id+" "+(preview?"official":"preview")))return null;
    if(pending.size>=4)return null;
    const load=async()=>{
      if(!lookup)return fetchRankingImage(safe,fetchImpl);
      const tried=new Set();
      async function attempt(values){
        for(const value of values){
          const candidate=safePosterUrl(value);
          if(!candidate||tried.has(candidate)||!allowed.has(id)||tried.size>=7)continue;
          if(!rankingImageUrl(candidate)&&!allowed.get(id).has(candidate))continue;
          tried.add(candidate);
          const data=await fetchRankingImage(candidate,fetchImpl);
          if(data)return data;
          if(tried.size>=7)break;
        }
        return null;
      }
      let data=null;
      const listed=[...allowed.get(id)||[]];
      if(!preview){data=await attempt(listed.filter(rankingImageUrl).slice(0,2));if(data)return data;}
      const details=await fetchOfficialRankingDetails(id,fetchImpl);
      if(!allowed.has(id))return null;
      if(details){
        const distinct=[...new Set([details.thumbnailUrl,...(details.thumbnailCandidates||[])].map(safePosterUrl).filter(Boolean))].filter(url=>!tried.has(url));
        data=await attempt(distinct.slice(0,3));
        if(data)return data;
      }
      // A temporary watch-page failure must not block exact-ID history lookup.
      // History results are accepted only when their program ID matches id.
      const channelOwner=details?.channelOwner||channels.get(id);
      const userId=details?.broadcasterId||users.get(id);
      if((channelOwner||userId)&&allowed.has(id)){
        data=await attempt((await fetchUserRankingThumbnails(channelOwner||userId,id,fetchImpl,channelOwner?"channel":"user")).slice(0,2));
        if(data)return data;
      }
      return preview?null:attempt([...listed.filter(url=>!rankingImageUrl(url)),...listed]);
    };
    const task=load().then(data=>{
      cache.delete(key);cache.set(key,{at:now(),data});
      while(cache.size>48)cache.delete(cache.keys().next().value);
      const accepted=allowed.has(id)&&(lookup||allowed.get(id).has(safe))?data:null;
      if(!preview&&accepted)storePoster(id,accepted);
      return accepted;
    }).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  }
  // One bounded batch per ranking refresh. Never let failed or high-ranked rows
  // monopolize the queue. In-flight requests share the same global four slots.
  function prefetch(){
    const at=now();
    const candidates=[...topIds].filter(id=>!pending.has(id+" official")&&!pending.has(id+" preview")&&(!attempted.has(id)||at<attempted.get(id)||at-attempted.get(id)>=(posters.has(id)?90000:30000)))
      .sort((a,b)=>(Number(attempted.has(a))-Number(attempted.has(b)))||(Number(posters.has(a))-Number(posters.has(b)))||((attempted.get(a)||0)-(attempted.get(b)||0)));
    const jobs=[];
    for(const id of candidates.slice(0,Math.max(0,4-pending.size))){
      attempted.set(id,at);jobs.push(get(id,""));
    }
    return Promise.all(jobs);
  }
  function status(id){return {revision:posters.get(id)?.revision??0,attempted:attempted.has(id)};}
  return {update,get,prefetch,status};
}
module.exports={fetchRankingImage,createRankingImageProxy};
