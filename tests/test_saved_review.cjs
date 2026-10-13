const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  const downloads = [], classified = [], storage = {};
  let nextBlob;
  const context = {
    Blob, console, setTimeout() {}, clearTimeout() {},
    URL: { createObjectURL(blob) { nextBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    document: {
      querySelectorAll() { return []; },
      createElement() { return { click() { downloads.push(nextBlob); } }; },
      getElementById() { return { dataset: {}, classList: { toggle() {} } }; },
    },
    localStorage: { setItem(key, value) { storage[key] = value; } },
    fetch() { throw new Error("Saved records must not call an API"); },
    classified,
  };
  const hook = `globalThis.api = { S, importJson, exportJson, exportCsv, itemsFromCsv, actualRenderReview: renderReview };
    renderConfirmed = () => {}; renderReviewCounters = () => {}; uniqueCounters = () => []; fillSelect = () => {}; syncAmounts = () => {};
    updateCounters = () => {}; renderBuckets = () => {}; renderStatus = () => {}; renderReview = () => {};
    judgeItems = async (items) => { classified.push(...items); };`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  context.api.S.master = { tax_categories: { tax: { rate: 10, label_out: "課税仕入10%", label_in: "課税売上10%" } } };
  return { api: context.api, downloads, classified, storage };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function record(status = "confirmed", id = "original") {
  return {
    item: { id, date: "2026-10-12", payee: "架空文具店", memo: "架空資料", amount: 1100, method: "cash", direction: "out", counterparty: "", source: "fixture" },
    jev: { id, confidence: 0.92, account: "消耗品費", account_code: "supplies", tax_code: "tax", counter_account: "現金" },
    entry: { status, debitCode: "supplies", account: "消耗品費", taxCode: "tax", amount: 2200, counter: "現金", memo: "確認後の架空摘要", modified: true },
  };
}
function saved(records) { return { settings: { entity: "houjin", business: "archive" }, threshold: 0.99, records }; }


const invalid = [
 ["candidates object", "candidates", {}], ["candidates null", "candidates", null],
 ["candidates string", "candidates", "none"], ["candidates number", "candidates", 1],
 ["candidate null", "candidates", [null]], ["candidate string", "candidates", ["費用"]],
 ["candidate empty object", "candidates", [{}]], ["candidate account number", "candidates", [{account:1,p:0.5}]],
 ["candidate probability string", "candidates", [{account:"費用",p:"0.5"}]], ["candidate probability null", "candidates", [{account:"費用",p:null}]],
 ["candidate probability negative", "candidates", [{account:"費用",p:-0.1}]], ["candidate probability above one", "candidates", [{account:"費用",p:1.1}]],
 ["hints object", "hints", {}], ["hints null", "hints", null], ["hints string", "hints", "注意"], ["hint number", "hints", [1]],
];
for(const [name,key,value] of invalid) test(name+" rejects before restoring any record or changing confirmed work",async()=>{
 const app=loadApp();await app.api.importJson(JSON.stringify(saved([record()])),"kept.json");const before=JSON.stringify(app.api.S),stored=app.storage["jev-kaikei:v1"];const bad=record("review");bad.jev[key]=value;
 await assert.rejects(app.api.importJson(JSON.stringify(saved([record(),bad])),"invalid.json"),new RegExp("保存JSONの2件目: "+key+".*現在の取引は変更していません"));
 assert.equal(JSON.stringify(app.api.S),before);assert.equal(app.storage["jev-kaikei:v1"],stored);assert.equal(app.classified.length,0);app.api.exportCsv();assert.match(await app.downloads[0].text(),/,2200,/);
});
for(const lists of [ {candidates:[],hints:[]}, {candidates:[{account:"消耗品費",p:0},{account:"費用",p:1}],hints:["架空の確認事項"]} ]) test("valid review lists display in the actual review renderer",async()=>{
 const app=loadApp(),row=record("review");Object.assign(row.jev,lists);await app.api.importJson(JSON.stringify(saved([row])),"valid.json");app.api.S.reviewAll=true;assert.doesNotThrow(()=>app.api.actualRenderReview());assert.equal(app.classified.length,0);
});
test("legacy omitted lists are normalized to empty arrays and remain reviewable",async()=>{
 const app=loadApp();await app.api.importJson(JSON.stringify(saved([record("review")])),"legacy.json");const r=app.api.S.results[app.api.S.items[0].id];assert.deepEqual(plain(r.candidates),[]);assert.deepEqual(plain(r.hints),[]);app.api.S.reviewAll=true;assert.doesNotThrow(()=>app.api.actualRenderReview());
});
test("actual export restores candidate and hint text without changing CSV",async()=>{
 const a=loadApp(),b=loadApp(),row=record();row.jev.candidates=[{account:"消耗品費",p:0.92}];row.jev.hints=["架空確認"];await a.api.importJson(JSON.stringify(saved([row])),"valid.json");a.api.exportJson();await b.api.importJson(await a.downloads[0].text(),"saved.json");a.api.exportCsv();b.api.exportCsv();assert.equal(await a.downloads[1].text(),await b.downloads[0].text());assert.deepEqual(plain(b.api.S.results[b.api.S.items[0].id].hints),row.jev.hints);
});
