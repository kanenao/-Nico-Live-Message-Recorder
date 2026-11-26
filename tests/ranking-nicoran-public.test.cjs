"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {parseNicoRanCards,fetchSource,buildRanking}=require("../electron/live-ranking.cjs");
const card=(id,viewer,stats)=>'<a href="https://live.nicovideo.jp/watch/'+id+'">番組 '+id+'</a><a href="https://www.nicovideo.jp/user/123456">配信者</a><a href="/viewer.html?lv='+viewer+'">コメント表示</a><div>'+stats+'</div>';
const stats="来場者 1,234 コメント 56 広告 100 pt ギフト 0 pt アクティブ人数 7 人 / 10分";
test("matched reference cards provide public counters without treating missing as zero",()=>{
 const rows=parseNicoRanCards(card("lv123456","lv123456",stats)+card("lv123457","lv123458",stats)+card("lv123459","lv123459","来場者 12"));
 assert.equal(rows.length,2);
 assert.deepEqual([rows[0].visitors,rows[0].comments,rows[0].adPoints,rows[0].giftPoints,rows[0].publicActive10m],[1234,56,100,0,7]);
 assert.equal(rows[0].broadcasterId,"123456");assert.equal(rows[1].adPoints,null);
});
test("public ten-minute activity is distinct from local five-minute observation",async()=>{
 const source=await fetchSource({id:"nicoran",name:"nico-ran.stream",url:"https://nico-ran.stream/"},async()=>new Response(card("lv123456","lv123456",stats)));
 assert.equal(source.ok,true);
 const rows=buildRanking([source],[],1000,0,null,{activity:()=>({count:2,complete:true})});
 assert.equal(rows[0].publicActive10m,7);assert.equal(rows[0].activePeople,2);
 assert.equal(rows[0].adPoints,100);assert.equal(rows[0].giftPoints,0);
});
test("watch-only event cards and duplicated labels do not fabricate metrics",async()=>{
 const source={id:"nicoran",name:"nico-ran.stream",url:"https://nico-ran.stream/"};
 const invalid=await fetchSource(source,async()=>new Response('<a href="/watch/lv123456">イベント</a><div>広告 999 pt</div>'));
 assert.equal(invalid.ok,false);
 const rows=parseNicoRanCards(card("lv123456","lv123456","来場者 1 広告 3 pt 広告 9 pt"));
 assert.equal(rows[0].adPoints,null);
});
