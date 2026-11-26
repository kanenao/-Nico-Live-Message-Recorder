"use strict";
const { buildFeedbackIssueUrl } = require("./feedback-url.cjs");
async function submitFeedback(input, {endpoint, fetchImpl = globalThis.fetch} = {}) {
  // Reuse the existing allowlist, length and credential validation.
  buildFeedbackIssueUrl(input);
  let url;
  try { url = new URL(endpoint); } catch { throw Error("報告受付サービスが未設定です。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw Error("報告受付先の設定が正しくありません。");
  let response;
  try {
    response = await fetchImpl(url, {method:"POST", redirect:"error", signal:AbortSignal.timeout(15000),
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({kind:input.kind, edition:input.edition, version:input.version, details:String(input.details).trim()})});
  } catch { throw Error("受付サービスに接続できません。通信状況を確認して再試行してください。"); }
  if (!response.ok) throw Error(response.status===409 ? "以前の送信結果を確認中です。重複防止のため開発側で受付状況を確認してください。" : response.status===429 ? "送信が集中しています。しばらくして再試行してください。" : "受付サービスが送信を受理できませんでした (HTTP "+response.status+")。");
  const data=await response.json().catch(()=>null);
  if (!Number.isSafeInteger(data?.number)||data.number<1) throw Error("受付番号を確認できませんでした。");
  return {number:data.number};
}
module.exports={submitFeedback};
