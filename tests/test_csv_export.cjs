const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadExporter() {
  const source = fs.readFileSync(path.join(__dirname, "../jev_kaikei/static/app.js"), "utf8");
  // Expose the actual export callbacks in this isolated harness; do not boot the UI.
  assert.equal(source.split("  boot();").length, 2);
  const downloads = [];
  let nextBlob;
  const context = {
    Blob,
    URL: { createObjectURL(blob) { nextBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    setTimeout() {}, clearTimeout() {},
    document: {
      createElement() { return { click() { downloads.push(nextBlob); } }; },
      getElementById() { return { classList: { toggle() {} } }; },
    },
  };
  vm.runInNewContext(source.replace("  boot();", "  globalThis.exportTest = { S, exportCsv, exportJson };"), context);
  const api = context.exportTest;
  api.S.master = { tax_categories: { taxed: { rate: 10, label_out: "課税仕入10%", label_in: "課税売上10%" } } };
  api.S.items = [{ id: "case", date: "2026-10-11", direction: "out" }];
  api.S.results = { case: { confidence: 0.95 } };
  api.S.entries = { case: { status: "confirmed", account: "消耗品費", counter: "現金", taxCode: "taxed", amount: 1100, memo: "" } };
  return { api, downloads };
}

function parseCsv(text) {
  const rows = []; let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(value); value = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(value); rows.push(row); row = []; value = ""; i++; }
    else value += c;
  }
  row.push(value); rows.push(row); return rows;
}

for (const prefix of ["=", "+", "-", "@", "＝", "＋", "－", "＠", "\t", "\r", "\n", "  =", "\uFEFF@"]) {
  test("neutralize text prefix " + JSON.stringify(prefix) + " in full CSV export", async () => {
    const { api, downloads } = loadExporter();
    const text = prefix + '1,"memo"\r\nnext';
    api.S.entries.case.memo = text;
    const before = JSON.stringify(api.S);
    api.exportCsv();
    const csv = await downloads[0].text();
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].length, 10);
    assert.equal(rows[1][7], "'" + text);
    assert.equal(rows[1][2], "1100");
    assert.equal(rows[1][6], "100");
    assert.equal(JSON.stringify(api.S), before);
    api.exportJson();
    const json = JSON.parse(await downloads[1].text());
    assert.equal(json.records[0].entry.memo, text);
  });
}

test("ordinary text, quotes, commas and line breaks round-trip", async () => {
  const { api, downloads } = loadExporter();
  const text = '会議用,"飲料"\r\n追加';
  api.S.entries.case.memo = text;
  api.exportCsv();
  assert.equal(parseCsv(await downloads[0].text())[1][7], text);
});

test("numeric values and already quoted text retain their values", async () => {
  const { api, downloads } = loadExporter();
  api.S.entries.case.amount = -1100;
  api.S.entries.case.memo = "'=1+1";
  api.exportCsv();
  const row = parseCsv(await downloads[0].text())[1];
  assert.equal(row[2], "-1100");
  assert.equal(row[4], "-1100");
  assert.equal(row[7], "'=1+1");
});

test("all exported text columns use the same protection", async () => {
  const { api, downloads } = loadExporter();
  api.S.items[0].date = "=1+1";
  api.S.entries.case.account = "@SUM(1)";
  api.S.entries.case.counter = "+1";
  api.S.master.tax_categories.taxed.label_out = "-1";
  api.exportCsv();
  const row = parseCsv(await downloads[0].text())[1];
  assert.equal(row[0], "'=1+1");
  assert.equal(row[1], "'@SUM(1)");
  assert.equal(row[3], "'+1");
  assert.equal(row[5], "'-1");
});

test("review and hold entries remain excluded", () => {
  const { api, downloads } = loadExporter();
  api.S.entries.case.status = "review";
  api.exportCsv();
  api.S.entries.case.status = "hold";
  api.exportCsv();
  assert.equal(downloads.length, 0);
});
