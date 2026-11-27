"use strict";
// Aggregate only: no program titles, account IDs, or signed image URLs.
function summarizeRankingCoverage(rows,status=()=>({})){
  const groups={user:[],channel:[],unknown:[]};
  const top=rows.filter(r=>Number.isInteger(r.rank)&&r.rank>=1&&r.rank<=100);
  for(const row of top){
    const user=Boolean(row.broadcasterId||row.thumbnailHistoryUserId),channel=Boolean(row.channelOwner);
    groups[user===channel?"unknown":channel?"channel":"user"].push(row);
  }
  const summarize=list=>{
    const states=list.map(r=>status(r.liveId)||{});
    return {programs:list.length,imageUrl:list.filter(r=>Boolean(r.thumbnailUrl)).length,
      posterAttempted:states.filter(s=>s.attempted).length,posterValidated:states.filter(s=>s.revision>0).length,
      visitors:list.filter(r=>Number.isSafeInteger(r.visitors)&&r.visitors>=0).length,
      comments:list.filter(r=>Number.isSafeInteger(r.comments)&&r.comments>=0).length,
      publicActive10m:list.filter(r=>Number.isSafeInteger(r.publicActive10m)&&r.publicActive10m>=0).length,
      adPoints:list.filter(r=>Number.isSafeInteger(r.adPoints)&&r.adPoints>=0).length,
      giftPoints:list.filter(r=>Number.isSafeInteger(r.giftPoints)&&r.giftPoints>=0).length};
  };
  return {all:summarize(top),...Object.fromEntries(Object.entries(groups).map(([type,list])=>[type,summarize(list)]))};
}
module.exports={summarizeRankingCoverage};
