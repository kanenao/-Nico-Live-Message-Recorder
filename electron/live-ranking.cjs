"use strict";

const SOURCES = Object.freeze([
  {id:"chikuwa",name:"ちくわちゃん",url:"https://www.chikuwachan.com/live/NCU/"},
  {id:"nicoran",name:"nico-ran.stream",url:"https://nico-ran.stream/"},
  {id:"official",name:"ニコ生公式ランキング",url:"https://live.nicovideo.jp/ranking"}
].map(Object.freeze));
const {readContributionStatistics}=require("./ranking-statistics.cjs");
const LIMIT=200;
const TOP_DETAIL_LIMIT=100;
const MAX_BYTES=6*1024*1024;
const REFRESH_MS=10000;
const DETAIL_REFRESH_MS=30000;

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
    const u=new URL(value.startsWith("//")?"https:"+value:value);
    if(u.protocol!=="https:"||u.username||u.password||u.port||
       !(u.hostname==="nimg.jp"||u.hostname.endsWith(".nimg.jp")||u.hostname.endsWith(".simg.jp")||((u.hostname==="nicovideo.jp"||u.hostname.endsWith(".nicovideo.jp"))&&/(?:^|\/)(?:liveimg|live[-_]thumbnails?|video_thumbnails|thumbnails?)(?:\/|$)/i.test(u.pathname))))return "";
    return u.href;
  }catch{return "";}
}

// Chikuwa public listing artwork is not hosted on nimg.jp. Never synthesize
// a URL from a broadcaster ID; accept only explicit image paths in its HTML.
function rankingListingImage(value,sourceUrl=""){
  const official=rankingImageUrl(value);
  if(official)return official;
  if(typeof value!=="string"||value.length>2048)return "";
  try{
    const source=new URL(sourceUrl);
    if(source.origin!=="https://www.chikuwachan.com"||!["/live/NCU/","/live/NCF/"].includes(source.pathname))return "";
    const url=new URL(value,source);
    if(url.origin!=="https://www.chikuwachan.com"||url.username||url.password||
      !url.pathname.startsWith("/live/")||!/\.(?:jpe?g|png|webp)$/i.test(url.pathname)||
      /(?:usericon|user-icon|avatar|profile|badge|logo|\/icons?\/)/i.test(url.pathname))return "";
    return url.href;
  }catch{return "";}
}
function htmlAttribute(tag,name){
  return tag.match(new RegExp("(?:^|\\s)"+name+"\\s*=\\s*([\"'])([\\s\\S]*?)\\1","i"))?.[2]?.replace(/&amp;/g,"&")||"";
}
function officialOgImage(html,id,declared=""){
  const metadata=new Map();
  for(const tag of String(html||"").matchAll(/<meta\b[^>]*>/gi)){
    const key=(htmlAttribute(tag[0],"property")||htmlAttribute(tag[0],"name")).toLowerCase();
    if(["og:url","og:image","og:image:secure_url","twitter:image","og:title"].includes(key)&&!metadata.has(key))metadata.set(key,htmlAttribute(tag[0],"content"));
  }
  const ogId=liveId(metadata.get("og:url"));
  if((ogId&&ogId!==id)||(!ogId&&declared!==id))return null;
  const candidates=[...new Set(["og:image:secure_url","og:image","twitter:image"].map(k=>rankingImageUrl(metadata.get(k))).filter(url=>url&&!/(?:usericon|user-icon|avatar|profile|logo|\/icons?\/)/i.test(new URL(url).pathname)))];
  if(!candidates.length)return null;
  return {title:clean(metadata.get("og:title")),thumbnailUrl:candidates[0],thumbnailCandidates:candidates};
}

