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
  ["Japanese bank columns", "支払先,出金額,入金額\n架空店,1100,2200", 1],
  ["debit and credit", "payee,debit,credit\n架空店,1100,2200", 1],
  ["withdrawal and deposit", "payee,withdrawal,deposit\n架空店,1100,2200", 1],
  ["full-width currency", '支払先,出金,入金\n架空店,"￥１，１００円","￥２，２００円"', 1],
  ["equal amounts", "支払先,出金額,入金額\n架空店,1100,1100", 1],
  ["explicit income", "支払先,出金額,入金額,区分\n架空店,1100,2200,入金", 1],
  ["explicit expense", "支払先,出金額,入金額,区分\n架空店,1100,2200,出金", 1],
  ["extra total column", "支払先,出金額,入金額,金額\n架空店,1100,2200,3300", 1],
  ["later ambiguous row", "支払先,出金額,入金額\n架空店A,3300,\n架空店B,1100,2200", 2],
  ["reversed columns and quoted decimals", '支払先,入金額,出金額\n"架空,店","2,200.5","1,100.5"', 1],
];
for (const [name, text, row] of invalid) {
  test(`ambiguous bank CSV ${name} rejects the whole file and preserves confirmed work`, async () => {
    const app = loadApp();
    app.api.S.items.push({ id: "keep", payee: "既存の架空店", amount: 4400 });
    app.api.S.entries.keep = { account: "消耗品費", amount: 4400, status: "confirmed" };
    const before = JSON.stringify(app.api.S);
    await assert.rejects(async () => app.api.ingest(app.api.itemsFromCsv(text), "synthetic.csv"),
      (error) => error.message.includes(`データ${row}件目`) && /出金と入金の両方.*ファイル全体.*現在の取引は変更していません/.test(error.message));
    assert.equal(JSON.stringify(app.api.S), before);
    assert.deepEqual(app.storage, {});
    assert.equal(app.classified.length, 0);
  });
}

const normal = [
  ["empty opposite cells", "支払先,出金額,入金額\n架空店A,1100,\n架空店B,,2200", [[1100, "out"], [2200, "in"]]],
  ["zero opposite cells", "支払先,出金額,入金額\n架空店A,1100,0\n架空店B,0,2200", [[1100, "out"], [2200, "in"]]],
  ["withdrawal only", "支払先,出金額\n架空店,1100", [[1100, "out"]]],
  ["deposit only", "支払先,入金額\n架空店,2200", [[2200, "in"]]],
  ["ordinary amount", "支払先,金額\n架空店,-3300", [[3300, "out"]]],
  ["explicit direction remains unchanged", "支払先,出金額,入金額,区分\n架空店,1100,0,入金", [[1100, "in"]]],
  ["decimal rounding remains unchanged", "支払先,出金額,入金額\n架空店,1100.6,0", [[1101, "out"]]],
  ["spaces and English aliases", "payee,WITHDRAWAL,deposit\n架空店, ,2200", [[2200, "in"]]],
  ["both zero", "支払先,出金額,入金額\n架空店,0,0", []],
  ["header only", "支払先,出金額,入金額", []],
];
for (const [name, text, expected] of normal) {
  test(`valid bank CSV ${name} keeps amount, direction and normal ingestion`, async () => {
    const app = loadApp();
    await app.api.ingest(app.api.itemsFromCsv(text), "synthetic.csv");
    const actual = app.api.S.items.map((item) => [item.amount, item.direction]);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
    assert.equal(app.classified.length, expected.length);
  });
}
