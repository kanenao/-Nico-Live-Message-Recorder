"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const src=fs.readFileSync(path.join(__dirname,"..","renderer.js"),"utf8");
const {patch,valid}=vm.runInNewContext(src.slice(src.indexOf("function hasRankingRowLayout("),src.indexOf("function captureRankingScroll("))+"\n({patch:patchRankingRow,valid:hasRankingRowLayout})");
const classes=["ranking-rank","ranking-program","ranking-total-score","ranking-view-metrics","ranking-active-metric","ranking-support-metrics","ranking-actions"];
function row(prefix){
 const result={cells:[],dataset:{liveId:"lv123456",actionKey:prefix,renderKey:prefix}};
 const picture={replaceWith(){throw Error("unchanged picture should remain");}};
 const labels={outerHTML:"same"};
 const identity={querySelector:s=>s===".ranking-media"?null:labels};
 for(const [i,name] of classes.entries()){
  const cell={name,outerHTML:prefix+i,parent:result,classList:{contains:v=>v===name},
   querySelector:s=>s===".ranking-identity"?identity:s===".ranking-media"?picture:labels,
   replaceWith(next){
    if(!next)throw Error("cannot insert undefined");
    const index=this.parent.cells.indexOf(this);
    const from=next.parent.cells.indexOf(next);
    next.parent.cells.splice(from,1);
    this.parent.cells[index]=next;next.parent=this.parent;
   }};
  result.cells.push(cell);
 }
 return result;
}
test("ranking patch keeps all seven columns when replacement moves cells out of the source row",()=>{
 const old=row("old"),next=row("new");
 assert.equal(valid(old),true);
 const result=patch(old,next,"new");
 assert.equal(result,old);
 assert.deepEqual(result.cells.map(c=>c.name),classes);
 assert.deepEqual(result.cells.map(c=>c.outerHTML),["new0","old1","new2","new3","new4","new5","new6"]);
 assert.equal(valid(result),true);
 assert.equal(result.dataset.renderKey,"new");
 const newer=row("again");
 patch(result,newer,"again");
 assert.deepEqual(result.cells.map(c=>c.name),classes);
 assert.equal(result.cells[6].outerHTML,"again6");
});
test("previously corrupted ranking rows are rejected before reuse",()=>{
 const old=row("old");old.cells[4]=old.cells[6];
 assert.equal(valid(old),false);
 assert.equal(valid(null),false);
 assert.match(src,/const old=hasRankingRowLayout\(cached\)\?cached:null/);
});
