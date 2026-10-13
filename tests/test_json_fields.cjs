const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  const classified = [], storage = {}, messages = [];
  const context = {
    Blob, console, setTimeout() {}, clearTimeout() {},
    document: { getElementById() { return { classList: { toggle() {} } }; } },
    localStorage: { setItem(key, value) { storage[key] = value; } },
    fetch() { throw new Error("No external API allowed"); }, classified, messages,
  };
  const hook = `globalThis.api = { S, itemsFromCsv, itemsFromJson, parseUniqueJson, importJson, ingest };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    toast = (message) => messages.push(message);
    judgeItems = async (items) => classified.push(...items);`;
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, classified, storage, messages };
}

const row = () => ({ date: "2026-10-13", payee: "架空店", memo: "文具", amount: 1100, method: "cash", direction: "out" });
const entry = { account: "消耗品費", counter: "現金", taxCode: "対象外", memo: "文具", amount: 1100, status: "hold" };
const saved = () => ({ records: [{ item: row(), jev: null, entry: null }] });
const statusDuplicate = JSON.stringify({ records: [{ item: row(), jev: { confidence: 0.5 }, entry }] }).replace('"status":"hold"', '"status":"hold","status":"confirmed"');
const invalid = [
  ["input amount", '[{"amount":1100,"amount":2200}]', "amount"],
  ["later transaction amount", '[{"payee":"架空店A","amount":3300},{"payee":"架空店B","amount":1100,"amount":2200}]', "amount"],
  ["escaped amount", '[{"amount":1100,"\\u0061mount":2200}]', "amount"],
  ["saved amount", JSON.stringify(saved()).replace('"amount":1100', '"amount":1100,"amount":2200'), "amount"],
  ["saved confirmation", statusDuplicate, "status"],
  ["root items", '{"items":[{"amount":1100}],"items":[{"amount":2200}]}', "items"],
  ["root records", '{"records":[],"records":[{"amount":2200}]}', "records"],
  ["unused metadata", '{"items":[{"amount":1100}],"metadata":{"rate":0,"rate":1}}', "rate"],
  ["prototype name", '{"items":[],"metadata":{"__proto__":0,"__proto__":1}}', "__proto__"],
  ["Japanese key", '[{"金額":1100,"金額":2200}]', "金額"],
  ["empty name", '{"items":[],"metadata":{"":0,"":1}}', ""],
];
for (const [name, text, key] of invalid) {
  test(`duplicate ${name} rejects the whole file before work changes`, async () => {
    const app = loadApp();
    app.api.S.items.push({ ...row(), id: "keep" });
    app.api.S.entries.keep = { ...entry, status: "confirmed" };
    const before = JSON.stringify(app.api.S);
    await assert.rejects(app.api.importJson(text, "synthetic.json"), (error) => error.message.includes(JSON.stringify(key)) && /重複.*現在の取引は変更していません/.test(error.message));
    assert.equal(JSON.stringify(app.api.S), before);
    assert.deepEqual(app.storage, {});
    assert.equal(app.classified.length, 0);
  });
}
const normal = [
  JSON.stringify([row(), { ...row(), amount: 2200 }]),
  JSON.stringify([{ ...row(), memo: '{"amount":1,"amount":2}' }]),
  JSON.stringify([{ ...row(), memo: 'slashes \\ and quote " and colon : comma , brackets [] {}' }]),
  '{"items":[{"payee":"架空店","\\u0061mount":1100}]}',
  '{"items":[{"payee":"架空店","amount":1100}],"metadata":{"__proto__":1,"constructor":2}}',
  '{"items":[{"payee":"架空店","amount":1100}],"metadata":[{"name":"x"},{"name":"y"}]}',
  '{"items":[{"payee":"架空店","amount":1100}],"metadata":{"":true,"nested":{"":false}}}',
  '{"items":[{"payee":"架空店","amount":1100}],"metadata":[null,true,false,-1.2e3,"{ } [ ] , :"]}',
];
for (const [i, text] of normal.entries()) {
  test(`valid JSON case ${i + 1} preserves values and imports normally`, async () => {
    const app = loadApp();
    assert.equal(JSON.stringify(app.api.parseUniqueJson(text)), JSON.stringify(JSON.parse(text)));
    await app.api.importJson(text, "synthetic.json");
    assert.equal(app.api.S.items.length, i === 0 ? 2 : 1);
    assert.equal(app.api.S.items[0].amount, 1100);
    assert.equal(app.classified.length, app.api.S.items.length);
    assert.ok(app.storage["jev-kaikei:v1"]);
  });
}
test("normal saved records restore confirmation without classification", async () => {
  const app = loadApp();
  await app.api.importJson(JSON.stringify({ records: [{ item: row(), jev: { confidence: 0.5 }, entry }, { item: row(), jev: null, entry: null }] }), "synthetic.json");
  assert.equal(app.api.S.items.length, 2);
  assert.equal(Object.values(app.api.S.entries)[0].status, "hold");
  assert.equal(app.classified.length, 0);
  assert.ok(app.storage["jev-kaikei:v1"]);
});
test("deep valid arrays need no recursive scanner stack", () => {
  const app = loadApp(); const depth = 3000;
  let data = app.api.parseUniqueJson('['.repeat(depth) + '0' + ']'.repeat(depth));
  for (let i = 0; i < depth; i++) data = data[0];
  assert.equal(data, 0);
});
test("direct JSON conversion also refuses duplicates", () => {
  assert.throws(() => loadApp().api.itemsFromJson('[{"amount":1,"amount":2}]'), /重複/);
});
for (const text of ['[{"amount":1100,}]', '[{"amount":1100}', '{"items":[{"amount":1100}],"memo":"bad\\x"}']) {
  test(`malformed JSON stays rejected without changing work: ${text}`, async () => {
    const app = loadApp(); const before = JSON.stringify(app.api.S);
    await assert.rejects(app.api.importJson(text, "synthetic.json"));
    assert.equal(JSON.stringify(app.api.S), before);
    assert.deepEqual(app.storage, {});
    assert.equal(app.classified.length, 0);
  });
}
