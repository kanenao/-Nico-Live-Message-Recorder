"use strict";
// Local AI adjusts one common scoring policy, never individual broadcasters.
// Only anonymous aggregate numeric statistics are sent to the loopback model.
const BASE=Object.freeze({points:30,visitors:20,comments:15,commentRate:25,visitorRate:10,activePeople:15,adPoints:5,giftPoints:5});
const CORE=["points","visitors","comments","commentRate","visitorRate"];
const OPTIONAL=["activePeople","adPoints","giftPoints"];
const valid=v=>Number.isFinite(v)&&v>=0;
function eligibleMetrics(rows){
  return [...CORE,...OPTIONAL.filter(k=>rows.length>1&&rows.every(r=>valid(r[k])&&(k!=="activePeople"||r.activePeopleComplete===true)))];
}
function validateWeights(raw,keys){
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).length!==keys.length)return null;
  const result={};
  for(const k of keys){const v=raw[k];if(!Number.isInteger(v)||v<Math.ceil(BASE[k]*0.6)||v>Math.floor(BASE[k]*1.4))return null;result[k]=v;}
  return result;
}
function summarize(rows,keys){
  return Object.fromEntries(keys.map(k=>{
    const a=rows.map(r=>r[k]).filter(valid).sort((a,b)=>a-b);
    const q=p=>a.length?Math.round(a[Math.floor((a.length-1)*p)]):null;
    return [k,{available:a.length,median:q(.5),p90:q(.9)}];
  }));
}
function createAiWeightAdvisor({fetchImpl=globalThis.fetch,now=Date.now,model="qwen2.5:3b",interval=120000}={}){
  let lastAt=-Infinity,pending=null,cached=null,signature="",generation=0;
  function get(rows,keys){
    const sig=keys.join(",");
    if(signature!==sig){signature=sig;generation++;cached=null;lastAt=-Infinity;}
    const at=now();
    if(!pending&&(at-lastAt>=interval||at<lastAt)){
      lastAt=at;
      const requestGeneration=generation;
      const stats=summarize(rows,keys);
      const defaults=Object.fromEntries(keys.map(k=>[k,BASE[k]]));
      pending=Promise.resolve().then(async()=>{
        try{
          const response=await fetchImpl("http://127.0.0.1:11434/api/chat",{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),headers:{"Content-Type":"application/json"},body:JSON.stringify({
            model,stream:false,format:"json",options:{temperature:0,num_predict:180},messages:[
              {role:"system",content:"Adjust common livestream ranking weights using numeric aggregates only. Prefer current engagement over accumulated totals; avoid paid popularity dominance. Return only a JSON object with exactly the input metric keys and integer weights within 60 to 140 percent of defaults. Do not produce individual program scores."},
              {role:"user",content:JSON.stringify({defaults,statistics:stats})}
            ]})});
          if(!response.ok)return;
          const data=await response.json();
          const weights=validateWeights(JSON.parse(data.message?.content||""),keys);
          if(weights&&signature===sig&&generation===requestGeneration)cached={weights,method:"ollama",at:now()};
        }catch{}finally{pending=null;}
      });
    }
    if(cached&&at>=cached.at&&at-cached.at<=interval*3)return cached;
    return {weights:Object.fromEntries(keys.map(k=>[k,BASE[k]])),method:"statistical"};
  }
  return {get};
}
module.exports={BASE,CORE,eligibleMetrics,validateWeights,summarize,createAiWeightAdvisor};
