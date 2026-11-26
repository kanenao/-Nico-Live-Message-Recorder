"use strict";
// Read the existing nicomget watch socket, not a second viewing connection.
// nicomget 2.2.4 does not expose statistics publicly. Feature-detect its
// internal EventEmitter socket; if upstream changes, leave data unknown.
function points(v){
  if(typeof v==="string"&&/^\d{1,12}$/.test(v))v=Number(v);
  return Number.isSafeInteger(v)&&v>=0&&v<=999999999999?v:null;
}
function readContributionStatistics(data){
  const value=data?.statistics??data?.stats??data??{};
  const adPoints=points(value.adPoints??value.totalAdPoints??value.totalNicoadPoints??data?.totalNicoadPoints??data?.totalAdPoints??data?.adPoints);
  const giftPoints=points(value.giftPoints??value.totalGiftPoints??data?.totalGiftPoints??data?.giftPoints);
  return {adPoints,giftPoints};
}
function observeProviderStatistics(provider,onStats){
  let socket=null,closed=false;
  function message(raw){
    if(closed)return;
    try{
      if(typeof raw!=="string"&&!Buffer.isBuffer(raw))return;
      if(raw.length>65536)return;
      const event=JSON.parse(raw.toString());
      if(event.type!=="statistics")return;
      const stats=readContributionStatistics(event.data);
      if(stats.adPoints!==null||stats.giftPoints!==null)onStats(stats);
    }catch{}
  }
  function detach(){socket?.removeListener?.("message",message);socket=null;}
  function attach(){
    if(closed)return;
    const next=provider?.wsClient?.ws;
    if(next===socket)return;
    detach();
    if(next&&typeof next.on==="function"&&typeof next.removeListener==="function"){
      socket=next;socket.on("message",message);
    }
  }
  function state(value){if(value==="connected")attach();else detach();}
  provider.on("stateChange",state);provider.on("metadata",attach);
  attach();
  return ()=>{closed=true;detach();provider.removeListener?.("stateChange",state);provider.removeListener?.("metadata",attach);};
}
module.exports={readContributionStatistics,observeProviderStatistics};
