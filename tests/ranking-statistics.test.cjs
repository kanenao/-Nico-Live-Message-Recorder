"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {readContributionStatistics,observeProviderStatistics}=require("../electron/ranking-statistics.cjs");
const {createRankingActivityTracker,buildRanking}=require("../electron/live-ranking.cjs");
test("statistics recognizes actual cumulative fields, zero and missing separately",()=>{
 assert.deepEqual(readContributionStatistics({adPoints:0,giftPoints:123}),{adPoints:0,giftPoints:123});
 assert.deepEqual(readContributionStatistics({statistics:{totalNicoadPoints:"1200"}}),{adPoints:1200,giftPoints:null});
 assert.deepEqual(readContributionStatistics({adPoints:-1,giftPoints:NaN}),{adPoints:null,giftPoints:null});
});
test("existing provider socket is observed once and detached on disconnect",()=>{
 const p=new EventEmitter(),socket=new EventEmitter(),second=new EventEmitter(),received=[];
 const dispose=observeProviderStatistics(p,v=>received.push(v));
 p.wsClient={ws:socket};p.emit("stateChange","connected");p.emit("metadata");
 socket.emit("message",Buffer.from(JSON.stringify({type:"statistics",data:{adPoints:20,giftPoints:0}})));
 assert.deepEqual(received,[{adPoints:20,giftPoints:0}]);
 p.emit("stateChange","disconnected");socket.emit("message",Buffer.from('{"type":"statistics","data":{"adPoints":999}}'));
 p.wsClient={ws:second};p.emit("stateChange","connected");second.emit("message",'{"type":"statistics","data":{"giftPoints":3}}');
 assert.equal(received.length,2);dispose();assert.equal(second.listenerCount("message"),0);
});
test("fresh cumulative statistics expire and are used for score rows",()=>{
 let now=1700000000000;
 const tracker=createRankingActivityTracker(()=>now);tracker.state("lv123456",true);
 tracker.statistics({adPoints:0,giftPoints:30});
 const rows=buildRanking([{id:"a",ok:true,rows:[{liveId:"lv123456",title:"test"}]}],[],now,0,null,{activity:id=>tracker.snapshot(id)});
 assert.equal(rows[0].adPoints,0);assert.equal(rows[0].giftPoints,30);
 now+=120001;assert.equal(tracker.snapshot("lv123456").giftPoints,null);
 tracker.state("lv123456",false);assert.equal(tracker.snapshot("lv123456"),null);
});
