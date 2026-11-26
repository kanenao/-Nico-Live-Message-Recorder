"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {eligibleMetrics,validateWeights,createAiWeightAdvisor,BASE}=require("../electron/ranking-ai-score.cjs");
const {applyCompositeScores}=require("../electron/live-ranking.cjs");
const sample={points:100,visitors:10,comments:10,commentRate:2,visitorRate:1,activePeople:3,activePeopleComplete:true,adPoints:0,giftPoints:0,title:"秘密の番組名"};
test("optional metrics require equal coverage, including complete five-minute observation",()=>{
 const rows=[sample,{...sample,activePeopleComplete:false,giftPoints:null}];
 assert.deepEqual(eligibleMetrics(rows),["points","visitors","comments","commentRate","visitorRate","adPoints"]);
 assert.equal(applyCompositeScores(rows)[0].scoreParts.activePeople,undefined);
 const full=applyCompositeScores([sample,{...sample,activePeople:10,adPoints:100,giftPoints:100}]);
 assert.ok(full[1].compositeScore>full[0].compositeScore);
 assert.equal(full[0].scoreParts.adPoints,0);
});
test("AI weights are strictly bounded and cannot introduce new metrics",()=>{
 const keys=eligibleMetrics([sample,sample]),weights=Object.fromEntries(keys.map(k=>[k,BASE[k]]));
 assert.deepEqual(validateWeights(weights,keys),weights);
 assert.equal(validateWeights({...weights,points:999},keys),null);
 assert.equal(validateWeights({...weights,unknown:1},keys),null);
});
test("AI advisor is nonblocking, caches validated aggregate-only weights and falls back",async()=>{
 const rows=[sample,sample],keys=eligibleMetrics(rows);let calls=0;
 const weights=Object.fromEntries(keys.map(k=>[k,BASE[k]]));weights.commentRate=30;
 const advisor=createAiWeightAdvisor({fetchImpl:async(url,opt)=>{
   calls++;assert.equal(url,"http://127.0.0.1:11434/api/chat");assert.ok(!opt.body.includes(sample.title));
   return new Response(JSON.stringify({message:{content:JSON.stringify(weights)}}));
 }});
 assert.equal(advisor.get(rows,keys).method,"statistical");
 await new Promise(r=>setImmediate(r));
 assert.equal(advisor.get(rows,keys).method,"ollama");
 assert.equal(applyCompositeScores(rows,advisor)[0].scoreMethod,"ollama");
 assert.equal(calls,1);
 const bad=createAiWeightAdvisor({fetchImpl:async()=>{throw Error("offline");}});
 assert.equal(bad.get(rows,keys).method,"statistical");
 await new Promise(r=>setImmediate(r));
 assert.equal(bad.get(rows,keys).method,"statistical");
});

test("synchronous AI transport failure does not lock future attempts",async()=>{
  let calls=0,now=1000;
  const rows=[sample,sample],keys=eligibleMetrics(rows);
  const weights=Object.fromEntries(keys.map(k=>[k,BASE[k]]));
  const advisor=createAiWeightAdvisor({now:()=>now,interval:100,fetchImpl:()=>{
    calls++;if(calls===1)throw Error("transport");
    return Promise.resolve(new Response(JSON.stringify({message:{content:JSON.stringify(weights)}})));
  }});
  assert.equal(advisor.get(rows,keys).method,"statistical");
  await new Promise(r=>setImmediate(r));now+=101;
  assert.equal(advisor.get(rows,keys).method,"statistical");
  await new Promise(r=>setImmediate(r));
  assert.equal(advisor.get(rows,keys).method,"ollama");assert.equal(calls,2);
});
test("AI response from a previous metric generation is discarded",async()=>{
  const rows=[sample,sample],keys=eligibleMetrics(rows);
  const reduced=eligibleMetrics([sample,{...sample,activePeopleComplete:false}]);
  let resolveFirst,calls=0;
  const advisor=createAiWeightAdvisor({fetchImpl:()=>{calls++;return new Promise(r=>{if(calls===1)resolveFirst=r;});}});
  advisor.get(rows,keys);
  await new Promise(r=>setImmediate(r));
  advisor.get(rows,reduced);advisor.get(rows,keys);
  resolveFirst(new Response(JSON.stringify({message:{content:JSON.stringify(Object.fromEntries(keys.map(k=>[k,BASE[k]])))}})));
  await new Promise(r=>setImmediate(r));
  assert.equal(advisor.get(rows,keys).method,"statistical");
});
