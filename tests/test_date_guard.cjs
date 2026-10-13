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
  const hook = `globalThis.api = { S, itemsFromCsv, importJson, ingest };
    updateCounters = renderBuckets = renderStatus = renderReview = () => {};
    toast = (message) => messages.push(message);
    judgeItems = async (items) => classified.push(...items);`;
  vm.runInNewContext(source.replace("  boot();", hook), context);
  return { api: context.api, classified, storage, messages };
}

const row = (date) => ({ date, payee: "架空店", memo: "文具", amount: 1100, method: "cash", direction: "out" });
const csv = (date) => `日付,支払先,金額\n2026-10-13,架空店,1100\n${date},架空店,1100\n`;
const saved = (dates) => ({ records: dates.map((date) => ({ item: row(date), jev: null, entry: null })) });

for (const date of ["2026-02-30", "2025-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32", "0000-01-01"]) {
  test(`impossible ${date} is rejected in all import paths before mutation`, async () => {
    for (const kind of ["json", "csv", "saved", "ingest"]) {
      const app = loadApp();
      app.api.S.items.push({ ...row("2026-10-13"), id: "keep" });
      const before = JSON.stringify(app.api.S);
      const error = /2件目.*日付が存在しません/;
      if (kind === "json") await assert.rejects(app.api.importJson(JSON.stringify([row("2026-10-13"), row(date)]), "fixture.json"), error);
      if (kind === "csv") assert.throws(() => app.api.itemsFromCsv(csv(date)), error);
      if (kind === "saved") await assert.rejects(app.api.importJson(JSON.stringify(saved(["2026-10-13", date])), "saved.json"), error);
      if (kind === "ingest") await assert.rejects(app.api.ingest([row("2026-10-13"), row(date)], "manual"), error);
      assert.equal(JSON.stringify(app.api.S), before, kind);
      assert.deepEqual(app.storage, {}, kind);
      assert.equal(app.classified.length, 0, kind);
    }
  });
}

for (const [date, normalized] of [
  ["2024-02-29", "2024-02-29"], ["2000-02-29", "2000-02-29"],
  ["2026-4-30", "2026-04-30"], ["2026/10/13", "2026-10-13"],
  ["2026年10月13日", "2026-10-13"], ["", ""],
]) {
  test(`valid or missing date ${JSON.stringify(date)} remains usable`, async () => {
    const app = loadApp();
    await app.api.importJson(JSON.stringify([row(date)]), "fixture.json");
    assert.equal(app.api.S.items[0].date, normalized);
    assert.equal(app.classified.length, 1);
    assert.equal(JSON.parse(app.storage["jev-kaikei:v1"]).items[0].date, normalized);
    assert.equal(app.api.itemsFromCsv(csv(date))[1].date, normalized);
    const restored = loadApp();
    await restored.api.importJson(JSON.stringify(saved([date])), "saved.json");
    assert.equal(restored.api.S.items[0].date, date);
    assert.equal(restored.classified.length, 0);
  });
}

test("unrecognized date text retains the previous behavior without invented dates", async () => {
  const app = loadApp();
  await app.api.importJson(JSON.stringify([row("日付不明")]), "fixture.json");
  assert.equal(app.api.S.items[0].date, "日付不明");
  assert.equal(app.api.itemsFromCsv(csv("日付不明"))[1].date, "日付不明");
});
