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
  const hook = `globalThis.api = { S, itemsFromCsv, ingest };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    judgeItems = async (items) => classified.push(...items);`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, classified, storage };
}

const invalid = [
 ["Japanese unknown amount", "支払先,金額\n架空店,不明", 1],
 ["English amount", "payee,amount\nSynthetic,abc", 1],
 ["withdrawal with valid deposit", "支払先,出金額,入金額\n架空店,abc,2200", 1],
 ["deposit with valid withdrawal", "支払先,出金額,入金額\n架空店,1100,abc", 1],
 ["amount even if withdrawal is valid", "支払先,金額,出金額\n架空店,不明,1100", 1],
 ["later row", "支払先,金額\n架空店A,1100\n架空店B,不明", 2],
 ["explicit NaN", "支払先,金額\n架空店,NaN", 1],
 ["positive infinity", "支払先,金額\n架空店,Infinity", 1],
 ["negative infinity even if deposit is valid", "支払先,出金額,入金額\n架空店,-Infinity,2200", 1],
 ["overflow", "payee,amount\nSynthetic,1e309", 1],
];
for (const [name, text, row] of invalid) {
 test(`invalid numeric CSV ${name} refuses the whole file and preserves confirmed work`, async () => {
  const app = loadApp();
  app.api.S.items.push({id:"keep",payee:"既存の架空店",amount:4400});
  app.api.S.entries.keep={account:"消耗品費",amount:4400,status:"confirmed"};
  const before=JSON.stringify(app.api.S);
  await assert.rejects(async()=>app.api.ingest(app.api.itemsFromCsv(text),"synthetic.csv"),
   error=>error.message.includes(`データ${row}件目`) && /(?:金額を数値にできません.*ファイル全体|金額が大きすぎ).*現在の取引は変更していません/.test(error.message));
  assert.equal(JSON.stringify(app.api.S),before);assert.deepEqual(app.storage,{});assert.equal(app.classified.length,0);
 });
}
const normal = [
 ["ordinary amount", "支払先,金額\n架空店,1100", [[1100,"out"]]],
 ["quoted currency", '支払先,金額\n架空店,"￥１，１００円"', [[1100,"out"]]],
 ["negative amount", "支払先,金額\n架空店,-2200", [[2200,"out"]]],
 ["empty cells", "支払先,金額\n架空店,", []],
 ["zero", "支払先,金額\n架空店,0", []],
 ["valid bank pair", "支払先,出金額,入金額\n架空店A,1100,\n架空店B,,2200", [[1100,"out"],[2200,"in"]]],
 ["zero opposite", "支払先,出金額,入金額\n架空店,0,2200", [[2200,"in"]]],
 ["decimal rounding", "支払先,金額\n架空店,1100.6", [[1101,"out"]]],
 ["scientific notation remains supported", "payee,amount\nSynthetic,1e3", [[1000,"out"]]],
 ["unrecognized text column remains supported", "支払先,金額,備考\n架空店,1100,不明", [[1100,"out"]]],
];
for (const [name,text,expected] of normal) {
 test(`valid numeric CSV ${name} keeps normal ingestion`, async()=>{
  const app=loadApp();await app.api.ingest(app.api.itemsFromCsv(text),"synthetic.csv");
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.S.items.map(x=>[x.amount,x.direction]))),expected);
  assert.equal(app.classified.length,expected.length);
 });
}
