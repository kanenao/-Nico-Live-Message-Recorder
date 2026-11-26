"use strict";
// Run behind an HTTPS reverse proxy with per-client rate limits and request size limits.
// No GitHub credential is distributed in the desktop application.
const http=require("node:http");
const crypto=require("node:crypto");
const {buildFeedbackIssueUrl}=require("../electron/feedback-url.cjs");
const ISSUE_API="https://api.github.com/repos/kanenao/-Nico-Live-Message-Recorder/issues";
function createRelay({token,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(!token)throw Error("FEEDBACK_GITHUB_TOKEN is required");
  const accepted=new Map(), pending=new Map(), recent=[];
  function reply(res,status,body){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(body));}
  return http.createServer(async(req,res)=>{
    if(req.method!=="POST"||req.url!=="/feedback")return reply(res,404,{error:"not_found"});
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"]||""))return reply(res,415,{error:"content_type"});
    const time=now();
    while(recent.length&&time-recent[0]>=60000)recent.shift();
    if(recent.length>=30)return reply(res,429,{error:"rate_limit"});
    recent.push(time);
    const chunks=[];let size=0;
    try {
      for await(const chunk of req){size+=chunk.length;if(size>8192){reply(res,413,{error:"too_large"});return;}chunks.push(chunk);}
      const input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
      if(typeof input?.details!=="string"||typeof input?.version!=="string")throw Error("invalid");
      const params=new URL(buildFeedbackIssueUrl(input)).searchParams;
      const details=params.get("details");
      if (/(?:gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|\bBearer\s+\S+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/i.test(details))throw Error("private data");
      const key=crypto.createHash("sha256").update(JSON.stringify([input.kind,input.edition,input.version,details])).digest("hex");
      for(const [k,v] of accepted)if(time-v.time>=86400000)accepted.delete(k);
      if(accepted.has(key))return reply(res,200,{number:accepted.get(key).number});
      let task=pending.get(key);
      if(!task){
        if(pending.size>=5||accepted.size>=10000)return reply(res,429,{error:"busy"});
        task=(async()=>{
          const response=await fetchImpl(ISSUE_API,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
            headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","Content-Type":"application/json","User-Agent":"NicoLiveFeedbackRelay"},
            body:JSON.stringify({title:params.get("title"),body:"### 対象版\n\n"+params.get("edition")+"\n\n### バージョン\n\n"+input.version+"\n\n### 報告内容\n\n"+details+"\n\n<!-- nicolive-app-feedback:"+key+" -->"})});
          if(!response.ok)throw Error("upstream");
          const result=await response.json();
          if(!Number.isSafeInteger(result.number)||result.number<1)throw Error("upstream");
          accepted.set(key,{number:result.number,time:now()});return result.number;
        })();
        pending.set(key,task);
      }
      try {return reply(res,200,{number:await task});}
      catch {return reply(res,502,{error:"upstream"});}
      finally {if(pending.get(key)===task)pending.delete(key);}
    }catch{if(!res.headersSent)reply(res,400,{error:"invalid_report"});}
  });
}
if(require.main===module){const server=createRelay({token:process.env.FEEDBACK_GITHUB_TOKEN});server.requestTimeout=15000;server.headersTimeout=10000;server.listen(Number(process.env.PORT||8787),"127.0.0.1");}
module.exports={createRelay};
