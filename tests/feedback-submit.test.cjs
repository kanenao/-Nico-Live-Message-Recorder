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