function firstRankingImage(...values){
  for(const value of values){const url=rankingImageUrl(value);if(url)return url;}
  return "";
}
// Adapted from the supplied website worker: exclude default and provider artwork.
function isRankingBrandImage(value){
  return typeof value==="string"&&/(?:^|[\/_-])(?:default|no[-_]?image|no[-_]?thumbnail|placeholder|dummy|fallback|initial|blank)(?:[\/_.?-]|$)|\/(?:usericon|user-icon|channelicon|channel-icon|profile|avatar|icons?)\/|\/nicochannel\/material\/design\/|\/channel\/(?:icon|logo)\/|\/comch\/channel-icon\//i.test(value);
}
function rankingChannelOwner(p={},raw={}){
  const s=p.supplier??p.programProvider??p.provider??raw.supplier??raw.programProvider??raw.provider??{};
  const types=[p.providerType,s.programProviderType,s.supplierType,s.type].filter(v=>typeof v==="string"&&v.trim()).map(v=>v.trim().toLowerCase());
  if(types.includes("user"))return "";
  const ids=new Set();
  for(const value of [s.pageUrl,s.url,s.channelPageUrl]){
    if(typeof value!=="string")continue;
    try{const u=new URL(value);if(u.origin!=="https://ch.nicovideo.jp"||u.username||u.password)continue;
      const m=/^\/ch([1-9]\d{0,14})(?:\/|$)/i.exec(u.pathname);if(m)ids.add(m[1]);
    }catch{}
  }
  if(types.includes("channel")||ids.size){
    const m=/^(?:ch)?([1-9]\d{0,14})$/i.exec(String(s.programProviderId??s.supplierId??s.id??""));if(m)ids.add(m[1]);
  }
  return ids.size===1?[...ids][0]:"";
}
function programThumbnailCandidates(p={},raw={}){
  const values=[];
  for(const obj of [p,raw]){
    if(!obj||typeof obj!=="object")continue;
    for(const item of [obj.thumbnail?.screenshot?.urlSet,obj.thumbnail?.screenshot?.urls,obj.thumbnail?.screenshot,obj.screenshot?.urlSet,obj.screenshot?.urls,obj.screenshot,obj.thumbnail?.urlSet,obj.thumbnail?.urls,obj.thumbnail,obj.thumbnails,obj.thumbnailUrlSet,obj.thumbnailUrls,obj.programThumbnail]){
      if(typeof item==="string"){values.push(item);continue;}
      if(!item||typeof item!=="object")continue;
      for(const k of ["large","huge","middle","small","normal","url","uri","src","uri640x360","uri320x180","uri160x90"]){
        const v=item[k];values.push(typeof v==="object"&&v?v.url??v.uri??v.src:v);
      }
    }
    values.push(obj.thumbnailUrl,obj.screenshotUrl,obj.programThumbnailUrl);
  }
  return [...new Set(values.map(rankingImageUrl).filter(url=>url&&!isRankingBrandImage(url)))].slice(0,8);
}
function jsonRow(raw) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw)) return null;
  const p=raw.program&&typeof raw.program==="object"?raw.program:raw;
  const id=liveId(p.liveId??p.programId??p.nicoliveProgramId??p.contentId??p.id?.value??p.id??p.watchPageUrl??p.watchUrl??raw.id?.value??raw.id);
  const title=clean(p.title??p.programTitle);
  if(!id||!title)return null;
  const status=String(p.schedule?.status??p.liveStatus??p.status??"").toUpperCase();
  if(status&&!["ON_AIR","ONAIR","LIVE","ON AIR"].includes(status))return null;
  if(p.isOnAir===false)return null;
  const providerRaw=p.programProvider??p.provider??p.supplier??raw.programProvider??raw.provider??raw.supplier??{};
  const declaredType=String(p.providerType??raw.providerType??"").trim().toLowerCase();
  const supplierType=String(providerRaw.programProviderType??providerRaw.supplierType??providerRaw.type??"").trim().toLowerCase();
  const conflictingType=Boolean(declaredType&&supplierType&&declaredType!==supplierType);
  const providerType=supplierType||declaredType;
  const provider={...providerRaw,programProviderType:providerType};
  const statistics=p.statistics??p.stats??raw.statistics??raw.stats??{};
  const numeric=String(provider.id??p.userId??"").trim();
  // Official-format providers include programProviderId and a provider type.
  // Keep the legacy untyped numeric-ID format for ranking lists only.
  // A named channel must never be treated as a user.
  const hasIdentityLink=[provider.url,provider.pageUrl,provider.userPageUrl,provider.profileUrl].some(v=>typeof v==="string"&&v);
  const broadcasterId=conflictingType?"":providerType||hasIdentityLink?officialSupplierUserId(provider):
    /^\d{1,15}$/.test(numeric)?numeric:"";
  return {liveId:id,title,name:clean(provider.name??p.broadcasterName??p.providerName,80),
    broadcasterId,channelOwner:conflictingType?"":rankingChannelOwner(p,raw),
    startedAt:time(p.schedule?.beginTime??p.beginTime??p.beginAt??p.startTime??p.startedAt),
    iconUrl:firstRankingImage(provider.icon,provider.iconUrl,provider.icons?.uri150x150,provider.icons?.uri50x50,provider.icons?.large,provider.icons?.small,provider.icon?.large,provider.icon?.small,provider.thumbnailUrl),
    thumbnailUrl:programThumbnailCandidates(p,raw)[0]||"",thumbnailCandidates:programThumbnailCandidates(p,raw),
    visitors:count(statistics.watchCount??statistics.visitorCount??p.watchCount??p.visitorCount??p.viewCounter),
    comments:count(statistics.commentCount??p.commentCount??p.commentCounter),
    ...readContributionStatistics({...raw,...p,statistics})};
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
  const byId=new Map();
  for(const row of rows){
    if(!row?.liveId)continue;
    const old=byId.get(row.liveId);
    if(!old){
      if(byId.size<LIMIT)byId.set(row.liveId,{...row});
      continue;
    }
    // Keep the first listing position and existing values. Later duplicate
    // records may contain metadata omitted from the first listing.
    // Never combine user identity or artwork across conflicting identities.
    const conflict=old.broadcasterId&&row.broadcasterId&&old.broadcasterId!==row.broadcasterId;
    old.thumbnailCandidates=[...new Set([...(old.thumbnailCandidates||[]),old.thumbnailUrl,...(row.thumbnailCandidates||[]),row.thumbnailUrl].filter(Boolean))].slice(0,8);
    for(const field of ["startedAt","thumbnailUrl","visitors","comments","adPoints","giftPoints"]){
      if((old[field]==null||old[field]==="")&&row[field]!=null&&row[field]!=="")old[field]=row[field];
    }
    if(!conflict){
      for(const field of ["name","broadcasterId","iconUrl","thumbnailHistoryUserId","channelOwner"]){
        if(!old[field]&&row[field])old[field]=row[field];
      }
    }
  }
  return [...byId.values()];
}
function parseRankingPage(html,sourceUrl="") {
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
  // Structured rows define membership and rank when present. HTML may only
  // supplement images for those same IDs; navigation links cannot add rows.
  const structured=rows.length?unique(rows):null;
  const known=structured?new Map(structured.map(row=>[row.liveId,row])):null;
  // Only accept actual Nico Live watch links with a descriptive anchor title.
  // Never guess a program ID from a user ID, thumbnail or arbitrary text.
  const safeHtml=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,"");
  for(const a of safeHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
    const href=a[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const id=liveId(href);
    if(!id)continue;
    const existing=known?.get(id);
    if(known&&!existing)continue;
    // A single non-icon Nico CDN image inside the exact watch link is a
    // conservative thumbnail candidate. Never attach neighboring card art.
    const images=[...a[2].matchAll(/<img\b([^>]*)>/gi)];
    const imageUrls=images.flatMap(img=>{
      const attrs=img[1];
      if(/(?:user[-_ ]?icon|avatar|profile|badge|logo|アイコン)/i.test(attrs))return [];
      const value=name=>attrs.match(new RegExp("(?:^|\\s)"+name+"\\s*=\\s*([\"'])(.*?)\\1","i"))?.[2]?.replace(/&amp;/g,"&");
      const url=[value("data-src"),value("data-original"),value("data-lazy-src"),value("src")].map(v=>rankingListingImage(v,sourceUrl)).find(Boolean)||"";
      return url&&!/\/(?:usericon|user-icon|icons?)\//i.test(new URL(url).pathname)?[url]:[];
    });
    const thumbnailUrl=[...new Set(imageUrls)].length===1?imageUrls[0]:"";
    if(existing){if(thumbnailUrl){if(!existing.thumbnailUrl)existing.thumbnailUrl=thumbnailUrl;existing.thumbnailCandidates=[...new Set([...(existing.thumbnailCandidates||[]),existing.thumbnailUrl,thumbnailUrl])].slice(0,8);}continue;}
    const title=clean(a[1].match(/\b(?:title|aria-label)\s*=\s*(["'])(.*?)\1/i)?.[2]||a[2]);
    if(!title||/^(視聴|見る|開く|放送ページ|LIVE|lv\d+)$/i.test(title))continue;
    rows.push({liveId:id,title,name:"",broadcasterId:"",startedAt:"",iconUrl:"",thumbnailUrl,visitors:null,comments:null});
  }
  // Some listings place an image outside the watch anchor. Associate it only
  // if its own explicit image URL contains the exact program ID, never user ID.
  const result=structured||unique(rows);
  if(["https://www.chikuwachan.com/live/NCU/","https://www.chikuwachan.com/live/NCF/"].includes(sourceUrl)){
    const byId=new Map(result.map(row=>[row.liveId,row]));
    const hints=sourceUrl.endsWith("/NCU/")?parseChikuwaUserHints(safeHtml):new Map();
    for(const row of result){
      const hint=hints.get(row.liveId);
      if(hint&&(!row.broadcasterId||row.broadcasterId===hint))row.thumbnailHistoryUserId=hint;
    }
    for(const tag of safeHtml.matchAll(/<img\b[^>]*>/gi)){
      for(const key of ["data-src","data-original","data-lazy-src","src"]){
        const url=rankingListingImage(htmlAttribute(tag[0],key),sourceUrl);
        if(!url)continue;
        const match=new URL(url).pathname.match(/(?:^|[^a-z0-9])(lv\d{5,15})(?![a-z0-9])/i);
        const row=match&&byId.get(match[1].toLowerCase());
        if(!row)continue;
        if(!row.thumbnailUrl)row.thumbnailUrl=url;
        row.thumbnailCandidates=[...new Set([...(row.thumbnailCandidates||[]),row.thumbnailUrl,url])].slice(0,8);
      }
    }
  }
  return result;
}
// Only read an explicit NCU_<numeric user ID> label inside an unambiguous
// single-program container. This hint is for exact-program history lookup,
// never a verified account identity or an image URL.
function parseChikuwaUserHints(html){
  const root={name:"",parent:null,ids:new Set(),users:new Set()},stack=[root],links=[],out=new Map(),conflicts=new Set();
  let tokens=0;
  for(const [token] of String(html||"").matchAll(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')+>/g)){
    if(++tokens>50000)break;
    if(token.startsWith("<!--"))continue;
    const tag=token.match(/^<(\/?)([a-z][\w-]*)/i);if(!tag)continue;
    const name=tag[2].toLowerCase();
    if(tag[1]){let i=stack.length-1;while(i>0&&stack[i].name!==name)i--;if(i>0)stack.length=i;continue;}
    if(stack.length>80)continue;
    const node={name,parent:stack.at(-1),ids:new Set(),users:new Set()};
    if(name==="a"){
      const id=liveId(htmlAttribute(token,"href"));
      if(id){links.push({id,node});for(let p=node;p;p=p.parent)if(p.ids.size<2)p.ids.add(id);}
    }
    if(name==="img"){
      const label=htmlAttribute(token,"alt")||htmlAttribute(token,"title");
      const match=/^NCU_(\d{5,15})$/i.exec(label);
      // Channel markers also invalidate ambiguous user/channel containers.
      const user=match?.[1]||(/^NCU_ch\d+$/i.test(label)?"channel":"");
      if(user)for(let p=node;p;p=p.parent)if(p.users.size<2)p.users.add(user);
    }
    if(!/^(?:img|input|br|hr|meta|link|source|area|base|col|embed|param|track|wbr)$/.test(name)&&!token.endsWith("/>"))stack.push(node);
  }
  for(const {id,node} of links){
    for(let p=node;p&&p!==root&&p.ids.size===1;p=p.parent){
      if(p.users.size>1){conflicts.add(id);break;}
      if(p.users.size===1){
        const user=[...p.users][0];
        if(user==="channel"||(out.has(id)&&out.get(id)!==user))conflicts.add(id);
        else out.set(id,user);
        break;
      }
    }
  }
  for(const id of conflicts)out.delete(id);
  return out;
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
function officialSupplierUserId(supplier) {
  const type=String(supplier.programProviderType??supplier.supplierType??supplier.type??"").trim().toLowerCase();
  // Do not treat a channel or an official program as an individual user.
  if(type&&type!=="user")return "";
  const raw=String(supplier.programProviderId??supplier.id??"").trim();
  const numeric=/^\d{5,15}$/.test(raw)?raw:"";
  const urls=[supplier.url,supplier.pageUrl,supplier.userPageUrl,supplier.profileUrl];
  const ids=new Set();
  for(const value of urls){
    if(typeof value!=="string")continue;
    try{
      const u=new URL(value);
      if(u.protocol!=="https:"||u.username||u.password||u.port||
         !["www.nicovideo.jp","nicovideo.jp"].includes(u.hostname))continue;
      const match=/^\/user\/(\d{5,15})\/?$/.exec(u.pathname);
      if(match)ids.add(match[1]);
    }catch{}
  }
  if(ids.size>1)return "";
  const linked=ids.values().next().value||"";
  if(numeric&&linked&&numeric!==linked)return "";
  return type==="user"?(numeric||linked):linked;
}
function parseOfficialRankingDetails(html,id) {
  const tags=String(html||"").matchAll(/<[^>]+\bid\s*=\s*(["'])embedded-data\1[^>]*>/gi);
  for(const tag of tags){
    const raw=tag[0].match(/\bdata-props\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if(!raw)continue;
    try{
      const data=JSON.parse(raw.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"));
      const p=data?.program;
      if(!p||typeof p!=="object"||!clean(p.title))continue;
      const declared=liveId(p.nicoliveProgramId??p.programId??p.liveId??p.id?.value??p.id);
      if(declared&&declared!==id)return null;
      // Some public watch payloads carry supplier metadata next to program.
      // Use it only for an explicitly matching program, never an unrelated page.
      const supplierRaw=p.supplier??p.programProvider??(declared===id?data.supplier??data.programProvider:null)??{};
      const supplier={...supplierRaw,programProviderType:supplierRaw.programProviderType??supplierRaw.supplierType??supplierRaw.type??p.providerType};
      const candidates=[...new Set([...programThumbnailCandidates(p,declared===id?data:{}),...(officialOgImage(html,id,declared)?.thumbnailCandidates||[])])].slice(0,8);
      return {liveId:id,title:clean(p.title),name:clean(supplier.name,80),
        broadcasterId:officialSupplierUserId(supplier),channelOwner:rankingChannelOwner(p,{supplier}),
        startedAt:time(p.beginTime??p.beginAt),
        visitors:count(p.statistics?.watchCount??p.statistics?.visitorCount??p.watchCount??p.visitorCount),
        comments:count(p.statistics?.commentCount??p.commentCount),
        iconUrl:firstRankingImage(supplier.icon,supplier.iconUrl,supplier.icons?.uri150x150,supplier.icons?.uri50x50,supplier.icons?.large,supplier.icons?.small,supplier.icon?.large,supplier.icon?.small,supplier.thumbnailUrl),
        thumbnailUrl:candidates[0]||"",thumbnailCandidates:candidates,...readContributionStatistics(p)};
    }catch{}
  }
  const og=officialOgImage(html,id);
  return og?{liveId:id,...og,name:"",broadcasterId:"",startedAt:"",iconUrl:""}:null;
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
    if(response?.ok){
      const payload=JSON.parse(await readBounded(response));
      const user=payload?.data?.user??payload?.data??payload?.user;
      if(user&&typeof user==="object"){
        const claimed=user.id??user.userId;
        if(claimed!=null&&String(claimed)!==userId)return "";
        const icon=rankingImageUrl(require("./nico-profile.cjs").extractApiProfileIcon(payload));
        if(icon)return icon;
      }
    }
  }catch{}
  // Fixed public profile URL; only accept a user-icon CDN image, not generic OGP art.
  try{
    const response=await fetchImpl("https://www.nicovideo.jp/user/"+userId,{
      redirect:"error",headers:{accept:"text/html"},signal:AbortSignal.timeout(4000)});
    if(!response?.ok)return "";
    return rankingImageUrl(require("./nico-profile.cjs").extractProfileImageUrl(await readBounded(response)));
  }catch{return "";}
}
async function fetchUserRankingThumbnails(userId,id,fetchImpl,providerType="user"){
  if(!["user","channel"].includes(providerType)||!(/^[1-9]\d{0,14}$/.test(String(userId)))||!/^lv\d{5,15}$/.test(String(id)))return [];
  for(const version of providerType==="channel"?["v1"]:["v2","v1"]){
    try{
      const url=new URL("https://live.nicovideo.jp/front/api/"+version+"/user-broadcast-history");
      url.search=new URLSearchParams({providerId:userId,providerType,isIncludeNonPublic:"false",offset:"0",limit:providerType==="channel"?"10":"5",withTotalCount:"true"});
      const response=await fetchImpl(url.href,{redirect:"error",headers:{accept:"application/json","user-agent":"Nico-Live-Message-Recorder","X-Frontend-Id":"9"},signal:AbortSignal.timeout(4000)});
      if(!response?.ok)continue;
      const payload=JSON.parse(await readBounded(response)),root=payload.data??payload;
      const list=root.programsList??root.programs;
      if(!Array.isArray(list))continue;
      for(const entry of list.slice(0,providerType==="channel"?10:5)){
        const p=entry?.program??entry;
        if(!p)continue;
        const claimed=liveId(p.nicoliveProgramId??p.programId??p.liveId??p.id?.value??p.id??entry.id?.value??entry.id);
        if(claimed!==id)continue;
        const urls=programThumbnailCandidates(p,entry);
        if(urls.length)return urls;
      }
    }catch{}
  }
  return [];
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
  return async function enrich(rows,allowFetch=true){
    const at=now();
    // Retain expired entries to prioritize programs not yet checked.
    for(const [id,entry] of profileCache)if(entry.expiresAt<=at)profileCache.delete(id);
    const wanted=(allowFetch?rows:[]).filter(row=>(cache.get(row.liveId)?.expiresAt??0)<=at&&(!row.iconUrl||!row.thumbnailUrl||!row.name||!row.broadcasterId||row.visitors==null||row.comments==null))
      .sort((a,b)=>{
        const left=cache.get(a.liveId),right=cache.get(b.liveId);
        if(!left||!right)return Number(Boolean(left))-Number(Boolean(right));
        return left.expiresAt-right.expiresAt;
      }).slice(0,6);
    for(let i=0;i<wanted.length;i+=2){
      await Promise.all(wanted.slice(i,i+2).map(async row=>{
        let details=await fetchOfficialRankingDetails(row.liveId,fetchImpl);
        const channelOwner=details?.channelOwner||row.channelOwner;
        const userId=details?.broadcasterId||row.broadcasterId||row.thumbnailHistoryUserId;
        if((channelOwner||userId)&&!details?.thumbnailUrl&&!row.thumbnailUrl){
          const candidates=await fetchUserRankingThumbnails(channelOwner||userId,row.liveId,fetchImpl,channelOwner?"channel":"user");
          if(candidates.length)details={...(details||row),thumbnailUrl:candidates[0],thumbnailCandidates:candidates};
        }
        if(details?.broadcasterId&&!details.iconUrl)details.iconUrl=await getProfileIcon(details.broadcasterId);
        cache.delete(row.liveId);
        cache.set(row.liveId,{details,checkedAt:now(),expiresAt:now()+(details?.thumbnailUrl?1800000:60000)});
      }));
    }
    while(cache.size>400)cache.delete(cache.keys().next().value);
    while(profileCache.size>400)profileCache.delete(profileCache.keys().next().value);
    return rows.map(row=>{
      const entry=cache.get(row.liveId);
      const d=entry&&entry.expiresAt>now()?entry.details:null;
      if(!d)return row;
      const conflict=d.broadcasterId&&row.broadcasterId&&d.broadcasterId!==row.broadcasterId;
      // Prefer verified official identity; do not retain a mismatched name or icon.
      return {...row,title:d.title||row.title,name:d.name||(conflict?"":row.name),
        broadcasterId:d.broadcasterId||row.broadcasterId,channelOwner:d.channelOwner||row.channelOwner,startedAt:d.startedAt||row.startedAt,
        iconUrl:d.iconUrl||(conflict?"":row.iconUrl),
        visitors:row.visitors??(now()-entry.checkedAt<=120000?d.visitors:null)??null,
        comments:row.comments??(now()-entry.checkedAt<=120000?d.comments:null)??null,
        adPoints:row.adPoints??d.adPoints??null,giftPoints:row.giftPoints??d.giftPoints??null,thumbnailUrl:d.thumbnailUrl||row.thumbnailUrl,thumbnailCandidates:[...new Set([...(d.thumbnailCandidates||[]),d.thumbnailUrl,...(row.thumbnailCandidates||[]),row.thumbnailUrl].filter(Boolean))].slice(0,8)};
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
    if(!rows.length)rows=parseRankingPage(html,source.url);
    if(!rows.length)throw Error("番組ID付きのランキングを取得できません");
    return {id:source.id,name:source.name,ok:true,rows};
  } catch(error) {
    return {id:source.id,name:source.name,ok:false,message:clean(error?.message||"通信エラー",140),rows:[]};
  }
}
// Compare matching source counters only. Median avoids adding duplicated
// cumulative counts or trusting a single unusually delayed source.
function rankingGrowth(samples,prior,elapsed){
  const pairs=prior&&elapsed>=5/60&&elapsed<=15?Object.entries(samples||{}).flatMap(([id,value])=>{
    const old=prior[id];
    return Number.isFinite(old)&&Number.isFinite(value)&&value>=old?[{id,delta:value-old}]:[];
  }):[];
  const sourceIds=pairs.map(p=>p.id).sort();
  const deltas=pairs.map(p=>p.delta).sort((a,b)=>a-b);
  const middle=Math.floor(deltas.length/2);
  const median=deltas.length?(deltas.length%2?deltas[middle]:(deltas[middle-1]+deltas[middle])/2):null;
  return {delta:median,rate:median===null?null:Math.round(median/elapsed*10)/10,count:deltas.length,sourceIds};
}
function momentumPoints(ranks,commentRate,visitorRate){
  const reference=ranks.reduce((sum,r)=>sum+200*10/(9+r),0);
  // Independent provisional formula, not any site's proprietary points.
  // Square roots limit the impact of sudden spikes and very large channels.
  return Math.round(reference+50*Math.sqrt(Math.max(0,commentRate??0))+20*Math.sqrt(Math.max(0,visitorRate??0)));
}
const {BASE,eligibleMetrics}=require("./ranking-ai-score.cjs");
function applyCompositeScores(rows,advisor){
  const keys=eligibleMetrics(rows);
  const policy=advisor?.get(rows,keys)??{weights:Object.fromEntries(keys.map(k=>[k,BASE[k]])),method:"statistical"};
  const total=keys.reduce((sum,k)=>sum+policy.weights[k],0);
  const weights=Object.fromEntries(keys.map(k=>[k,policy.weights[k]/total]));
  const scales={};
  for(const key of keys){
    const values=rows.map(r=>r[key]).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
    scales[key]=values.length?Math.max(1,values[Math.ceil((values.length-1)*0.9)]):1;
  }
  return rows.map(row=>{
    let sum=0,coverage=0;
    const scoreParts={},rawParts={};
    for(const key of keys){
      const weight=weights[key],value=row[key];
      if(!Number.isFinite(value)||value<0){scoreParts[key]=null;continue;}
      const normalized=Math.min(1,Math.log1p(value)/Math.log1p(scales[key]));
      rawParts[key]=normalized*weight*1000;
      scoreParts[key]=Math.floor(rawParts[key]);
      sum+=normalized*weight;coverage+=weight;
    }
    // Largest-remainder rounding ensures the displayed breakdown adds up exactly.
    const compositeScore=Math.min(1000,Math.round(sum*1000));
    const order=keys.filter(k=>Object.hasOwn(rawParts,k)).sort((a,b)=>(rawParts[b]-scoreParts[b])-(rawParts[a]-scoreParts[a]));
    const remainder=compositeScore-order.reduce((n,k)=>n+scoreParts[k],0);
    for(let i=0;i<remainder;i++)scoreParts[order[i]]++;
    return {...row,compositeScore,scoreCoverage:Math.round(coverage*100),scoreParts,scoreWeights:weights,scoreMethod:policy.method,scorePolicy:JSON.stringify(weights)};
  });
}
// Only reuse frames from the same running Streamlink article session.
function selectRankingVideoFrame(liveId,session,now=Date.now()){
  if(!/^lv\d{5,15}$/.test(String(liveId))||!session?.active||
      session.liveId!==liveId||session.source!=="streamlink"||!Array.isArray(session.frames))return null;
  let latest=null;
  for(const frame of session.frames){
    const at=Date.parse(frame?.capturedAt);
    if(!Number.isFinite(at)||at>now||now-at>90000||(latest&&at<=latest.at))continue;
    const image=frame?.image;
    if(typeof image!=="string"||image.length<100||image.length>420000||image.length%4!==0||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image))continue;
    const bytes=Buffer.from(image,"base64");
    if(bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)continue;
    latest={at,image:"data:image/jpeg;base64,"+image};
  }
  return latest?{image:latest.image,capturedAt:new Date(latest.at).toISOString()}:null;
}
function createRankingActivityTracker(now=Date.now){
  let liveId="",connected=false,startedAt=0,lastAt=0,uncertainAt=null;
  const users=new Map(),gifts=new Map();
  let giftPoints=0,giftUncertainAt=null,adTotal=null,giftTotal=null;
  const WINDOW=300000,LIMIT_USERS=50000;
  function reset(id){liveId=id||"";connected=false;startedAt=0;lastAt=0;uncertainAt=null;users.clear();gifts.clear();giftPoints=0;giftUncertainAt=null;adTotal=null;giftTotal=null;}
  function state(id,active){
    if(id!==liveId||!active)reset(id);
    if(active&&!connected){startedAt=now();lastAt=startedAt;connected=true;}
  }
  function prune(at){
    if(at<lastAt){reset(liveId);return false;}
    lastAt=at;
    // Entries are ordered by most recent observation. Stop as soon as the
    // oldest remaining entry is fresh, avoiding a full scan for every comment.
    for(const [id,seen] of users){
      if(at-seen<WINDOW)break;
      users.delete(id);
    }
    for(const [id,gift] of gifts){if(at-gift.at<WINDOW)break;giftPoints-=gift.points;gifts.delete(id);}
    return true;
  }
  function observe(record){
    if(!connected||!["comment","gift"].includes(record?.type)||record.isHistory||record.liveId!==liveId)return;
    const at=now();if(!prune(at))return;
    if(record.type==="gift"){
      const points=count(record.point),stamp=Date.parse(record.timestamp);
      if(points===null||!Number.isFinite(stamp)||!record.itemId){giftUncertainAt=at;return;}
      const key=JSON.stringify([stamp,String(record.itemId),String(record.userId??""),points,String(record.message??"")]);
      if(gifts.has(key))return;
      if(gifts.size>=LIMIT_USERS||!Number.isSafeInteger(giftPoints+points)){giftUncertainAt=at;return;}
      gifts.set(key,{at,points});giftPoints+=points;return;
    }
    const id=String(record.userId??"").trim();
    if(!id||id.length>160||(!users.has(id)&&users.size>=LIMIT_USERS)){uncertainAt=at;return;}
    users.delete(id);
    users.set(id,at);
  }
  function statistics(data){
    if(!connected)return;
    const at=now(),value=readContributionStatistics(data);
    if(value.adPoints!==null)adTotal={value:value.adPoints,at};
    if(value.giftPoints!==null)giftTotal={value:value.giftPoints,at};
  }
  function snapshot(id){
    if(!connected||id!==liveId)return null;
    const at=now();if(!prune(at))return null;
    const recent=entry=>entry&&at>=entry.at&&at-entry.at<=120000?entry.value:null;
    return {adPoints:recent(adTotal),giftPoints:recent(giftTotal),count:users.size,complete:at-startedAt>=WINDOW&&(uncertainAt===null||at-uncertainAt>=WINDOW),giftObservedPoints:giftPoints,giftObservedCount:gifts.size,giftObservationComplete:at-startedAt>=WINDOW&&(giftUncertainAt===null||at-giftUncertainAt>=WINDOW)};
  }
  return {reset,state,observe,statistics,snapshot};
}
function buildRanking(results,previous=[],now=Date.now(),previousAt=0,previousSourceIds=null,scoreOptions={}) {
  const byId=new Map();
  for(const source of results.filter(s=>s.ok)){
    unique(source.rows).forEach((row,i)=>{
      let item=byId.get(row.liveId);
      if(!item){item={...row,sourceRanks:{},commentSamples:{},visitorSamples:{},points:0};byId.set(row.liveId,item);}
      if(row.comments!=null)item.commentSamples[source.id]=row.comments;
      if(row.visitors!=null)item.visitorSamples[source.id]=row.visitors;
      for(const field of ["startedAt","thumbnailUrl"])if(!item[field]&&row[field])item[field]=row[field];
      const identityConflict=item.broadcasterId&&row.broadcasterId&&item.broadcasterId!==row.broadcasterId;
      if(!identityConflict){
        for(const field of ["name","broadcasterId","iconUrl","thumbnailHistoryUserId","channelOwner"])if(!item[field]&&row[field])item[field]=row[field];
      }
      // Do not sum cross-site counters: use the largest reported cumulative value.
      for(const field of ["visitors","comments","adPoints","giftPoints"])if(row[field]!=null&&(item[field]==null||row[field]>item[field]))item[field]=row[field];
      item.thumbnailCandidates=[...new Set([...(item.thumbnailCandidates||[]),item.thumbnailUrl,...(row.thumbnailCandidates||[]),row.thumbnailUrl].filter(Boolean))].slice(0,8);
      item.sourceRanks[source.id]=i+1;
    });
  }
  const currentSources=results.filter(s=>s.ok).map(s=>s.id).sort().join(",");
  // The top-200 display can omit every program from a successful source.
  // Compare actual source coverage, not only the sources visible in that slice.
  const priorSources=[...new Set(previousSourceIds??previous.flatMap(row=>Object.keys(row.sourceRanks||{})))].sort().join(",");
  const comparable=currentSources===priorSources;
  const priorSamples=new Map(previous.map(r=>[r.liveId,r]));
  const prior=comparable?priorSamples:new Map();
  const elapsed=(now-previousAt)/60000;
  const candidates=[...byId.values()].map(row=>{
    const ranks=Object.values(row.sourceRanks);
    const old=prior.get(row.liveId);
    const oldSamples=priorSamples.get(row.liveId);
    const comments=rankingGrowth(row.commentSamples,oldSamples?.commentSamples,elapsed);
    const visitors=rankingGrowth(row.visitorSamples,oldSamples?.visitorSamples,elapsed);
    row.commentRate=comments.rate;
    row.commentRateSourceCount=comments.count;
    row.commentRateSourceIds=comments.sourceIds;
    row.commentDelta=comments.delta;
    row.visitorRate=visitors.rate;
    row.visitorRateSourceCount=visitors.count;
    row.visitorRateSourceIds=visitors.sourceIds;
    row.visitorDelta=visitors.delta;
    row.points=momentumPoints(ranks,row.commentRate,row.visitorRate);
    const activity=scoreOptions.activity?.(row.liveId);
    row.activePeople=activity?.count??null;
    row.activePeopleComplete=activity?.complete===true;
    row.adPoints=activity?.adPoints??row.adPoints??null;
    row.giftPoints=activity?.giftPoints??row.giftPoints??null;
    row.previousRank=old&&elapsed>0&&elapsed<=3?old.rank??null:null;
    row.pointDelta=old&&elapsed>0&&elapsed<=3&&Number.isFinite(old.points)&&
      Array.isArray(old.commentRateSourceIds)&&Array.isArray(old.visitorRateSourceIds)&&
      old.commentRateSourceIds.join(",")===comments.sourceIds.join(",")&&
      old.visitorRateSourceIds.join(",")===visitors.sourceIds.join(",")?row.points-old.points:null;
    // A previous top-200 snapshot cannot establish that an omitted program is new.
    row.rankNew=Boolean(!old&&comparable&&previous.length&&previous.length<LIMIT&&elapsed>0&&elapsed<=3);
    return row;
  });
  const rows=applyCompositeScores(candidates,scoreOptions.advisor).sort((a,b)=>b.compositeScore-a.compositeScore||b.points-a.points||a.liveId.localeCompare(b.liveId)).slice(0,LIMIT);
  return rows.map((row,i)=>{
    const rank=i+1;
    const old=prior.get(row.liveId);
    // Do not join across changed coverage or long interruptions. A missing
    // program is not interpreted as last place. Keep at most one hour / 40 samples.
    const samePolicy=old?.scorePolicy===row.scorePolicy;
     const history=old&&samePolicy&&elapsed>0&&elapsed<=3&&Array.isArray(old.rankHistory)
      ?old.rankHistory.filter(sample=>Number.isFinite(sample.at)&&sample.at>=now-3600000&&sample.at<now).slice(-39):[];
    return {...row,rank,previousRank:samePolicy?row.previousRank:null,rankChange:!samePolicy||row.previousRank==null?null:row.previousRank-rank,
      rankHistory:[...history,{at:now,rank}]};
  });
}
// Reference ZIP: match images and watch links within a single-program HTML
// container. Ignore ambiguous containers and profile artwork; do not add ranks.
function parseRankingCardImages(html){
  const result=new Map(),root={parent:null,name:"",ids:new Set(),images:new Set()},stack=[root],links=[];
  const source=String(html||"").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,"");
  let tokens=0;
  for(const [token] of source.matchAll(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')+>/g)){
    if(++tokens>50000)break;
    if(token.startsWith("<!--"))continue;
    const tag=token.match(/^<(\/?)([a-z][\w-]*)/i);if(!tag)continue;
    const name=tag[2].toLowerCase();
    if(tag[1]){
      let i=stack.length-1;while(i>0&&stack[i].name!==name)i--;
      if(i>0)stack.length=i;
      continue;
    }
    if(stack.length>80)continue;
    const node={name,parent:stack.at(-1),ids:new Set(),images:new Set()};
    if(name==="a"){
      const id=liveId(htmlAttribute(token,"href"));
      if(id){links.push({id,node});for(let p=node;p;p=p.parent){if(p.ids.size<2)p.ids.add(id);}}
    }
    if(name==="img"&&!/(?:user[-_ ]?icon|avatar|profile|badge|logo|アイコン|NCU_)/i.test(token)){
      const url=["data-src","data-original","data-lazy-src","src"].map(k=>rankingImageUrl(htmlAttribute(token,k))).find(v=>v&&!/(?:usericon|user-icon|nicoaccount|channel-icon|avatar|profile|logo|\/icons?\/)/i.test(new URL(v).pathname));
      if(url)for(let p=node;p;p=p.parent){if(p.images.size<3)p.images.add(url);}
    }
    if(!/^(?:img|input|br|hr|meta|link|source|area|base|col|embed|param|track|wbr)$/.test(name)&&!token.endsWith("/>"))stack.push(node);
  }
  for(const {id,node} of links){
    for(let p=node;p&&p!==root&&p.ids.size===1;p=p.parent){
      if(p.images.size===1){if(!result.has(id))result.set(id,[...p.images][0]);break;}
      if(p.images.size>1)break;
    }
    if(result.size>=400)break;
  }
  return result;
}
// Website reference also checks the channel-specific public NCF listing.
async function fetchChannelListingImages(fetchImpl){
  const url="https://www.chikuwachan.com/live/NCF/";
  try{
    const response=await fetchImpl(url,{redirect:"error",signal:AbortSignal.timeout(4000),headers:{accept:"text/html","user-agent":"Nico-Live-Message-Recorder"}});
    if(!response?.ok)return new Map();
    const html=await readBounded(response);
    const result=new Map();
    for(const row of parseRankingPage(html,url)){
      if(row.thumbnailUrl&&!isRankingBrandImage(row.thumbnailUrl))result.set(row.liveId,row.thumbnailUrl);
    }
    return result;
  }catch{return new Map();}
}
async function fetchRankingCardImages(fetchImpl){
  try{
    const response=await fetchImpl("https://ikioi-ranking.com/v/nico",{redirect:"error",signal:AbortSignal.timeout(4000),headers:{accept:"text/html","user-agent":"Nico-Live-Message-Recorder"}});
    return response?.ok?parseRankingCardImages(await readBounded(response)):new Map();
  }catch{return new Map();}
}

function parseNicoFeedImages(xml){
  const images=new Map();
  for(const [item] of String(xml||"").matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/gi)){
    const link=item.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim().replace(/^<!\[CDATA\[|\]\]>$/g,"").replace(/&amp;/g,"&");
    const id=liveId(link);
    if(!id)continue;
    for(const tag of item.matchAll(/<media:thumbnail\b[^>]*>/gi)){
      const url=rankingImageUrl(htmlAttribute(tag[0],"url"));
      if(url&&!/(?:usericon|user-icon|avatar|profile|logo|\/icons?\/)/i.test(new URL(url).pathname)){images.set(id,url);break;}
    }
    if(images.size>=400)break;
  }
  return images;
}
async function fetchNicoFeedImages(fetchImpl){
  try{
    const response=await fetchImpl("https://live.nicovideo.jp/recent/rss?tab=live",{redirect:"error",signal:AbortSignal.timeout(4000),headers:{accept:"application/rss+xml,application/xml,text/xml"}});
    return response?.ok?parseNicoFeedImages(await readBounded(response)):new Map();
  }catch{return new Map();}
}
function mergeNicoFeedImages(rows,images){
  return rows.map(row=>{
    const image=images.get(row.liveId);
    if(!image)return row;
    return {...row,thumbnailUrl:row.thumbnailUrl||image,thumbnailCandidates:[...new Set([row.thumbnailUrl,...(row.thumbnailCandidates||[]),image].filter(Boolean))].slice(0,8)};
  });
}
function createRankingService(options={}) {
  const fetchImpl=options.fetchImpl||globalThis.fetch;
  const now=options.now||Date.now;
  const enrich=options.enrichDetails===true?createRankingDetailEnricher(fetchImpl,now):null;
  let feedImages=new Map(),feedAt=null;
  let pending=null,detailPending=null,lastAttempt=0,lastDetailAt=null,snapshot=null,previousAt=0,previous=[],previousSourceIds=[];
  return async function getRanking(){
    if(pending)return pending;
    const at=now();
    const elapsed=at-lastAttempt;
    if(snapshot&&elapsed>=0&&elapsed<REFRESH_MS)return snapshot;
    lastAttempt=at;
    pending=(async()=>{
      const useFeed=options.feedImages===true&&(feedAt===null||at<feedAt||at-feedAt>=30000);
      const [results,feed]=await Promise.all([Promise.all(SOURCES.map(s=>fetchSource(s,fetchImpl))),useFeed?Promise.all([fetchNicoFeedImages(fetchImpl),fetchRankingCardImages(fetchImpl),fetchChannelListingImages(fetchImpl)]).then(([rss,cards,channels])=>new Map([...cards,...channels,...rss])):Promise.resolve(null)]);
      if(feed){feedImages=feed;feedAt=at;}
      const checkedAt=now();
      const healthy=results.filter(s=>s.ok);
      let rows=buildRanking(results,previous,checkedAt,previousAt,previousSourceIds,{advisor:options.advisor,activity:options.activity});
      if(healthy.length){
        if(options.feedImages===true)rows=mergeNicoFeedImages(rows,feedImages);
        if(enrich){
          // Desktop: one bounded batch per refresh, without blocking rank delivery.
          // Preserve the synchronous mode for diagnostics and existing callers.
          const interval=options.backgroundDetails===true?REFRESH_MS:DETAIL_REFRESH_MS;
          const due=lastDetailAt===null||checkedAt<lastDetailAt||checkedAt-lastDetailAt>=interval;
          if(options.backgroundDetails===true){
            if(due&&!detailPending){
              lastDetailAt=checkedAt;
              detailPending=enrich(rows.slice(0,TOP_DETAIL_LIMIT),true).catch(()=>{}).finally(()=>{detailPending=null;});
            }
            rows=await enrich(rows,false);
          }else{
            if(due)lastDetailAt=checkedAt;
            rows=await enrich(rows,due);
          }
        }
        previous=rows;previousAt=checkedAt;previousSourceIds=healthy.map(s=>s.id);
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
module.exports={SOURCES,REFRESH_MS,selectRankingVideoFrame,applyCompositeScores,createRankingActivityTracker,parseRankingPage,extractJsonRows,buildRanking,fetchSource,createRankingService,resolveRankingMonitorTarget,rankingImageUrl,parseOfficialRankingDetails,createRankingDetailEnricher,fetchOfficialRankingProfileIcon,programThumbnailCandidates,fetchUserRankingThumbnails,fetchOfficialRankingDetails,rankingListingImage,officialOgImage,parseNicoFeedImages,fetchNicoFeedImages,mergeNicoFeedImages,parseRankingCardImages,fetchRankingCardImages,parseChikuwaUserHints,rankingChannelOwner,isRankingBrandImage,fetchChannelListingImages};
