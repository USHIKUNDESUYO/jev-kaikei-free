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
      createElement() { return { click() { downloads.push(nextBlob); } }; },
      getElementById() { return { classList: { toggle() {} } }; },
    },
    localStorage: { setItem(key, value) { storage[key] = value; } },
    fetch() { throw new Error("Saved records must not call an API"); },
    classified,
  };
  const hook = `globalThis.api = { S, importJson, exportJson, exportCsv, itemsFromCsv };
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


for(const status of ["auto","review","confirmed","hold"]){
 test(`saved zero amount in ${status} rejects the whole archive and retains confirmed work`,async()=>{
  const app=loadApp();await app.api.importJson(JSON.stringify(saved([record()])),"kept.json");
  const before=JSON.stringify(app.api.S), stored=app.storage["jev-kaikei:v1"];const bad=record(status);bad.entry.amount=0;
  await assert.rejects(app.api.importJson(JSON.stringify(saved([record(),bad])),"invalid.json"),/保存JSONの2件目が不正.*現在の取引は変更していません/);
  assert.equal(JSON.stringify(app.api.S),before);assert.equal(app.storage["jev-kaikei:v1"],stored);assert.equal(app.classified.length,0);
  app.api.exportCsv();const csv=await app.downloads[0].text();assert.equal(csv.split("\r\n").length,2);assert.match(csv,/,2200,/);
 });
 test(`positive saved ${status} keeps its state and amount`,async()=>{
  const app=loadApp();const row=record(status);await app.api.importJson(JSON.stringify(saved([row])),"valid.json");
  const entry=app.api.S.entries[app.api.S.items[0].id];assert.equal(entry.status,status);assert.equal(entry.amount,2200);assert.equal(app.classified.length,0);
 });
}
test("positive human-modified amount different from original transaction remains supported",async()=>{
 const app=loadApp();const row=record();row.entry.amount=3300;await app.api.importJson(JSON.stringify(saved([row])),"changed.json");assert.equal(app.api.S.items[0].amount,1100);assert.equal(app.api.S.entries[app.api.S.items[0].id].amount,3300);
});
test("unclassified saved transaction with null entry still restores",async()=>{
 const app=loadApp();const row=record();row.jev=null;row.entry=null;await app.api.importJson(JSON.stringify(saved([row])),"pending.json");assert.equal(app.api.S.items.length,1);assert.deepEqual(plain(app.api.S.entries),{});assert.equal(app.classified.length,0);
});
test("negative zero is rejected before allocating IDs or writing storage",async()=>{
 const app=loadApp();const row=record();row.entry.amount=-0;const before=JSON.stringify(app.api.S);await assert.rejects(app.api.importJson(JSON.stringify(saved([row])),"negative-zero.json"));assert.equal(JSON.stringify(app.api.S),before);assert.deepEqual(app.storage,{});
});
test("actual positive export remains byte-identical after restoration",async()=>{
 const a=loadApp(),b=loadApp();await a.api.importJson(JSON.stringify(saved([record()])),"valid.json");a.api.exportJson();await b.api.importJson(await a.downloads[0].text(),"saved.json");a.api.exportCsv();b.api.exportCsv();assert.equal(await a.downloads[1].text(),await b.downloads[0].text());
});
