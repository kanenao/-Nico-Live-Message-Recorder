"use strict";

const SOURCES = Object.freeze([
  {id:"chikuwa",name:"ちくわちゃん",url:"https://www.chikuwachan.com/live/NCU/"},
  {id:"nicoran",name:"nico-ran.stream",url:"https://nico-ran.stream/"},
  {id:"ikioi",name:"配信者勢いランキング",url:"https://ikioi-ranking.com/v/nico"},
  {id:"official",name:"ニコ生公式ランキング",url:"https://live.nicovideo.jp/ranking"}
].map(Object.freeze));
const LIMIT=200;
const MAX_BYTES=6*1024*1024;
const REFRESH_MS=90000;

function clean(v,max=240) {
  return String(v??"").replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]{1,6}|\d{1,7});/gi,entity=>{
    const named={"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'","&nbsp;":" "};
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const n=entity[2].toLowerCase()==="x"?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));
    return n>=0&&n<=0x10ffff?String.fromCodePoint(n):"";
  }).replace(/<[^>]*>/g," ").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
}
function liveId(v) {
  const s=String(v??"").trim();
  if (/^lv\d{5,15}$/i.test(s)) return s.toLowerCase();
  try {
    const u=new URL(s,"https://live.nicovideo.jp");
    if(u.protocol!=="https:"||u.hostname!=="live.nicovideo.jp") return "";
    return /^\/watch\/(lv\d{5,15})\/?$/i.exec(u.pathname)?.[1].toLowerCase()||"";
  } catch {return "";}
}
function count(v) {
  if(typeof v!=="number"&&typeof v!=="string") return null;
  const s=String(v).replace(/,/g,"").trim();
  if(!/^\d{1,12}$/.test(s)) return null;
  return Number(s);
}
function time(v) {
  if(v==null||v==="")return "";
  const n=typeof v==="number"||/^\d{10,13}$/.test(String(v))?Number(v):Date.parse(v);
  const ms=n>0&&n<1e12?n*1000:n;
  return Number.isFinite(ms)&&ms>0&&ms<8.64e15?new Date(ms).toISOString():"";
}
function rankingImageUrl(value) {
  if(typeof value!=="string"||value.length>2048)return "";
  try{
    const u=new URL(value);
    if(u.protocol!=="https:"||u.username||u.password||u.port||
       !(u.hostname==="nimg.jp"||u.hostname.endsWith(".nimg.jp")))return "";
    return u.href;
  }catch{return "";}
}
function firstRankingImage(...values){
  for(const value of values){const url=rankingImageUrl(value);if(url)return url;}
  return "";
}
function jsonRow(raw) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw)) return null;
  const p=raw.program&&typeof raw.program==="object"?raw.program:raw;
  const id=liveId(p.liveId??p.programId??p.nicoliveProgramId??p.contentId??p.id?.value??p.id??p.watchPageUrl??p.watchUrl);
  const title=clean(p.title??p.programTitle);
  if(!id||!title)return null;
  const status=String(p.schedule?.status??p.liveStatus??p.status??"").toUpperCase();
  if(status&&!["ON_AIR","ONAIR","LIVE","ON AIR"].includes(status))return null;
  if(p.isOnAir===false)return null;
  const provider=p.programProvider??p.provider??p.supplier??{};
  const statistics=p.statistics??p.stats??{};
  return {liveId:id,title,name:clean(provider.name??p.broadcasterName??p.providerName,80),
    broadcasterId:/^\d{1,15}$/.test(String(provider.id??p.userId??""))?String(provider.id??p.userId):"",
    startedAt:time(p.schedule?.beginTime??p.beginAt??p.startTime??p.startedAt),
    iconUrl:firstRankingImage(provider.icon,provider.iconUrl,provider.icons?.large,provider.icons?.small,provider.icon?.large,provider.icon?.small),
    thumbnailUrl:firstRankingImage(p.thumbnailUrl,p.thumbnail,p.thumbnail?.large,p.thumbnail?.small,p.thumbnail?.url,p.thumbnail?.middle,p.thumbnails?.large,p.thumbnails?.small),
    visitors:count(statistics.watchCount??statistics.visitorCount??p.watchCount??p.visitorCount??p.viewCounter),
    comments:count(statistics.commentCount??p.commentCount??p.commentCounter)};
}
function extractJsonRows(value) {
  const rows=[];let visited=0;
  function walk(x,depth) {
    if(depth>16||++visited>30000||rows.length>=LIMIT||!x||typeof x!=="object")return;
    if(Array.isArray(x)){for(const item of x)walk(item,depth+1);return;}
    const row=jsonRow(x);if(row){rows.push(row);return;}
    for(const key of Object.keys(x))if(!["__proto__","constructor","prototype"].includes(key))walk(x[key],depth+1);
  }
  walk(value,0);return rows;
}
function unique(rows) {
  const seen=new Set();
  return rows.filter(row=>{if(!row?.liveId||seen.has(row.liveId))return false;seen.add(row.liveId);return true;}).slice(0,LIMIT);
}
function parseRankingPage(html) {
  if(typeof html!=="string"||html.length>MAX_BYTES)return [];
  const rows=[];
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
    if(/application\/(?:ld\+)?json|__NEXT_DATA__|__INITIAL_STATE__/i.test(match[1])){
      try{rows.push(...extractJsonRows(JSON.parse(match[2])));}catch{}
    }
  }
  for(const match of html.matchAll(/\bdata-props\s*=\s*(["'])([\s\S]*?)\1/gi)){
    // Decode attribute entities without stripping JSON strings or truncating.
    try{const json=match[2].replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");rows.push(...extractJsonRows(JSON.parse(json)));}catch{}
  }
  if(rows.length)return unique(rows);
  // Only accept actual Nico Live watch links with a descriptive anchor title.
  // Never guess a program ID from a user ID, thumbnail or arbitrary text.
  const safeHtml=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,"");
  for(const a of safeHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
    const href=a[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const id=liveId(href);
    if(!id)continue;
    const title=clean(a[1].match(/\b(?:title|aria-label)\s*=\s*(["'])(.*?)\1/i)?.[2]||a[2]);
    if(!title||/^(視聴|見る|開く|放送ページ|LIVE|lv\d+)$/i.test(title))continue;
    rows.push({liveId:id,title,name:"",broadcasterId:"",startedAt:"",iconUrl:"",thumbnailUrl:"",visitors:null,comments:null});
  }
  return unique(rows);
}
async function readBounded(response) {
  if(Number(response.headers?.get?.("content-length")||0)>MAX_BYTES)throw Error("取得上限超過");
  if(!response.body?.getReader){
    const value=await response.text();if(Buffer.byteLength(value)>MAX_BYTES)throw Error("取得上限超過");return value;
  }
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error("取得上限超過");}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString("utf8");
}
// Read only public metadata from a fixed official watch URL. Never return
// the full embedded page (it can contain session and connection information).
function parseOfficialRankingDetails(html,id) {
  const tags=String(html||"").matchAll(/<[^>]+\bid\s*=\s*(["'])embedded-data\1[^>]*>/gi);
  for(const tag of tags){
    const raw=tag[0].match(/\bdata-props\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if(!raw)continue;
    try{
      const data=JSON.parse(raw.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"));
      const p=data?.program;
      if(!p||typeof p!=="object"||!clean(p.title))continue;
      const declared=liveId(p.nicoliveProgramId??p.programId??p.liveId??p.id);
      if(declared&&declared!==id)return null;
      const supplier=p.supplier??p.programProvider??{};
      return {liveId:id,title:clean(p.title),name:clean(supplier.name,80),
        broadcasterId:String(supplier.programProviderType??supplier.type??"").toLowerCase()==="user"&&/^\d{5,15}$/.test(String(supplier.programProviderId??supplier.id??""))?String(supplier.programProviderId??supplier.id):"",
        startedAt:time(p.beginTime??p.beginAt),
        iconUrl:firstRankingImage(supplier.icon,supplier.iconUrl,supplier.icon?.large,supplier.icon?.small,supplier.thumbnailUrl),
        thumbnailUrl:firstRankingImage(p.thumbnailUrl,p.thumbnail,p.thumbnail?.large,p.thumbnail?.small,p.thumbnail?.huge,p.thumbnail?.url,p.thumbnails?.large)};
    }catch{}
  }
  return null;
}
async function fetchOfficialRankingDetails(id,fetchImpl) {
  if(!/^lv\d{5,15}$/.test(id))return null;
  try{
    const response=await fetchImpl("https://live.nicovideo.jp/watch/"+id,{
      redirect:"error",headers:{accept:"text/html","user-agent":"Nico-Live-Message-Recorder"},signal:AbortSignal.timeout(5000)});
    if(!response?.ok)return null;
    return parseOfficialRankingDetails(await readBounded(response),id);
  }catch{return null;}
}
// Limit each actual refresh to six lookups, with two concurrent requests.
// Cache successes and failures, and prefer uncached rows in rank order.
async function fetchOfficialRankingProfileIcon(userId,fetchImpl) {
  if(!/^\d{5,15}$/.test(userId))return "";
  try {
    const response=await fetchImpl("https://nvapi.nicovideo.jp/v1/users/"+userId,{
      redirect:"error",headers:{accept:"application/json","X-Frontend-Id":"6","X-Frontend-Version":"0"},signal:AbortSignal.timeout(4000)});
    if(!response?.ok)return "";
    const payload=JSON.parse(await readBounded(response));
    const user=payload?.data?.user??payload?.data??payload?.user;
    if(!user||typeof user!=="object")return "";
    const claimed=user.id??user.userId;
    if(claimed!=null&&String(claimed)!==userId)return "";
    return rankingImageUrl(require("./nico-profile.cjs").extractApiProfileIcon(payload));
  }catch{return "";}
}
function createRankingDetailEnricher(fetchImpl,now=Date.now) {
  const cache=new Map();
  const profileCache=new Map();
  async function getProfileIcon(id){
    const old=profileCache.get(id);
    if(old&&old.expiresAt>now())return old.promise;
    const entry={expiresAt:now()+300000,promise:null};
    entry.promise=fetchOfficialRankingProfileIcon(id,fetchImpl).then(icon=>{
      entry.expiresAt=now()+(icon?21600000:300000);
      return icon;
    });
    profileCache.set(id,entry);
    return entry.promise;
  }
  return async function enrich(rows){
    const at=now();
    for(const [id,entry] of cache)if(entry.expiresAt<=at)cache.delete(id);
    for(const [id,entry] of profileCache)if(entry.expiresAt<=at)profileCache.delete(id);
    const wanted=rows.filter(row=>!cache.has(row.liveId)&&(!row.iconUrl||!row.thumbnailUrl||!row.name)).slice(0,6);
    for(let i=0;i<wanted.length;i+=2){
      await Promise.all(wanted.slice(i,i+2).map(async row=>{
        const details=await fetchOfficialRankingDetails(row.liveId,fetchImpl);
        if(details?.broadcasterId&&!details.iconUrl)details.iconUrl=await getProfileIcon(details.broadcasterId);
        cache.set(row.liveId,{details,expiresAt:now()+(details?1800000:300000)});
      }));
    }
    while(cache.size>400)cache.delete(cache.keys().next().value);
    while(profileCache.size>400)profileCache.delete(profileCache.keys().next().value);
    return rows.map(row=>{
      const d=cache.get(row.liveId)?.details;
      if(!d)return row;
      return {...row,title:d.title||row.title,name:d.name||row.name,
        broadcasterId:d.broadcasterId,startedAt:d.startedAt||row.startedAt,
        iconUrl:d.iconUrl||row.iconUrl,thumbnailUrl:d.thumbnailUrl||row.thumbnailUrl};
    });
  };
}
async function fetchSource(source,fetchImpl=globalThis.fetch) {
  try {
    // No account cookies, tokens or custom URL input are used on third-party sites.
    const response=await fetchImpl(source.url,{redirect:"error",headers:{accept:"text/html,application/json;q=0.9","user-agent":"Nico-Live-Message-Recorder"},signal:AbortSignal.timeout(12000)});
    if(!response?.ok)throw Error("HTTP "+(response?.status??"不明"));
    const html=await readBounded(response);
    let rows=[];
    if(/^\s*[\[{]/.test(html)){try{rows=unique(extractJsonRows(JSON.parse(html)));}catch{}}
    if(!rows.length)rows=parseRankingPage(html);
    if(!rows.length)throw Error("番組ID付きのランキングを取得できません");
    return {id:source.id,name:source.name,ok:true,rows};
  } catch(error) {
    return {id:source.id,name:source.name,ok:false,message:clean(error?.message||"通信エラー",140),rows:[]};
  }
}
function buildRanking(results,previous=[],now=Date.now(),previousAt=0) {
  const byId=new Map();
  for(const source of results.filter(s=>s.ok)){
    unique(source.rows).forEach((row,i)=>{
      let item=byId.get(row.liveId);
      if(!item){item={...row,sourceRanks:{},commentSamples:{},points:0};byId.set(row.liveId,item);}
      if(row.comments!=null)item.commentSamples[source.id]=row.comments;
      for(const field of ["name","broadcasterId","startedAt","iconUrl","thumbnailUrl"])if(!item[field]&&row[field])item[field]=row[field];
      // Do not sum cross-site counters: use the largest reported cumulative value.
      for(const field of ["visitors","comments"])if(row[field]!=null&&(item[field]==null||row[field]>item[field]))item[field]=row[field];
      item.sourceRanks[source.id]=i+1;
    });
  }
  const currentSources=results.filter(s=>s.ok).map(s=>s.id).sort().join(",");
  const priorSources=[...new Set(previous.flatMap(row=>Object.keys(row.sourceRanks||{})))].sort().join(",");
  const comparable=currentSources===priorSources;
  const prior=new Map((comparable?previous:[]).map(r=>[r.liveId,r]));
  const elapsed=(now-previousAt)/60000;
  const rows=[...byId.values()].map(row=>{
    const ranks=Object.values(row.sourceRanks);
    // Original score: reciprocal rank fusion; source counts are never double-counted.
    row.points=Math.round(ranks.reduce((sum,r)=>sum+1000*10/(9+r),0));
    const old=prior.get(row.liveId);
    // A source can disappear or start returning a counter with a different
    // delay. Only compare successive measurements from the same source.
    const rates=old&&elapsed>=1&&elapsed<=15?Object.entries(row.commentSamples).flatMap(([id,value])=>{
      const previousValue=old.commentSamples?.[id];
      return Number.isFinite(previousValue)&&value>=previousValue?[(value-previousValue)/elapsed]:[];
    }):[];
    rates.sort((a,b)=>a-b);
    const middle=Math.floor(rates.length/2);
    row.commentRate=rates.length?Math.round((rates.length%2?rates[middle]:(rates[middle-1]+rates[middle])/2)*10)/10:null;
    row.previousRank=old?.rank??null;
    return row;
  }).sort((a,b)=>b.points-a.points||a.liveId.localeCompare(b.liveId)).slice(0,LIMIT);
  return rows.map((row,i)=>{
    const rank=i+1;
    const old=prior.get(row.liveId);
    // Do not join across changed coverage or long interruptions. A missing
    // program is not interpreted as last place. Keep at most one hour / 40 samples.
    const history=old&&elapsed>0&&elapsed<=3&&Array.isArray(old.rankHistory)
      ?old.rankHistory.filter(sample=>Number.isFinite(sample.at)&&sample.at>=now-3600000&&sample.at<now).slice(-39):[];
    return {...row,rank,rankChange:row.previousRank==null?null:row.previousRank-rank,
      rankHistory:[...history,{at:now,rank}]};
  });
}
function createRankingService(options={}) {
  const fetchImpl=options.fetchImpl||globalThis.fetch;
  const now=options.now||Date.now;
  const enrich=options.enrichDetails===true?createRankingDetailEnricher(fetchImpl,now):null;
  let pending=null,lastAttempt=0,snapshot=null,previousAt=0,previous=[];
  return async function getRanking(){
    if(pending)return pending;
    if(snapshot&&now()-lastAttempt<REFRESH_MS)return snapshot;
    lastAttempt=now();
    pending=(async()=>{
      const results=await Promise.all(SOURCES.map(s=>fetchSource(s,fetchImpl)));
      const checkedAt=now();
      const healthy=results.filter(s=>s.ok);
      let rows=buildRanking(results,previous,checkedAt,previousAt);
      if(healthy.length){
        if(enrich)rows=await enrich(rows);
        previous=rows;previousAt=checkedAt;
      }
      snapshot={checkedAt:new Date(checkedAt).toISOString(),stale:!healthy.length,partial:healthy.length>0&&healthy.length<results.length,
        dataAt:previousAt?new Date(previousAt).toISOString():"",
        rows:healthy.length?rows:previous,
        sources:results.map(({rows,...s})=>({...s,count:rows.length}))};
      return snapshot;
    })().finally(()=>{pending=null;});
    return pending;
  };
}
// A ranking entry can contain a channel ID, stale metadata or a false
// broadcaster ID. Resolve the official program supplier before registering.
async function resolveRankingMonitorTarget(value, fetchProgram) {
  const id=String(value??"").trim().toLowerCase();
  if(!/^lv\d{5,15}$/.test(id))throw Error("正しい放送IDを指定してください。");
  const page=await fetchProgram(id);
  if(!page||String(page.liveId).toLowerCase()!==id||
     String(page.broadcasterType||"").trim().toLowerCase()!=="user"){
    throw Error("公式番組情報からユーザー配信者を確認できません。チャンネル・公式放送は登録対象外です。");
  }
  const userId=String(page.broadcasterId??"").trim();
  const name=clean(page.broadcasterName,80);
  if(!/^\d{5,15}$/.test(userId)||!name)throw Error("配信者のユーザーID・名前を確認できません。");
  return {userId,name};
}
module.exports={SOURCES,REFRESH_MS,parseRankingPage,extractJsonRows,buildRanking,fetchSource,createRankingService,resolveRankingMonitorTarget,rankingImageUrl,parseOfficialRankingDetails,createRankingDetailEnricher,fetchOfficialRankingProfileIcon};
