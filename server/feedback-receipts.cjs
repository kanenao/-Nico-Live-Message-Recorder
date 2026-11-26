"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
// Store only report hashes and receipt numbers, never report text or credentials.
// One relay instance on a persistent local filesystem. An ambiguous upstream
// result stays reserved until an operator reconciles it against GitHub.
function openReceiptStore(dir) {
  if(!dir){const map=new Map();return {get:key=>map.get(key),reserve(key){if(map.has(key))return false;map.set(key,{pending:true});return true;},confirm(key,number){map.set(key,{number});}};}
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const filename=key=>{if(!/^[a-f0-9]{64}$/.test(key))throw Error("invalid receipt key");return path.join(dir,key+".json");};
  function writeSync(file,value,flags){
    const fd=fs.openSync(file,flags,0o600);
    try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  function syncDir(){if(process.platform==="win32")return;const fd=fs.openSync(dir,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  return {
    get(key){try{const value=JSON.parse(fs.readFileSync(filename(key),"utf8"));return Number.isSafeInteger(value.number)&&value.number>0?{number:value.number}:{pending:true};}catch(e){if(e.code==="ENOENT")return undefined;if(e instanceof SyntaxError)return {pending:true};throw e;}},
    reserve(key){try{writeSync(filename(key),{pending:true},"wx");syncDir();return true;}catch(e){if(e.code==="EEXIST")return false;throw e;}},
    confirm(key,number){if(!Number.isSafeInteger(number)||number<1)throw Error("invalid receipt");const file=filename(key);const temp=file+"."+crypto.randomUUID()+".tmp";try{writeSync(temp,{number},"wx");fs.renameSync(temp,file);syncDir();}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=="ENOENT")throw e;}}}
  };
}
module.exports={openReceiptStore};
