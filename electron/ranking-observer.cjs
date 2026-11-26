"use strict";
const {createRankingActivityTracker,rankingImageUrl}=require("./live-ranking.cjs");

// Public, read-only comment observation; no recorder/writer or account cookies.
// Keep the beta limit small, start at most one new connection each refresh,
// and disconnect when the ranking screen is left or its refresh lease expires.
function createRankingObserver({createProvider,now=Date.now,limit=3,leaseMs=45000}={}){
  const entries=new Map(),retryAt=new Map();
  let lease=null;
  const close=entry=>{
    if(!entry||entry.closed)return;
    entry.closed=true;entry.tracker.reset("");
    try{entry.provider?.disconnect();}catch{}
    // A pending connect may still finish. Keep its slot occupied until it settles.
    if(!entry.pending)entries.delete(entry.id);
  };
  function stop(){
    if(lease){clearTimeout(lease);lease=null;}
    for(const entry of entries.values())close(entry);
  }
  function fail(entry){
    retryAt.set(entry.id,now()+60000);
    close(entry);
  }
  async function start(entry){
    try{
      const provider=await createProvider(entry.id);
      entry.provider=provider;
      provider.on("error",()=>{if(!entry.closed)fail(entry);});
      if(entry.closed){provider.disconnect();return;}
      provider.on("stateChange",state=>{
        if(entry.closed)return;
        if(state==="connected")entry.tracker.state(entry.id,true);
        else if(state==="connecting")entry.tracker.state(entry.id,false);
        else fail(entry);
      });
      provider.on("comment",data=>{
        if(!entry.closed)entry.tracker.observe({type:"comment",liveId:entry.id,userId:data?.userId,isHistory:Boolean(data?.isHistory)});
      });
      provider.on("gift",data=>{
        if(!entry.closed)entry.tracker.observe({type:"gift",liveId:entry.id,point:data?.point,itemId:data?.itemId,userId:data?.userId,message:data?.message,timestamp:data?.timestamp,isHistory:Boolean(data?.isHistory)});
      });
      const metadata=await provider.connect();
      if(entry.closed){provider.disconnect();return;}
      if(metadata?.status&&String(metadata.status).toUpperCase()!=="ON_AIR"){fail(entry);return;}
      entry.tracker.state(entry.id,true);
      entry.thumbnailUrl=rankingImageUrl(metadata?.thumbnailUrl);
      entry.connected=true;
    }catch{if(!entry.closed)fail(entry);}
    finally{
      entry.pending=false;
      if(entry.closed){try{entry.provider?.disconnect();}catch{};if(entries.get(entry.id)===entry)entries.delete(entry.id);}
    }
  }
  function sync(rows,excludedId=""){
    if(lease)clearTimeout(lease);
    lease=setTimeout(stop,leaseMs);lease.unref?.();
    const at=now();
    for(const [id,until] of retryAt)if(until<=at)retryAt.delete(id);
    const ids=[...new Set((rows||[]).map(row=>row.liveId).filter(id=>/^lv\d{5,15}$/.test(id)&&id!==excludedId))].slice(0,limit);
    for(const entry of entries.values())if(!ids.includes(entry.id))close(entry);
    if(entries.size>=limit)return;
    const id=ids.find(id=>!entries.has(id)&&!retryAt.has(id));
    if(!id)return;
    const entry={id,tracker:createRankingActivityTracker(now),pending:true,closed:false,connected:false,thumbnailUrl:""};
    entries.set(id,entry);void start(entry);
  }
  function snapshot(id){
    const entry=entries.get(id);
    if(!entry||entry.closed)return retryAt.has(id)?{status:"unavailable"}:null;
    const activity=entry.tracker.snapshot(id);
    return {status:activity?"observing":"connecting",activity,thumbnailUrl:entry.thumbnailUrl};
  }
  return {sync,stop,snapshot};
}
module.exports={createRankingObserver};
