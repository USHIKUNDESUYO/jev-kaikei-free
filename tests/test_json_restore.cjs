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

test("actual JSON export restores every review state, modified amount and memo", async () => {
  const original = loadApp();
  const rows = ["auto", "review", "confirmed", "hold"].map((status, i) => record(status, "old" + i));
  rows.push({ item: { ...record().item, id: "pending" }, jev: null, entry: null });
  for (const row of rows) {
    original.api.S.items.push(row.item);
    if (row.jev) original.api.S.results[row.item.id] = row.jev;
    if (row.entry) original.api.S.entries[row.item.id] = row.entry;
  }
  original.api.exportJson();
  const restored = loadApp();
  await restored.api.importJson(await original.downloads[0].text(), "saved.json");
  assert.equal(restored.api.S.items.length, 5);
  for (const [i, item] of restored.api.S.items.entries()) {
    assert.equal(item.amount, 1100);
    assert.equal(item.payee, rows[i].item.payee);
    assert.equal(item.date, rows[i].item.date);
    assert.deepEqual(plain(restored.api.S.entries[item.id] || null), rows[i].entry);
    if (i < 4) assert.equal(restored.api.S.results[item.id].id, item.id);
  }
  assert.equal(restored.classified.length, 0);
  assert.equal(JSON.parse(restored.storage["jev-kaikei:v1"]).items.length, 5);
  restored.api.exportCsv();
  const csv = await restored.downloads[0].text();
  assert.match(csv, /2200/);
  assert.match(csv, /確認後の架空摘要/);
  assert.doesNotMatch(csv, /Infinity|NaN/);
});
test("append keeps existing work and settings; duplicate source IDs are remapped", async () => {
  const { api } = loadApp();
  api.S.items.push({ id: "keep", payee: "既存の架空店" });
  const before = plain(api.S.settings);
  await api.importJson(JSON.stringify(saved([record("confirmed", "same"), record("hold", "same")])), "saved.json");
  assert.equal(api.S.items[0].id, "keep");
  assert.equal(new Set(api.S.items.map((item) => item.id)).size, 3);
  assert.deepEqual(plain(api.S.settings), before);
  assert.equal(api.S.threshold, 0.8);
});
test("one invalid record rejects the whole file without changing prior work", async () => {
  const { api } = loadApp();
  api.S.items.push({ id: "keep" });
  const invalid = record(); invalid.entry.amount = "2200";
  await assert.rejects(api.importJson(JSON.stringify(saved([record(), invalid])), "bad.json"), /2件目/);
  assert.deepEqual(plain(api.S.items), [{ id: "keep" }]);
  assert.equal(api.S.seq, 0);
});
test("unsafe item amount, unknown status and incomplete judgment are rejected", async () => {
  for (const change of [
    (r) => { r.item.amount = 1e30; },
    (r) => { r.entry.status = "unknown"; },
    (r) => { r.jev = null; },
    (r) => { r.entry = null; },
    (r) => { r.jev.confidence = 2; },
  ]) {
    const { api } = loadApp(); const row = record(); change(row);
    await assert.rejects(api.importJson(JSON.stringify(saved([row])), "bad.json"));
    assert.equal(api.S.items.length, 0);
  }
});
test("malformed JSON leaves current data intact", async () => {
  const { api } = loadApp(); api.S.items.push({ id: "keep" });
  await assert.rejects(api.importJson('{"records":', "broken.json"));
  assert.equal(api.S.items[0].id, "keep");
});
test("active classification and animation defer restoration", async () => {
  for (const key of ["judging", "riding", "queue"]) {
    const { api } = loadApp(); api.S[key] = key === "queue" ? ["pending"] : {};
    await assert.rejects(api.importJson(JSON.stringify(saved([record()])), "saved.json"), /終わってから/);
    assert.equal(api.S.items.length, 0);
  }
});
test("empty saved archive leaves existing work intact", async () => {
  const { api } = loadApp(); api.S.items.push({ id: "keep" });
  await api.importJson(JSON.stringify(saved([])), "empty.json");
  assert.equal(api.S.items.length, 1);
});
test("ordinary sample JSON forms retain their original input path", async () => {
  for (const shape of ["array", "items", "records"]) {
    const { api, classified } = loadApp();
    const rows = [{ date: "2026-10-12", payee: "架空文具店", amount: 1100 }];
    const data = shape === "array" ? rows : { [shape]: rows };
    await api.importJson(JSON.stringify(data), "input.json");
    assert.equal(api.S.items.length, 1);
    assert.equal(classified.length, 1);
    assert.equal(api.S.items[0].amount, 1100);
  }
});
