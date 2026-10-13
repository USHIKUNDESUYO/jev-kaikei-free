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
  ["Japanese amount", "支払先,金額,金額\n架空店,1100,2200", 2, 3],
  ["English amount", "payee,amount,amount\n架空店,1100,2200", 2, 3],
  ["case", "payee,AMOUNT,amount\n架空店,1100,2200", 2, 3],
  ["whitespace", "支払先,金額, 金 額 \n架空店,1100,2200", 2, 3],
  ["quoted header", '支払先,"金額","金額"\n架空店,1100,2200', 2, 3],
  ["BOM", "\uFEFF支払先,金額,金額\n架空店,1100,2200", 2, 3],
  ["payee", "支払先,支払先,金額\n架空店A,架空店B,1100", 1, 2],
  ["date", "日付,日付,支払先,金額\n2026-10-13,2026-10-12,架空店,1100", 1, 2],
  ["memo", "支払先,金額,摘要,摘要\n架空店,1100,文具,書籍", 3, 4],
  ["unused metadata", "支払先,金額,管理番号,管理番号\n架空店,1100,A,B", 3, 4],
  ["header only", "支払先,金額,金額", 2, 3],
];
for (const [name, text, first, second] of invalid) {
  test(`duplicate CSV ${name} rejects before changing any work`, async () => {
    const app = loadApp();
    app.api.S.items.push({ id: "keep", payee: "既存の架空店", amount: 3300 });
    app.api.S.entries.keep = { account: "消耗品費", amount: 3300, status: "confirmed" };
    const before = JSON.stringify(app.api.S);
    await assert.rejects(async () => app.api.ingest(app.api.itemsFromCsv(text), "synthetic.csv"),
      (error) => error.message.includes(`${first}列目と${second}列目`) && /CSVのヘッダー.*重複.*現在の取引は変更していません/.test(error.message));
    assert.equal(JSON.stringify(app.api.S), before);
    assert.deepEqual(app.storage, {});
    assert.equal(app.classified.length, 0);
  });
}

const normal = [
  ["normal rows", "日付,支払先,金額,摘要\n2026-10-13,架空店A,1100,文具\n2026-10-13,架空店B,2200,書籍", 2, [1100, 2200]],
  ["single uppercase header", "payee,AMOUNT\n架空店,1100", 1, [1100]],
  ["single spaced header", "支 払先, 金 額 \n架空店,1100", 1, [1100]],
  ["quoted values", '支払先,金額,摘要\n"架空,店","1,100","文具"', 1, [1100]],
  ["blank metadata columns", "支払先,金額,,\n架空店,1100,A,B", 1, [1100]],
  ["different alias names", "支払先,金額,amount\n架空店,1100,2200", 1, [1100]],
  ["income and expense", "支払先,出金額,入金額\n架空店A,1100,\n架空店B,,2200", 2, [1100, 2200]],
  ["header only", "支払先,金額", 0, []],
  ["empty file", "\n\r\n", 0, []],
];
for (const [name, text, count, amounts] of normal) {
  test(`valid CSV ${name} keeps existing interpretation`, () => {
    const app = loadApp();
    const items = app.api.itemsFromCsv(text);
    assert.equal(items.length, count);
    assert.deepEqual(JSON.parse(JSON.stringify(items.map((x) => x.amount))), amounts);
    assert.equal(app.api.S.items.length, 0);
    assert.deepEqual(app.storage, {});
    assert.equal(app.classified.length, 0);
  });
}
