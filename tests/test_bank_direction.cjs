const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  const classified = [], storage = {}, downloads = [];
  let nextBlob;
  const context = {
    Blob, console, setTimeout() {}, clearTimeout() {},
    URL: { createObjectURL(blob) { nextBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    document: { getElementById() { return { classList: { toggle() {} } }; }, createElement() { return { click() { downloads.push(nextBlob); } }; } },
    localStorage: { setItem(key, value) { storage[key] = value; } },
    fetch() { throw new Error("No external API allowed"); }, classified,
  };
  const hook = `globalThis.api = { S, itemsFromCsv, ingest, save, exportCsv };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    judgeItems = async (items) => classified.push(...items);`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  context.api.S.master = {tax_categories:{}};
  return { api: context.api, classified, storage, downloads };
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
  ["consistent explicit direction remains unchanged", "支払先,出金額,入金額,区分\n架空店,1100,0,出金", [[1100, "out"]]],
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

const contradictions = [
  ["withdrawal and income", "支払先,出金額,入金額,区分\n架空店,1100,0,入金", 1],
  ["deposit and expense", "支払先,出金額,入金額,区分\n架空店,0,2200,出金", 1],
  ["withdrawal only and income", "支払先,出金額,区分\n架空店,1100,収入", 1],
  ["deposit only and expense", "支払先,入金額,区分\n架空店,2200,支出", 1],
  ["English withdrawal", "payee,withdrawal,type\nSynthetic,1100,income", 1],
  ["English credit", "payee,credit,direction\nSynthetic,2200,out", 1],
  ["full width amount", '支払先,出金額,区分\n架空店,"￥１，１００円",売上', 1],
  ["reversed columns", "区分,入金額,支払先,出金額\nexpense,2200,架空店,", 1],
  ["second row after a valid row", "支払先,出金額,入金額,区分\n架空A,3300,0,出金\n架空B,0,2200,出金", 2],
  ["withdrawal with an extra total", "支払先,出金額,金額,区分\n架空店,1100,1100,入金", 1],
];
for (const [name, csv, row] of contradictions) {
  test(`inconsistent bank direction ${name} preserves existing confirmed and held work`, async () => {
    const app = loadApp();
    app.api.S.items.push({id:"keep",date:"2026-10-15",payee:"架空店",amount:4400,direction:"out"}, {id:"held",amount:5500,direction:"in"});
    app.api.S.entries.keep = {status:"confirmed",account:"消耗品費",counter:"現金",amount:4400,taxCode:"none",memo:"確認済み"};
    app.api.S.entries.held = {status:"hold",amount:5500};
    app.api.S.results.keep = {confidence:0.9};
    assert.equal(app.api.save(), true);
    const before = JSON.stringify(app.api.S), stored = JSON.stringify(app.storage);
    await assert.rejects(async () => app.api.ingest(app.api.itemsFromCsv(csv), "synthetic.csv"), error =>
      error.message.includes(`データ${row}件目`) && /列と区分の収支が矛盾.*ファイル全体.*現在の取引は変更していません/.test(error.message));
    assert.equal(JSON.stringify(app.api.S), before);
    assert.equal(JSON.stringify(app.storage), stored);
    assert.equal(app.classified.length, 0);
    app.api.exportCsv();
    const exported = await app.downloads[0].text();
    assert.match(exported, /消耗品費,4400,現金,4400/);
    assert.doesNotMatch(exported, /5500/);
  });
}
const consistent = [
  ["withdrawal expense", "支払先,出金額,区分\n架空店,1100,出金", "out", 1100],
  ["deposit income", "支払先,入金額,区分\n架空店,2200,入金", "in", 2200],
  ["English expense", "payee,debit,type\nSynthetic,1100,expense", "out", 1100],
  ["English income", "payee,deposit,direction\nSynthetic,2200,income", "in", 2200],
  ["empty direction", "支払先,入金額,区分\n架空店,2200,", "in", 2200],
  ["no direction", "支払先,出金額\n架空店,1100", "out", 1100],
  ["amount-only income", "支払先,金額,区分\n架空店,2200,入金", "in", 2200],
  ["amount-only expense", "支払先,金額,区分\n架空店,1100,出金", "out", 1100],
  ["opposite zero", "支払先,入金額,出金額,区分\n架空店,2200,0,入金", "in", 2200],
  ["formatted currency", '支払先,出金額,区分\n架空店,"￥１，１００円",支出', "out", 1100],
];
for (const [name, csv, direction, amount] of consistent) {
  test(`consistent bank direction ${name} reaches classification and preserves CSV sides`, async () => {
    const app = loadApp();
    await app.api.ingest(app.api.itemsFromCsv(csv), "synthetic.csv");
    assert.equal(app.classified.length, 1);
    const item = app.api.S.items[0];
    assert.equal(item.direction, direction); assert.equal(item.amount, amount);
    app.api.S.entries[item.id] = {status:"confirmed",account:"科目",counter:"普通預金",amount,taxCode:"none",memo:"架空"};
    app.api.S.results[item.id] = {confidence:0.9};
    app.api.exportCsv();
    const exported = await app.downloads[0].text();
    assert.ok(exported.includes(direction === "in" ? `普通預金,${amount},科目,${amount}` : `科目,${amount},普通預金,${amount}`));
  });
}
