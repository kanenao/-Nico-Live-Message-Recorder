"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {submitFeedback}=require("../electron/feedback-submit.cjs");
const {createRelay}=require("../server/feedback-relay.cjs");
const report={kind:"bug",edition:"beta",version:"1.2.1-beta.154",details:"録画が失敗する"};
test("direct submit returns only confirmed receipt",async()=>{
  const result=await submitFeedback(report,{endpoint:"https://example.test/feedback",fetchImpl:async(url,options)=>{
    assert.equal(url.href,"https://example.test/feedback");assert.equal(options.redirect,"error");assert.deepEqual(JSON.parse(options.body),report);assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify({number:12}),{status:200});
  }});assert.deepEqual(result,{number:12});
});
test("invalid or unconfigured submission fails without contacting server",async()=>{
  const fail=()=>assert.fail("unexpected fetch");
  await assert.rejects(submitFeedback(report,{fetchImpl:fail}),/未設定/);
  await assert.rejects(submitFeedback(report,{endpoint:"http://example.test",fetchImpl:fail}));
  await assert.rejects(submitFeedback({...report,details:"user_session=secret"},{endpoint:"https://example.test",fetchImpl:fail}));
  await assert.rejects(submitFeedback(report,{endpoint:"https://example.test",fetchImpl:async()=>new Response("{}",{status:200})}),/受付番号/);
});
test("relay creates one issue, returns same receipt for retries, rejects credentials",async(t)=>{
  let calls=0;
  const server=createRelay({token:"server-only",fetchImpl:async(url,options)=>{
    calls++;assert.match(url,/kanenao\/\-Nico-Live-Message-Recorder\/issues$/);
    assert.equal(options.headers.Authorization,"Bearer server-only");
    assert.match(JSON.parse(options.body).body,/### 対象版\n\nβ版/);
    return new Response(JSON.stringify({number:19}),{status:201});
  }});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const url="http://127.0.0.1:"+server.address().port+"/feedback";
  const send=input=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
  const results=await Promise.all([send(report),send(report)]);for(const response of results)assert.deepEqual(await response.json(),{number:19});
  assert.deepEqual(await (await send(report)).json(),{number:19});assert.equal(calls,1);
  assert.equal((await send({...report,details:"user_session=secret"})).status,400);
  assert.equal((await send({...report,details:"test@example.com"})).status,400);assert.equal(calls,1);
});

test("receipt survives a relay restart; ambiguous POST is never repeated",async(t)=>{
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"nico-feedback-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const fetchImpl=async()=>{calls++;if(calls===2)throw Error("ambiguous timeout");return new Response(JSON.stringify({number:31}),{status:201});};
  async function run(inputs){
    const server=createRelay({token:"test-only",stateDir:dir,fetchImpl});
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{const out=[];for(const input of inputs){const response=await fetch("http://127.0.0.1:"+server.address().port+"/feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});out.push([response.status,await response.json()]);}return out;}
    finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  const uncertain={...report,details:"別の録画エラー"};
  assert.deepEqual(await run([report,uncertain]),[[200,{number:31}],[502,{error:"upstream"}]]);
  assert.deepEqual(await run([report,uncertain]),[[200,{number:31}],[409,{error:"receipt_pending"}]]);
  assert.equal(calls,2);
});
test("client explains an ambiguous receipt without claiming submission",async()=>{
  await assert.rejects(submitFeedback(report,{endpoint:"https://example.test/feedback",fetchImpl:async()=>new Response("{}",{status:409})}),/確認中/);
});
