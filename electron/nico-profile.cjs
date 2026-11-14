"use strict";
function extractNicoUserId(folderName) {
 const match=String(folderName||"").match(/_(\d{5,})$/); return match?match[1]:"";
}
function extractProfileImageUrl(html) {
 const source=String(html||"");
 const patterns=[/<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i,/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["'][^>]*>/i,/<meta\b[^>]*\bname=["']twitter:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i];
 for(const pattern of patterns){const m=source.match(pattern);if(!m)continue;try{const u=new URL(m[1].replace(/&amp;/g,"&").trim());if(u.protocol==="https:"&&(u.hostname==="nicovideo.jp"||u.hostname.endsWith(".nicovideo.jp")||u.hostname.endsWith(".nimg.jp")))return u.href;}catch(_){}}
 return "";
}
async function fetchNicoProfileIcon(userId,fetchImpl=globalThis.fetch){
 const id=String(userId||"");if(!/^\d{5,}$/.test(id)||typeof fetchImpl!=="function")return "";
 const response=await fetchImpl("https://www.nicovideo.jp/user/"+id,{headers:{Accept:"text/html","User-Agent":"NicoLiveMessageRecorder/1.0"},signal:AbortSignal.timeout(8000)});
 if(!response||!response.ok)return "";return extractProfileImageUrl(await response.text());
}
module.exports={extractNicoUserId,extractProfileImageUrl,fetchNicoProfileIcon};
