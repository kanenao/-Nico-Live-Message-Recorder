"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createRankingObserver}=require("../electron/ranking-observer.cjs");
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test("ranking observation counts actual distinct live commenters, respects limit and stops",async()=>{
  const providers=new Map();let now=1700000000000;
  const observer=createRankingObserver({now:()=>now,limit:2,createProvider:async id=>{
    const p=new EventEmitter();
    p.connect=async()=>{p.emit("stateChange","connected");return {status:"ON_AIR",thumbnailUrl:"https://cdn.nimg.jp/screen.jpg"};};
    p.disconnect=()=>{p.closed=true;p.emit("stateChange","disconnected");};
    providers.set(id,p);return p;
  }});
  try{
    const rows=[{liveId:"lv123456"},{liveId:"lv234567"},{liveId:"lv345678"}];
    observer.sync(rows);await settle();observer.sync(rows);await settle();observer.sync(rows);await settle();
    assert.equal(providers.size,2);
    const p=providers.get("lv123456");p.emit("comment",{userId:"a"});p.emit("comment",{userId:"a"});p.emit("comment",{userId:"b",isHistory:true});p.emit("comment",{userId:"c"});
    assert.equal(observer.snapshot("lv123456").activity.count,2);
    assert.equal(observer.snapshot("lv123456").thumbnailUrl,"https://cdn.nimg.jp/screen.jpg");
    assert.equal(observer.snapshot("lv345678"),null);
    observer.sync(rows,"lv123456");await settle();
    assert.equal(p.closed,true);
    assert.equal(observer.snapshot("lv123456"),null);
    observer.stop();assert.ok([...providers.values()].every(p=>p.closed));
  }finally{observer.stop();}
});
test("late public comment connection cannot survive cancellation",async()=>{
  let release,p;
  const observer=createRankingObserver({createProvider:async()=>{
    p=new EventEmitter();p.connect=()=>new Promise(resolve=>{release=resolve;});p.disconnect=()=>{p.closed=true;};return p;
  }});
  observer.sync([{liveId:"lv123456"}]);await settle();
  observer.stop();release({status:"ON_AIR"});await settle();
  assert.equal(p.closed,true);assert.equal(observer.snapshot("lv123456"),null);
});
