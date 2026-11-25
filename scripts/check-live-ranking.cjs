"use strict";
// Public network smoke check. Only emit counts and source errors;
// never output user credentials, full response bodies or program titles.
const {createRankingService}=require("../electron/live-ranking.cjs");
(async()=>{
  const snapshot=await createRankingService()();
  console.log(JSON.stringify({checkedAt:snapshot.checkedAt,stale:snapshot.stale,partial:snapshot.partial,
    programs:snapshot.rows.length,withVisitors:snapshot.rows.filter(x=>x.visitors!=null).length,
    withComments:snapshot.rows.filter(x=>x.comments!=null).length,withIcons:snapshot.rows.filter(x=>x.iconUrl).length,withThumbnails:snapshot.rows.filter(x=>x.thumbnailUrl).length,sources:snapshot.sources},null,2));
  if(snapshot.stale){console.error("No public ranking sources could be parsed in this environment.");process.exitCode=1;}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
