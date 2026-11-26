"use strict";
// Diagnostic only. No credentials, titles, or full response bodies in logs.
const {createRankingService,createRankingDetailEnricher,rankingListingImage}=require("../electron/live-ranking.cjs");
const {createRankingImageProxy}=require("../electron/ranking-image-proxy.cjs");
(async()=>{
  const snapshot=await createRankingService({feedImages:true})();
  const enrich=createRankingDetailEnricher(globalThis.fetch);
  let rows=snapshot.rows;
  const stages=[rows.filter(x=>x.thumbnailUrl).length];
  for(let i=0;i<4&&!snapshot.stale;i++){
    rows=await enrich(rows,true);
    stages.push(rows.filter(x=>x.thumbnailUrl).length);
  }
  const samples=[...new Set(rows.map(x=>x.thumbnailUrl).filter(Boolean))].slice(0,12);
  const checks=[];
  for(const candidate of samples){
    const url=rankingListingImage(candidate,"https://www.chikuwachan.com/live/NCU/");
    if(!url){checks.push("rejected");continue;}
    try{
      const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(4000),headers:{accept:"image/*",Referer:"https://live.nicovideo.jp/",range:"bytes=0-1023"}});
      const type=response.headers.get("content-type")||"";
      checks.push(response.ok&&/^image\/(?:jpeg|png|webp|gif)(?:;|$)/i.test(type)?"image-response":"HTTP "+response.status+" / "+type.split(";")[0].slice(0,60));
      await response.body?.cancel();
    }catch{checks.push("network-error");}
  }
  const proxy=createRankingImageProxy();
  proxy.update(rows.slice(0,100));
  for(let i=0;i<3&&!snapshot.stale;i++)await proxy.prefetch();
  const posterSamples=rows.slice(0,100).filter(x=>proxy.status(x.liveId).attempted);
  console.log(JSON.stringify({posterAttempted:posterSamples.length,posterValidated:posterSamples.filter(x=>proxy.status(x.liveId).revision>0).length,posterKnownUserAttempted:posterSamples.filter(x=>x.broadcasterId).length,posterKnownUserValidated:posterSamples.filter(x=>x.broadcasterId&&proxy.status(x.liveId).revision>0).length,checkedAt:snapshot.checkedAt,stale:snapshot.stale,partial:snapshot.partial,
    programs:rows.length,top100:rows.filter(x=>x.rank<=100).length,top100WithVisitors:rows.filter(x=>x.rank<=100&&x.visitors!=null).length,top100WithComments:rows.filter(x=>x.rank<=100&&x.comments!=null).length,top100WithUserIds:rows.filter(x=>x.rank<=100&&x.broadcasterId).length,top100WithThumbnails:rows.filter(x=>x.rank<=100&&x.thumbnailUrl).length,withVisitors:rows.filter(x=>x.visitors!=null).length,withComments:rows.filter(x=>x.comments!=null).length,
    withUserIds:rows.filter(x=>x.broadcasterId).length,withNames:rows.filter(x=>x.name).length,withIcons:rows.filter(x=>x.iconUrl).length,
    withThumbnails:rows.filter(x=>x.thumbnailUrl).length,thumbnailCoverageByBatch:stages,imageResponses:checks.filter(x=>x==="image-response").length,imageSampleCount:checks.length,imageChecks:checks,sources:snapshot.sources},null,2));
  if(snapshot.stale){console.error("No public ranking sources could be parsed in this environment.");process.exitCode=1;}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
