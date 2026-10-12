const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Run the real application functions with only rendering and classification stubbed.
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
    fetch() { throw new Error("No external API is allowed in this test"); },
    classified,
  };
  const hook = `globalThis.api = { S, itemsFromCsv, importJson, ingest, exportJson };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    judgeItems = async (items) => { classified.push(...items); };`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, downloads, classified, storage };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const header = "日付,支払先,金額,摘要\n";
const validRow = "2026-10-12,架空店A,1100,文具\n";
const transaction = { date: "2026-10-12", payee: "架空店A", memo: "文具", amount: 1100 };

async function rejectedCsv(text, pattern) {
  const { api, classified, storage } = loadApp();
  api.S.items.push({ id: "keep", payee: "既存の架空店" });
  const before = plain(api.S);
  await assert.rejects(async () => api.ingest(api.itemsFromCsv(text), "fixture.csv"), pattern);
  assert.deepEqual(plain(api.S), before);
  assert.equal(classified.length, 0);
  assert.deepEqual(storage, {});
}
async function rejectedJson(rows, pattern) {
  const { api, classified, storage } = loadApp();
  api.S.items.push({ id: "keep", payee: "既存の架空店" });
  const before = plain(api.S);
  await assert.rejects(api.importJson(JSON.stringify(rows), "fixture.json"), pattern);
  assert.deepEqual(plain(api.S), before);
  assert.equal(classified.length, 0);
  assert.deepEqual(storage, {});
}

test("unclosed quote cannot swallow a later transaction", async () => {
  await rejectedCsv(header + '2026-10-12,架空店A,1100,"未閉鎖\n2026-10-12,架空店B,2200,文具', /データ1件目.*引用符が閉じていません/);
});
test("extra column rejects even earlier valid rows", async () => {
  await rejectedCsv(header + validRow + "2026-10-12,架空店B,余分,2200,文具", /データ2件目.*4列に対して5列/);
});
test("missing trailing column rejects the whole file", async () => {
  await rejectedCsv(header + validRow + "2026-10-12,架空店B,2200", /データ2件目.*4列に対して3列/);
});
test("quote within an unquoted field is not stripped", async () => {
  await rejectedCsv(header + '2026-10-12,架空"店A",1100,文具', /データ1件目.*項目の先頭/);
});
test("characters after a closing quote are not merged", async () => {
  await rejectedCsv(header + '2026-10-12,"架空店"追加,1100,文具', /データ1件目.*余分な文字/);
});
test("malformed header is identified before data import", async () => {
  await rejectedCsv('"日付,支払先,金額,摘要\n' + validRow, /ヘッダー.*引用符が閉じていません/);
});
test("quoted commas, line breaks and doubled quotes preserve two transactions", () => {
  const { api } = loadApp();
  const rows = api.itemsFromCsv(header + '2026-10-12,"架空店,A","1,100","架空\n資料 ""文具"""\n' + validRow);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payee, "架空店,A");
  assert.equal(rows[0].memo, '架空\n資料 "文具"');
  assert.equal(rows[0].amount, 1100);
});
test("BOM, CRLF, blank lines, spaces and empty trailing cell are accepted", () => {
  const { api } = loadApp();
  const rows = api.itemsFromCsv('\uFEFF' + header.replace(/\n/g, '\r\n') + '\r\n , , , \r\n2026-10-12,  "架空店" \t,1100,\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payee, "架空店");
  assert.equal(rows[0].memo, "");
});
test("column error counts logical data records after quoted newlines and blank lines", async () => {
  await rejectedCsv(header + '\n2026-10-12,架空店A,1100,"複数\n行"\n\n2026-10-12,架空店B,2200', /データ2件目.*列数/);
});
test("valid bank debit and credit columns retain direction", () => {
  const { api } = loadApp();
  const rows = api.itemsFromCsv('日付,摘要,出金,入金\n2026-10-12,架空出金,1100,\n2026-10-12,架空入金,,2200');
  assert.deepEqual(plain(rows.map((r) => [r.amount, r.direction])), [[1100, "out"], [2200, "in"]]);
});
test("object payee is rejected before any transaction or ID is added", async () => {
  await rejectedJson([transaction, { ...transaction, payee: { name: "架空店B" } }], /データ2件目.*payee.*文字列/);
});
test("array memo and numeric Japanese payee alias are rejected", async () => {
  await rejectedJson([transaction, { ...transaction, memo: ["文具"] }], /データ2件目.*memo.*文字列/);
  await rejectedJson([{ 支払先: 123, 金額: 1100 }], /データ1件目.*支払先.*文字列/);
});
test("object amount is not coerced to a silent skipped row", async () => {
  await rejectedJson([transaction, { ...transaction, amount: { value: 1100 } }], /データ2件目.*amount.*数値または文字列/);
});
test("invalid transaction rows and envelopes leave current work intact", async () => {
  for (const row of [null, 1, "取引", [], true]) {
    await rejectedJson([transaction, row], /データ2件目.*オブジェクト/);
  }
  for (const data of [null, 1, "入力", {}, { items: {} }, { records: null }]) {
    await rejectedJson(data, /取引の配列/);
  }
});
test("valid array, items and ordinary records import and saved export all restore", async () => {
  for (const input of [[transaction], { items: [transaction] }, { records: [transaction] }]) {
    const original = loadApp();
    await original.api.importJson(JSON.stringify(input), "fixture.json");
    assert.equal(original.api.S.items.length, 1);
    original.api.exportJson();
    const restored = loadApp();
    await restored.api.importJson(await original.downloads[0].text(), "saved.json");
    assert.equal(restored.api.S.items.length, 1);
    assert.equal(restored.api.S.items[0].payee, transaction.payee);
    assert.equal(restored.classified.length, 0);
  }
});
test("Japanese aliases, fullwidth money and null optional strings remain supported", async () => {
  const { api } = loadApp();
  await api.importJson(JSON.stringify([{ 日付: "2026年10月12日", 支払先: "架空店", 摘要: null, 金額: "￥１，１００円", 支払方法: "銀行", 区分: "入金" }]), "fixture.json");
  const row = api.S.items[0];
  assert.equal(row.date, "2026-10-12");
  assert.equal(row.memo, "");
  assert.equal(row.amount, 1100);
  assert.equal(row.method, "bank");
  assert.equal(row.direction, "in");
});
test("an empty valid array remains an empty import", async () => {
  const { api, classified } = loadApp();
  await api.importJson("[]", "empty.json");
  assert.equal(api.S.items.length, 0);
  assert.equal(api.S.seq, 0);
  assert.equal(classified.length, 0);
});
