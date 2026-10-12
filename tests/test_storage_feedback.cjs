const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  const nodes = new Map(), messages = [], downloads = [], values = {}, store = { error: null, writes: 0 };
  let nextBlob;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id === "storageWarning", listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      querySelector() { return node(id + "/form"); },
    });
    return nodes.get(id);
  }
  const context = {
    Blob, console, messages, setTimeout() {}, clearTimeout() {},
    URL: { createObjectURL(blob) { nextBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    document: {
      getElementById: node, querySelectorAll() { return []; }, addEventListener() {},
      createElement() { return { click() { downloads.push(nextBlob); } }; },
    },
    localStorage: {
      setItem(key, value) { store.writes++; if (store.error) throw store.error; values[key] = value; },
    },
    fetch() { throw new Error("Storage recovery must not call an API"); },
  };
  const hook = `globalThis.api = { S, save, importJson, exportJson, bind };
    updateCounters = () => {}; renderBuckets = () => {}; renderStatus = () => {}; renderReview = () => {};
    toast = (msg, error = false) => messages.push({ msg, error });`;
  assert.equal(source.split("  boot();").length, 2);
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, node, store, values, messages, downloads };
}
function snapshot() {
  return { settings: {}, threshold: 0.8, records: [{
    item: { id: "old", date: "2026-10-12", payee: "架空文具店", memo: "架空資料", amount: 2200, method: "cash", direction: "out" },
    jev: { confidence: 0.92, account: "消耗品費" },
    entry: { status: "confirmed", amount: 2200, account: "消耗品費", counter: "現金", taxCode: "tax", memo: "確認後の架空摘要", modified: true },
  }] };
}
function fail(app, name = "QuotaExceededError") {
  app.store.error = Object.assign(new Error("synthetic storage failure"), { name });
}

test("successful persistence hides the warning and records the current work", () => {
  const app = loadApp();
  app.node("storageWarning").hidden = false;
  app.api.S.settings.business = "架空事業";
  assert.equal(app.api.save(), true);
  assert.equal(app.node("storageWarning").hidden, true);
  assert.equal(JSON.parse(app.values["jev-kaikei:v1"]).settings.business, "架空事業");
});

test("quota failure retains older stored data and reports in-memory restoration as unpersisted", async () => {
  const app = loadApp();
  assert.equal(app.api.save(), true);
  const old = app.values["jev-kaikei:v1"];
  fail(app);
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  assert.equal(app.values["jev-kaikei:v1"], old);
  assert.equal(app.api.S.items.length, 1);
  assert.equal(app.node("storageWarning").hidden, false);
  assert.equal(app.messages.at(-1).error, true);
  assert.match(app.messages.at(-1).msg, /自動保存に失敗/);
  assert.match(app.messages.at(-1).msg, /JSONを保存/);
});

test("a denied-storage SecurityError is visible without discarding the restored entries", async () => {
  const app = loadApp();
  fail(app, "SecurityError");
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  assert.equal(app.node("storageWarning").hidden, false);
  const id = app.api.S.items[0].id;
  assert.equal(app.api.S.entries[id].status, "confirmed");
  assert.equal(app.api.S.entries[id].memo, "確認後の架空摘要");
});

test("JSON backup works after storage failure and leaves the unpersisted warning visible", async () => {
  const app = loadApp();
  fail(app);
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  app.api.bind();
  app.node("btnStorageJson").listeners.click();
  const exported = JSON.parse(await app.downloads[0].text());
  assert.equal(exported.records.length, 1);
  assert.equal(exported.records[0].entry.amount, 2200);
  assert.equal(exported.records[0].entry.memo, "確認後の架空摘要");
  assert.equal(app.node("storageWarning").hidden, false);
});

test("retry while storage still fails preserves the warning and in-memory records", async () => {
  const app = loadApp();
  fail(app);
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  app.api.bind();
  const before = JSON.stringify(app.api.S.items);
  app.node("btnStorageRetry").listeners.click();
  assert.equal(app.node("storageWarning").hidden, false);
  assert.equal(JSON.stringify(app.api.S.items), before);
  assert.equal(app.messages.at(-1).error, true);
});

test("successful retry stores the current confirmed work and clears the warning", async () => {
  const app = loadApp();
  fail(app);
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  app.api.bind();
  app.store.error = null;
  app.node("btnStorageRetry").listeners.click();
  assert.equal(app.node("storageWarning").hidden, true);
  const persisted = JSON.parse(app.values["jev-kaikei:v1"]);
  assert.equal(persisted.items.length, 1);
  assert.equal(persisted.entries[persisted.items[0].id].amount, 2200);
  assert.equal(app.messages.at(-1).error, false);
});

test("successful restoration retains the existing success message", async () => {
  const app = loadApp();
  await app.api.importJson(JSON.stringify(snapshot()), "synthetic.json");
  assert.equal(app.node("storageWarning").hidden, true);
  assert.equal(app.messages.at(-1).error, false);
  assert.match(app.messages.at(-1).msg, /取引と確認記録を復元しました/);
});
