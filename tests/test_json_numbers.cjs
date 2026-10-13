const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  const classified = [], storage = {};
  const context = {
    Blob, console, setTimeout() {}, clearTimeout() {},
    document: { getElementById() { return { classList: { toggle() {} } }; } },
    localStorage: { setItem(key, value) { storage[key] = value; } },
    fetch() { throw new Error("No external API allowed"); }, classified,
  };
  const hook = `globalThis.api = { S, itemsFromJson, importJson, ingest };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    judgeItems = async (items) => classified.push(...items);`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, classified, storage };
}

const tx = {payee:"架空店",amount:1100};
const invalid = [
 ["unknown amount", [{...tx,amount:"不明"}], 1, "amount"],
 ["Japanese amount", [{支払先:"架空店",金額:"abc"}], 1, "金額"],
 ["later row", [tx,{...tx,amount:"不明"}], 2, "amount"],
 ["items envelope", {items:[tx,{...tx,amount:"?"}]}, 2, "amount"],
 ["ordinary records envelope", {records:[tx,{...tx,amount:"abc"}]}, 2, "amount"],
 ["explicit NaN string", [{...tx,amount:"NaN"}], 1, "amount"],
 ["infinity string", [{...tx,amount:"Infinity"}], 1, "amount"],
 ["JSON numeric overflow", "[{\"payee\":\"架空店\",\"amount\":1e309}]", 1, "amount"],
 ["unused invalid Japanese alias", [{...tx,金額:"不明"}], 1, "金額"],
 ["unused negative infinity alias", [{...tx,金額:"-Infinity"}], 1, "金額"],
];
for (const [name,data,row,key] of invalid) {
 test(`invalid numeric JSON ${name} refuses the whole file and preserves confirmed work`, async()=>{
  const app=loadApp();
  app.api.S.items.push({id:"keep",payee:"既存の架空店",amount:4400});
  app.api.S.entries.keep={account:"消耗品費",amount:4400,status:"confirmed"};
  const before=JSON.stringify(app.api.S);
  await assert.rejects(app.api.importJson(typeof data==="string" ? data:JSON.stringify(data),"synthetic.json"),
    e=>e.message.includes(`データ${row}件目`) && e.message.includes(key) && /(?:数値にできません|金額が大きすぎ)/.test(e.message) && e.message.includes("ファイル全体を読み込んでいません") && e.message.includes("現在の取引は変更していません"));
  assert.equal(JSON.stringify(app.api.S),before);assert.deepEqual(app.storage,{});assert.equal(app.classified.length,0);
 });
}
const normal = [
 ["number", [tx], [[1100,"out"]]],
 ["fullwidth currency", [{...tx,amount:"￥１，１００円"}], [[1100,"out"]]],
 ["Japanese alias with null primary", [{支払先:"架空店",amount:null,金額:2200}], [[2200,"out"]]],
 ["missing", [{payee:"架空店"}], []],
 ["blank", [{...tx,amount:"  "}], []],
 ["zero", [{...tx,amount:0}], []],
 ["decimal rounding", [{...tx,amount:1100.6}], [[1101,"out"]]],
 ["income and negative", {items:[{...tx,amount:-2200,direction:"in"}]}, [[2200,"in"]]],
 ["scientific notation", {records:[{...tx,amount:"1e3"}]}, [[1000,"out"]]],
 ["non-numeric memo", [{...tx,memo:"不明",金額:""}], [[1100,"out"]]],
];
for(const [name,data,expected] of normal){
 test(`valid numeric JSON ${name} keeps normal ingestion`,async()=>{
  const app=loadApp();await app.api.importJson(JSON.stringify(data),"synthetic.json");
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.S.items.map(x=>[x.amount,x.direction]))),expected);
  assert.equal(app.classified.length,expected.length);
 });
}
