/* Jev会計 フロント。サーバー (/api/*) が Jev を呼び、ここは見せ方と仕訳の確定を担当する。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "jev-kaikei:v1";
  const BATCH = 50; // 1 リクエストに入れる枚数。判定できたものから順に返ってくる

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  const S = {
    config: null,
    master: null,
    items: [],        // 読み込んだレシート
    results: {},      // id -> Jev の判定
    entries: {},      // id -> 仕訳 {status, debitCode, debit, taxCode, amount, credit, memo, modified}
    queue: [],        // ベルトに流す待ち行列
    riding: null,     // いま流れているカード
    paused: false,
    stepOnce: false,
    speed: 1,
    threshold: 0.8,
    settings: { entity: "kojin", mode: "cash", business: "", defaultMethod: "cash" },
    screen: "sort",
    reviewIds: [],
    reviewIdx: 0,
    reviewAll: false,
    usage: { input_tokens: 0, estimated_cost_usd: 0 },
    seq: 0,
    judging: null,        // 判定中の進み具合 {total, done, failed, startedAt, lastError}
    failed: new Set(),    // 判定に失敗したレシート id（再判定の対象）
  };

  // ------------------------------------------------------------------
  // utils
  // ------------------------------------------------------------------
  const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
  const pct = (p) => (Math.round(p * 100) / 100).toFixed(2);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => `r${Date.now().toString(36)}${(S.seq++).toString(36)}`;

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("is-error", isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
  }

  function taxAmount(amount, rate) {
    if (!rate) return 0;
    return Math.round((Number(amount) || 0) * rate / (100 + rate));
  }
  function taxLabel(code, side) {
    const t = S.master?.tax_categories?.[code];
    if (!t) return code || "";
    return side === "in" ? t.label_in : t.label_out;
  }
  function accountsFor(side) { return S.master?.accounts?.[side] || []; }
  function confClass(conf) {
    if (conf >= 0.95) return "is-high";
    if (conf >= S.threshold) return "is-mid";
    return "is-low";
  }
  function counterAccount(method, side) {
    return S.master?.counter_accounts?.[method]?.[side] || (side === "out" ? "現金" : "普通預金");
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        items: S.items, results: S.results, entries: S.entries, settings: S.settings,
        threshold: S.threshold, speed: S.speed, usage: S.usage,
      }));
      $("storageWarning").hidden = true;
      return true;
    } catch (_) {
      $("storageWarning").hidden = false;
      return false;
    }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      S.items = d.items || []; S.results = d.results || {}; S.entries = d.entries || {};
      S.settings = { ...S.settings, ...(d.settings || {}) };
      S.threshold = d.threshold ?? S.threshold; S.speed = d.speed ?? S.speed; S.usage = d.usage || S.usage;
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // 判定 → 仕訳の下書き
  // ------------------------------------------------------------------
  function decide(id) {
    const item = S.items.find((x) => x.id === id);
    const r = S.results[id];
    if (!item || !r) return null;
    const prev = S.entries[id];
    if (prev && (prev.status === "confirmed" || prev.status === "hold")) return prev;
    const auto = r.confidence >= S.threshold && !r.force_review;
    const e = {
      status: auto ? "auto" : "review",
      debitCode: r.account_code,
      account: r.account,
      taxCode: r.tax_code,
      amount: item.amount,
      counter: r.counter_account,
      memo: [item.payee, item.memo].filter(Boolean).join(" / "),
      modified: false,
    };
    S.entries[id] = e;
    return e;
  }
  function recomputeAll() {
    for (const it of S.items) if (S.results[it.id]) decide(it.id);
  }
  function entrySides(item, e) {
    // 支出: 借方=科目 / 貸方=支払手段。収入: 借方=入金先 / 貸方=科目
    if (item.direction === "in") return { debit: e.counter, credit: e.account };
    return { debit: e.account, credit: e.counter };
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function loadConfig() {
    const q = new URLSearchParams({ entity: S.settings.entity, mode: S.settings.mode });
    const res = await fetch(`/api/config?${q}`);
    if (!res.ok) throw new Error("設定を取得できません");
    S.config = await res.json();
    S.master = S.config.master;
    const b = $("modeBadge");
    if (S.config.mock) { b.textContent = "コンセプトモック（API キーなし）"; b.className = "badge badge-mock"; }
    else { b.textContent = `ライブ ${S.config.model || "jev"}`; b.className = "badge badge-live"; }
  }

  /* サーバーは判定できたものから 1 行ずつ NDJSON で返す。Jev が混雑していても最初の 1 枚からすぐ流せる */
  async function classifyStream(items, onEvent) {
    const res = await fetch("/api/classify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, entity: S.settings.entity, mode: S.settings.mode, business: S.settings.business }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf));
  }

  async function judgeItems(items) {
    if (!items.length || S.judging) return;
    for (const it of items) S.failed.delete(it.id);
    S.judging = { total: items.length, done: 0, failed: 0, startedAt: performance.now(), lastError: "" };
    renderStatus();
    const tick = setInterval(renderStatus, 1000);
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        await classifyStream(chunk, (ev) => {
          if (ev.type === "result") { S.results[ev.id] = ev; decide(ev.id); S.queue.push(ev.id); S.judging.done++; pump(); }
          else if (ev.type === "error") { S.failed.add(ev.id); S.judging.failed++; S.judging.lastError = ev.error || ""; }
          else if (ev.type === "done") {
            S.usage.input_tokens += ev.usage?.input_tokens || 0;
            S.usage.estimated_cost_usd += ev.usage?.estimated_cost_usd || 0;
            renderUsage();
          }
          renderStatus(); updateCounters(); save();
        });
      }
    } catch (e) {
      for (const it of items) if (!S.results[it.id]) S.failed.add(it.id);
      S.judging.lastError = e.message;
      toast(`Jev の呼び出しに失敗: ${e.message}`, true);
    } finally {
      clearInterval(tick);
      const failed = S.items.filter((it) => !S.results[it.id]).length;
      S.judging = null;
      if (failed) toast(`${failed} 枚を見立てられませんでした（Jev の混雑など）。「呼び戻す」で流し直せます`, true);
      renderStatus(); updateCounters(); save();
    }
  }

  function supportedAmount(amount) {
    return Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount));
  }
  const AMOUNT_ERROR = "金額が大きすぎます。9,007,199,254,740,991円以内の数値に直してください";

  async function ingest(rawItems, sourceLabel) {
    if (!rawItems.length) { toast("読み込める行がありませんでした", true); return; }
    // Validate the entire batch before allocating IDs or changing existing work.
    for (const [i, x] of rawItems.entries()) {
      const amount = Number(x.amount);
      normDate(x.date, `${i + 1}件目`);
      if (!Number.isNaN(amount) && !supportedAmount(amount)) throw new Error(`${i + 1}件目: ${AMOUNT_ERROR}`);
    }
    const items = rawItems.map((x) => ({
      id: uid(), date: x.date || "", payee: x.payee || "", amount: Math.abs(Math.round(Number(x.amount) || 0)),
      memo: x.memo || "", method: x.method || S.settings.defaultMethod, direction: x.direction === "in" ? "in" : "out",
      counterparty: x.counterparty || "", source: sourceLabel,
    })).filter((x) => x.amount > 0 && (x.payee || x.memo));
    if (!items.length) { toast("金額と支払先のある行がありませんでした", true); return; }
    S.items.push(...items);
    updateCounters(); save();
    toast(`${items.length} 枚を持ち込みました。帳簿の悪魔が見ています…`);
    await judgeItems(items);
  }

  // ------------------------------------------------------------------
  // ベルトコンベア
  // ------------------------------------------------------------------
  /* 一時停止中は進まない待ち時間。requestAnimationFrame は画面を描いていないとき
     （別タブ・最小化・埋め込みプレビューなど）に呼ばれず、そこで流れが止まってしまうので setTimeout で数える */
  function pausableWait(ms) {
    return new Promise((resolve) => {
      let remaining = ms, last = performance.now();
      const tick = () => {
        const now = performance.now();
        if (!S.paused || S.stepOnce) remaining -= now - last;
        last = now;
        if (remaining <= 0) resolve(); else setTimeout(tick, Math.min(remaining, 50));
      };
      setTimeout(tick, Math.min(ms, 50));
    });
  }
  /* 再生中のアニメーション。一時停止のときだけまとめて止める。
     終わったアニメーションに play() を呼ぶと先頭に巻き戻り finished が返らなくなる
     （カードがベルトを往復し続け、後ろが一枚も流れない）ので、定期的に play() は呼ばず、
     一時停止の状態が変わったときだけ触る */
  const flying = new Set();
  function syncAnimations() {
    const stop = S.paused && !S.stepOnce;
    for (const a of flying) {
      if (stop) { if (a.playState === "running") a.pause(); }
      else if (a.playState === "paused") a.play();
    }
  }
  function animate(el, keyframes, opts) {
    const a = el.animate(keyframes, opts);
    if (S.paused && !S.stepOnce) a.pause();
    flying.add(a);
    // finished は画面を描いていないブラウザ（別タブ・埋め込みプレビューなど）では解決しないので、
    // 時間でも待って必ず次へ進める。cancel されたときも止まらない
    return Promise.race([a.finished.catch(() => {}), pausableWait(opts.duration + 60)])
      .finally(() => flying.delete(a));
  }

  async function pump() {
    if (S.riding || S.screen !== "sort") return;
    const id = S.queue.shift();
    if (!id) { document.querySelector(".jev-node").classList.remove("is-thinking"); renderStatus(); return; }
    S.riding = id;
    $("beltEmpty").hidden = true;
    try { await ride(id); } catch (err) { console.error(err); } finally { S.riding = null; S.stepOnce = false; }
    if (S.queue.length) pump(); else renderStatus();
  }

  async function ride(id) {
    const item = S.items.find((x) => x.id === id);
    const r = S.results[id];
    const e = decide(id);
    if (!item || !r || !e) return;
    const belt = $("belt");
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><span>${esc(item.date)}</span><span>${esc(labelMethod(item.method))}</span></div>
      <div class="card-payee">${esc(item.payee)}</div><div class="card-amount">${yen(item.amount)}</div>
      <div class="card-memo">${esc(item.memo)}</div><div class="card-tag"></div>`;
    belt.appendChild(card);

    const gateX = belt.clientWidth / 2 - 105 + 230;
    const dur = 1500 / S.speed;
    document.querySelector(".jev-node").classList.add("is-thinking");
    try {
      // steps() でコマ送りにして、ドット絵ゲームらしい動きにする
      await animate(card, [{ transform: "translateX(0)" }, { transform: `translateX(${gateX}px)` }], { duration: dur, easing: "steps(28, end)", fill: "forwards" });

      renderFocus(item, r, e);
      const tag = card.querySelector(".card-tag");
      tag.textContent = e.status === "auto" ? `${e.account} ${pct(r.confidence)}` : `要裁き ${pct(r.confidence)}`;
      tag.classList.toggle("is-ng", e.status !== "auto");
      tag.classList.add("is-on");
      await pausableWait(1100 / S.speed);

      // バケツへ
      renderBuckets();
      const target = document.querySelector(`.bucket[data-key="${e.status === "auto" ? cssKey(e.account) : "__review"}"]`);
      if (target) {
        const from = card.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + 30 - from.top;
        await animate(card, [
          { transform: `translateX(${gateX}px) scale(1)`, opacity: 1 },
          { transform: `translate(${gateX + dx}px, ${dy}px) scale(.35)`, opacity: .2 },
        ], { duration: 650 / S.speed, easing: "steps(12, end)", fill: "forwards" });
      }
    } finally {
      card.remove();
      document.querySelector(".jev-node").classList.remove("is-thinking");
    }
    renderBuckets(id);
    updateCounters();
  }

  function labelMethod(m) { return S.master?.methods?.[m] || m || ""; }
  function cssKey(s) { return String(s).replace(/[^\w぀-ヿ一-鿿]/g, "_"); }

  // ------------------------------------------------------------------
  // rendering: sort screen
  // ------------------------------------------------------------------
  function renderFocus(item, r, e) {
    const cands = r.candidates.map((c, i) => `<li class="${i === 0 ? "is-top" : ""}"><span>${esc(c.account)}</span><span>${Math.round(c.p * 100)}%</span><div class="bar"><i style="width:${Math.round(c.p * 100)}%"></i></div></li>`).join("");
    const side = item.direction;
    const sides = entrySides(item, e);
    $("focus").innerHTML = `
      <div class="focus-top"><span class="focus-payee">${esc(item.payee)}</span><span class="focus-amount">${yen(item.amount)}</span></div>
      <div class="focus-meta">${esc(item.date)} ・ ${esc(labelMethod(item.method))} ・ ${side === "in" ? "収入" : "支出"}${item.memo ? " ・ " + esc(item.memo) : ""}</div>
      <div class="conf-big"><small>confidence</small><b>${pct(r.confidence)}</b></div>
      <ol class="cands">${cands}</ol>
      <div class="opinion-tax">税区分: ${esc(taxLabel(e.taxCode, side))}${r.tax_source === "jev" ? ` (Jev ${pct(r.tax_confidence)})` : r.tax_source === "fixed" ? " (科目で固定)" : " (既定)"}</div>
      <div class="decision ${e.status === "auto" ? "is-auto" : "is-review"}">${e.status === "auto" ? `金庫入り → ${esc(sides.debit)} / ${esc(sides.credit)}` : "裁きの間へ"}<small>${e.status === "auto" ? `confidence ${pct(r.confidence)} はしきい値 ${pct(S.threshold)} 以上` : (r.force_review ? esc(r.hints[0] || "掟により裁きの間へ") : `confidence ${pct(r.confidence)} はしきい値 ${pct(S.threshold)} 未満`)}</small></div>`;
  }

  function bucketOrder() {
    const order = [];
    for (const side of ["out", "in"]) for (const a of accountsFor(side)) if (!order.includes(a.account)) order.push(a.account);
    return order;
  }

  function renderBuckets(newId = null) {
    const groups = new Map();
    const review = [];
    const shown = new Set(); // 既に流し終えたもの（queue にないもの）だけ表示
    const pending = new Set(S.queue); if (S.riding) pending.add(S.riding);
    for (const it of S.items) {
      const e = S.entries[it.id];
      if (!e || pending.has(it.id)) continue;
      if (e.status === "review" || e.status === "hold") { review.push(it); continue; }
      const key = e.account;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const order = bucketOrder();
    const keys = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const html = [];
    const colorOf = (name) => `hsl(${[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 55% 52%)`;
    const bucket = (key, name, list, isReview) => {
      const total = list.reduce((s, it) => s + it.amount, 0);
      const rows = list.slice(-6).reverse().map((it) => `<li class="${it.id === newId ? "is-new" : ""}" data-id="${it.id}"><span>${esc(it.payee)}</span><b>${yen(it.amount)}</b></li>`).join("");
      const more = list.length > 6 ? `<div class="bucket-more">ほか ${list.length - 6} 件</div>` : "";
      return `<div class="bucket ${isReview ? "is-review" : ""}" data-key="${key}" style="--bucket:${isReview ? "var(--ng)" : colorOf(name)}"><div class="bucket-head"><span class="bucket-name">${esc(name)}</span><span class="bucket-count">${list.length}</span></div><div class="bucket-total">${yen(total)}</div><ul class="bucket-items">${rows}</ul>${more}</div>`;
    };
    for (const k of keys) html.push(bucket(cssKey(k), k, groups.get(k), false));
    html.push(bucket("__review", "裁きの間", review, true));
    $("buckets").innerHTML = html.join("");
  }

  function updateCounters() {
    let auto = 0, review = 0;
    for (const it of S.items) {
      const e = S.entries[it.id];
      if (!e) continue;
      if (e.status === "auto" || e.status === "confirmed") auto++; else review++;
    }
    $("cLoaded").textContent = S.items.length;
    $("cAuto").textContent = auto;
    $("cReview").textContent = review;
    $("tabReviewCount").textContent = review;
    $("tabReviewCount").hidden = review === 0;
  }

  /* ベルトが空のときの案内と「再判定」ボタン */
  function renderStatus() {
    const pending = S.items.filter((it) => !S.results[it.id]).length;
    const btn = $("btnRetry");
    btn.hidden = !(pending > 0 && !S.judging);
    if (!btn.hidden) btn.textContent = `未判定 ${pending} 枚を呼び戻す`;
    const el = $("beltEmpty");
    if (S.riding || $("belt").querySelector(".card")) { el.hidden = true; return; }
    el.hidden = false;
    if (S.judging) {
      const sec = Math.round((performance.now() - S.judging.startedAt) / 1000);
      const congested = /529|混雑|overload/i.test(S.judging.lastError) || (sec >= 6 && S.judging.done < S.judging.total);
      el.innerHTML = `<span class="status-spin"></span>帳簿の悪魔が見立て中 … ${S.judging.done} / ${S.judging.total}（${sec} 秒）`
        + (congested ? `<br><small>Jev が混雑しています。自動で再試行中（最大 30 秒ほど）</small>` : "");
    } else if (!S.items.length) {
      el.textContent = "帳面を持ち込むと羊皮紙が流れてきます";
    } else if (S.queue.length) {
      el.hidden = true;
    } else if (pending) {
      el.innerHTML = `${pending} 枚が未判定です<br><small>「未判定を呼び戻す」を押してください</small>`;
    } else {
      el.innerHTML = `${S.items.length} 枚すべて選別し終えた<br><small>「最初から」でもう一度流す ／ 帳面を追加で持ち込む</small>`;
    }
  }

  function renderUsage() {
    if (!S.config) return;
    const u = S.usage;
    $("usage").textContent = S.config.mock
      ? `モック実行中。本物の Jev なら入力 ${u.input_tokens.toLocaleString()} トークン ≒ $${u.estimated_cost_usd.toFixed(4)}（$0.042 / 100万トークン、出力は無料）`
      : `Jev 使用量: 入力 ${u.input_tokens.toLocaleString()} トークン ≒ $${u.estimated_cost_usd.toFixed(4)}`;
  }

  // ------------------------------------------------------------------
  // review screen
  // ------------------------------------------------------------------
  function buildReviewList() {
    S.reviewIds = S.items.filter((it) => {
      const e = S.entries[it.id];
      if (!e) return false;
      if (S.reviewAll) return true;
      return e.status === "review" || e.status === "hold";
    }).map((it) => it.id);
    if (S.reviewIdx >= S.reviewIds.length) S.reviewIdx = Math.max(0, S.reviewIds.length - 1);
  }

  function fillSelect(sel, options, value) {
    sel.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    if (value != null && [...sel.options].some((o) => o.value === value)) sel.value = value;
  }

  function renderReview() {
    buildReviewList();
    const empty = S.reviewIds.length === 0;
    $("reviewEmpty").hidden = !empty;
    $("reviewPane").hidden = empty;
    renderConfirmed();
    renderReviewCounters();
    if (empty) return;
    const id = S.reviewIds[S.reviewIdx];
    const item = S.items.find((x) => x.id === id);
    const r = S.results[id];
    const e = S.entries[id];
    const side = item.direction;

    $("rvDate").textContent = item.date || "—";
    $("rvPayee").textContent = item.payee || "—";
    $("rvAmount").textContent = yen(item.amount);
    $("rvMethod").textContent = `${labelMethod(item.method)} ・ ${side === "in" ? "収入" : "支出"}`;
    $("rvMemo").textContent = item.memo || "—";
    const conf = $("rvConf"); conf.textContent = `${confClass(r.confidence) === "is-high" ? "高" : confClass(r.confidence) === "is-mid" ? "中" : "低"} ${pct(r.confidence)}`; conf.className = `chip chip-conf ${confClass(r.confidence)}`;
    const st = $("rvStatus"); st.textContent = statusLabelUi(e); st.className = `chip st st-${e.modified ? "modified" : e.status}`;
    $("rvCandidates").innerHTML = r.candidates.map((c, i) => `<li class="${i === 0 ? "is-top" : ""}"><span>${esc(c.account)}</span><span>${Math.round(c.p * 100)}%</span><div class="bar"><i style="width:${Math.round(c.p * 100)}%"></i></div></li>`).join("");
    $("rvTax").textContent = `税区分の判定: ${taxLabel(r.tax_code, side)}${r.tax_source === "jev" ? `（Jev ${pct(r.tax_confidence)}）` : r.tax_source === "fixed" ? "（科目で固定）" : "（既定値）"}${r.is_private != null ? ` ・ 私的支出の確率 ${Math.round(r.is_private * 100)}%` : ""}`;
    $("rvHints").innerHTML = r.hints.map((h) => `<li>${esc(h)}</li>`).join("");

    // フォーム
    const accOpts = accountsFor(side).map((a) => ({ value: a.code, label: a.account }));
    const taxOpts = Object.entries(S.master.tax_categories).map(([k, t]) => ({ value: k, label: side === "in" ? t.label_in : t.label_out }));
    const counterOpts = uniqueCounters(side).map((n) => ({ value: n, label: n }));
    const sides = entrySides(item, e);
    if (side === "out") {
      fillSelect($("fDebit"), accOpts, e.debitCode);
      fillSelect($("fCredit"), counterOpts, sides.credit);
    } else {
      fillSelect($("fDebit"), counterOpts, sides.debit);
      fillSelect($("fCredit"), accOpts, e.debitCode);
    }
    fillSelect($("fTax"), taxOpts, e.taxCode);
    $("fAmount").value = e.amount;
    $("fMemo").value = e.memo;
    $("entryForm").dataset.side = side;
    syncAmounts();
    $("rvPos").textContent = `${S.reviewIdx + 1} / ${S.reviewIds.length}`;
    $("rvPrev").disabled = S.reviewIdx === 0;
    $("rvNext").disabled = S.reviewIdx >= S.reviewIds.length - 1;
    document.querySelectorAll("#confirmedList li").forEach((li) => li.classList.toggle("is-current", li.dataset.id === id));
  }

  function uniqueCounters(side) {
    const set = new Set();
    for (const m of Object.keys(S.master.methods)) set.add(counterAccount(m, side));
    // 貸方（または借方）としてよく使う口座も追加
    for (const n of ["普通預金", "現金", "未払金", "売掛金", "買掛金", "前払金", "前受金"]) set.add(n);
    return [...set];
  }

  function syncAmounts() {
    const rate = S.master.tax_categories[$("fTax").value]?.rate || 0;
    const amt = Number($("fAmount").value) || 0;
    $("fTaxAmount").value = rate ? `${yen(taxAmount(amt, rate))}（${rate}%）` : "—";
    $("fCreditAmount").value = yen(amt);
  }

  /* CSV に書く状態。会計の言葉のままにする */
  function statusLabel(e) {
    if (e.status === "confirmed") return e.modified ? "修正して確定" : "確認済み";
    return { auto: "自動仕訳", review: "要確認", hold: "保留" }[e.status] || e.status;
  }
  /* 画面に出す状態（魔界の言い方） */
  function statusLabelUi(e) {
    if (e.status === "confirmed") return e.modified ? "手直しして裁き済み" : "裁き済み";
    return { auto: "金庫入り", review: "要裁き", hold: "保留" }[e.status] || e.status;
  }

  function confirmCurrent() {
    if (!S.reviewIds.length) return;
    const id = S.reviewIds[S.reviewIdx];
    const item = S.items.find((x) => x.id === id);
    const r = S.results[id];
    const e = S.entries[id];
    const side = item.direction;
    const accSel = side === "out" ? $("fDebit") : $("fCredit");
    const counterSel = side === "out" ? $("fCredit") : $("fDebit");
    const acc = accountsFor(side).find((a) => a.code === accSel.value);
    const amount = Math.round(Number($("fAmount").value) || 0);
    if (!supportedAmount(amount)) { toast(AMOUNT_ERROR, true); return; }
    if (!acc || amount <= 0) { toast("科目と金額を確認してください", true); return; }
    const modified = acc.code !== r.account_code || $("fTax").value !== r.tax_code || counterSel.value !== r.counter_account || amount !== item.amount;
    Object.assign(e, {
      status: "confirmed", debitCode: acc.code, account: acc.account, taxCode: $("fTax").value,
      amount, counter: counterSel.value, memo: $("fMemo").value.trim(), modified,
    });
    item.amount = amount;
    save(); updateCounters();
    const wasLast = S.reviewIdx >= S.reviewIds.length - 1;
    buildReviewList();
    if (!S.reviewAll) { /* 確定した行はリストから消えるので idx はそのまま */ }
    else if (!wasLast) S.reviewIdx++;
    if (S.reviewIdx >= S.reviewIds.length) S.reviewIdx = Math.max(0, S.reviewIds.length - 1);
    renderReview();
    if (!S.reviewIds.length) toast("全部裁き終えました。仕訳CSV を出力できます");
  }

  function holdCurrent() {
    if (!S.reviewIds.length) return;
    const id = S.reviewIds[S.reviewIdx];
    S.entries[id].status = "hold";
    save(); updateCounters();
    if (S.reviewIdx < S.reviewIds.length - 1) S.reviewIdx++;
    renderReview();
  }

  function renderConfirmed() {
    const rows = S.items
      .filter((it) => S.entries[it.id])
      .slice()
      .sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id))
      .map((it) => {
        const e = S.entries[it.id];
        const sides = entrySides(it, e);
        const cls = e.status === "confirmed" ? (e.modified ? "modified" : "confirmed") : e.status;
        return `<li data-id="${it.id}"><span class="cl-payee">${esc(it.date)} ${esc(it.payee)}</span><span class="cl-amt">${yen(e.amount)}</span><span class="cl-acc">${esc(sides.debit)} / ${esc(sides.credit)} ・ ${esc(taxLabel(e.taxCode, it.direction))} <span class="st st-${cls}">${esc(statusLabelUi(e))}</span></span></li>`;
      });
    $("confirmedList").innerHTML = rows.join("") || `<li><span class="cl-payee" style="color:var(--muted)">まだありません</span></li>`;
  }

  function renderReviewCounters() {
    let done = 0, fixed = 0, left = 0, total = 0;
    for (const it of S.items) {
      const e = S.entries[it.id]; if (!e) continue;
      total++;
      if (e.status === "confirmed") { done++; if (e.modified) fixed++; }
      else if (e.status === "auto") done++;
      else left++;
    }
    $("rDone").textContent = `${done}/${total}`;
    $("rFixed").textContent = fixed;
    $("rLeft").textContent = left;
  }

  // ------------------------------------------------------------------
  // export
  // ------------------------------------------------------------------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function csvCell(v) {
    let s = String(v ?? "");
    const protectedText = typeof v === "string" && /^(?:[\s\uFEFF]*[=+\-@＝＋－＠]|[\t\r\n])/u.test(s);
    if (protectedText) s = "'" + s;
    return protectedText || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv() {
    const rows = [["日付", "借方勘定科目", "借方金額", "貸方勘定科目", "貸方金額", "税区分", "内消費税", "摘要", "確信度", "状態"]];
    const list = S.items.filter((it) => { const e = S.entries[it.id]; return e && (e.status === "auto" || e.status === "confirmed"); })
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    for (const it of list) {
      const e = S.entries[it.id]; const r = S.results[it.id]; const sides = entrySides(it, e);
      const rate = S.master.tax_categories[e.taxCode]?.rate || 0;
      rows.push([it.date, sides.debit, e.amount, sides.credit, e.amount, taxLabel(e.taxCode, it.direction), taxAmount(e.amount, rate), e.memo, pct(r.confidence), statusLabel(e)]);
    }
    if (rows.length === 1) { toast("出力できる仕訳がありません（金庫入りか裁き済みが対象）", true); return; }
    download(`仕訳_${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
    toast(`${rows.length - 1} 行の仕訳CSVを保存しました`);
  }
  function exportJson() {
    const out = S.items.map((it) => ({ item: it, jev: S.results[it.id] || null, entry: S.entries[it.id] || null }));
    download(`jev-kaikei_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ settings: S.settings, threshold: S.threshold, records: out }, null, 2), "application/json");
  }

  // ------------------------------------------------------------------
  // import
  // ------------------------------------------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false, closed = false;
    text = text.replace(/^\uFEFF/, "");
    const fail = (reason) => {
      const where = rows.length ? `データ${rows.length}件目` : "ヘッダー";
      throw new Error(`CSVの${where}: ${reason}。ファイル全体を読み込んでいません`);
    };
    const finishCell = () => { row.push(cell); cell = ""; closed = false; };
    const finishRow = () => {
      finishCell();
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else { quoted = false; closed = true; }
        } else cell += c;
      } else if (c === ",") finishCell();
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        finishRow();
      } else if (closed) {
        if (c !== " " && c !== "\t") fail("引用符を閉じた後に余分な文字があります");
      } else if (c === '"') {
        if (cell.trim() !== "") fail("引用符は項目の先頭に置いてください");
        cell = ""; quoted = true;
      } else cell += c;
    }
    if (quoted) fail("引用符が閉じていません");
    if (cell.length || row.length || closed) finishRow();
    return rows;
  }
  const ALIASES = {
    date: ["日付", "取引日", "利用日", "date"],
    payee: ["支払先", "店名", "店舗", "取引先", "相手先", "利用先", "payee", "name", "vendor"],
    memo: ["摘要", "内容", "メモ", "備考", "品目", "memo", "description", "note"],
    amount: ["金額", "利用金額", "amount", "total"],
    out: ["出金", "出金額", "支出", "支払金額", "withdrawal", "debit"],
    in: ["入金", "入金額", "収入", "deposit", "credit"],
    method: ["支払方法", "決済方法", "支払手段", "method"],
    direction: ["区分", "収支", "direction", "type"],
  };
  function findCol(headers, keys) {
    const norm = headers.map((h) => h.replace(/[\s　"]/g, "").toLowerCase());
    for (const k of keys) { const i = norm.indexOf(k.toLowerCase()); if (i >= 0) return i; }
    for (const k of keys) { const i = norm.findIndex((h) => h.includes(k.toLowerCase())); if (i >= 0) return i; }
    return -1;
  }
  function toNumber(s) {
    if (s == null) return NaN;
    const t = String(s).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[¥￥,，円\s]/g, "").replace(/^△|^▲/, "-");
    return Number(t);
  }
  function normMethod(s) {
    const t = String(s || "");
    if (/現金|cash/i.test(t)) return "cash";
    if (/カード|クレジット|card|credit/i.test(t)) return "card";
    if (/個人|私費|立替|private/i.test(t)) return "private";
    if (/銀行|振込|口座|預金|bank|transfer/i.test(t)) return "bank";
    return "";
  }
  function normDirection(s) {
    const t = String(s || "");
    if (/収入|入金|in\b|income|deposit|売上/i.test(t)) return "in";
    if (/支出|出金|out|expense|withdraw/i.test(t)) return "out";
    return "";
  }
  function normDate(s, label = "") {
    const t = String(s || "").trim().replace(/[年月]/g, "-").replace(/日/, "").replace(/\//g, "-");
    const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
        throw new Error(`${label ? label + ": " : ""}日付が存在しません。年・月・日を確認してください。現在の取引は変更していません`);
      }
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }
    return String(s || "").trim();
  }
  function itemsFromCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) return [];
    const h = rows[0];
    const col = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, findCol(h, v)]));
    if (col.payee < 0 && col.memo >= 0) { col.payee = col.memo; col.memo = -1; }
    if (col.payee < 0) throw new Error("支払先（または摘要）の列が見つかりません");
    if (col.amount < 0 && col.out < 0 && col.in < 0) throw new Error("金額の列が見つかりません");
    const items = [];
    for (const [i, r] of rows.slice(1).entries()) {
      if (r.length !== h.length) throw new Error(`CSVのデータ${i + 1}件目: 列数がヘッダーと一致しません（${h.length}列に対して${r.length}列）。ファイル全体を読み込んでいません`);
      const get = (i) => (i >= 0 ? (r[i] ?? "").trim() : "");
      let amount = NaN, direction = normDirection(get(col.direction));
      if (col.out >= 0 && toNumber(get(col.out)) > 0) { amount = toNumber(get(col.out)); direction = direction || "out"; }
      else if (col.in >= 0 && toNumber(get(col.in)) > 0) { amount = toNumber(get(col.in)); direction = direction || "in"; }
      else amount = toNumber(get(col.amount));
      if (Number.isNaN(amount) || amount === 0) continue;
      if (!supportedAmount(amount)) throw new Error(`CSVのデータ${i + 1}件目: ${AMOUNT_ERROR}`);
      if (!direction) direction = amount < 0 ? "out" : "out";
      items.push({ date: normDate(get(col.date), `CSVのデータ${i + 1}件目`), payee: get(col.payee), memo: get(col.memo), amount: Math.abs(amount), method: normMethod(get(col.method)) || S.settings.defaultMethod, direction });
    }
    return items;
  }
  function itemsFromJson(text) {
    const d = JSON.parse(text);
    const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    const arr = Array.isArray(d) ? d : object(d) ? (Object.hasOwn(d, "items") ? d.items : d.records) : null;
    if (!Array.isArray(arr)) throw new Error("JSONは取引の配列、またはitems・recordsに配列を持つ形式にしてください");
    return arr.map((x, i) => {
      const fail = (reason) => { throw new Error(`JSONのデータ${i + 1}件目: ${reason}。ファイル全体を読み込んでいません`); };
      if (!object(x)) fail("取引はオブジェクトにしてください");
      const textFields = ["date", "日付", "payee", "支払先", "name", "memo", "摘要", "description", "method", "支払方法", "direction", "区分"];
      for (const key of textFields) {
        if (x[key] != null && typeof x[key] !== "string") fail(`${key}は文字列にしてください`);
      }
      for (const key of ["amount", "金額"]) {
        if (x[key] != null && typeof x[key] !== "string" && typeof x[key] !== "number") fail(`${key}は数値または文字列にしてください`);
      }
      return {
        date: normDate(x.date || x.日付 || "", `JSONのデータ${i + 1}件目`), payee: x.payee || x.支払先 || x.name || "", memo: x.memo || x.摘要 || x.description || "",
        amount: toNumber(x.amount ?? x.金額 ?? 0), method: normMethod(x.method || x.支払方法 || "") || (["cash", "bank", "card", "private"].includes(x.method) ? x.method : S.settings.defaultMethod),
        direction: normDirection(x.direction || x.区分 || "") || (x.direction === "in" ? "in" : "out"),
      };
    });
  }
  function restoreSavedRecords(data, sourceLabel) {
    if (S.judging || S.riding || S.queue.length) throw new Error("判定と表示が終わってから保存JSONを読み込んでください");
    const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    const money = (x) => Number.isSafeInteger(x) && x >= 0;
    // Validate the entire file before changing existing work or allocating IDs.
    for (const [i, row] of data.records.entries()) {
      const fail = () => { throw new Error(`保存JSONの${i + 1}件目が不正です。現在の取引は変更していません`); };
      if (!object(row) || !object(row.item)) fail();
      const it = row.item;
      if (!money(it.amount) || it.amount === 0 || !["in", "out"].includes(it.direction)) fail();
      if (["date", "payee", "memo", "method"].some((key) => typeof it[key] !== "string")) fail();
      normDate(it.date, `保存JSONの${i + 1}件目`);
      if ((row.jev != null) !== (row.entry != null)) fail();
      if (row.jev != null && (!object(row.jev) || !Number.isFinite(row.jev.confidence) || row.jev.confidence < 0 || row.jev.confidence > 1)) fail();
      if (row.entry != null) {
        const e = row.entry;
        if (!row.jev || !object(e) || !["auto", "review", "confirmed", "hold"].includes(e.status) || !money(e.amount)) fail();
        if (["account", "counter", "taxCode", "memo"].some((key) => typeof e[key] !== "string")) fail();
      }
    }
    if (!data.records.length) { toast("保存JSONに復元する取引がありません", true); return; }
    for (const row of data.records) {
      const id = uid();
      S.items.push({ ...row.item, id, source: sourceLabel });
      if (row.jev != null) S.results[id] = { ...row.jev, id };
      if (row.entry != null) S.entries[id] = { ...row.entry };
    }
    const persisted = save(); updateCounters(); renderBuckets(); renderStatus();
    if (S.screen === "review") renderReview();
    if (persisted) toast(`${data.records.length}件の取引と確認記録を復元しました。設定は現在のままです`);
    else toast(`${data.records.length}件をこのタブへ復元しましたが、自動保存に失敗しました。閉じる前にJSONを保存してください`, true);
  }
  async function importJson(text, sourceLabel) {
    const data = JSON.parse(text);
    const saved = data && !Array.isArray(data) && Array.isArray(data.records)
      && (data.records.some((row) => row && Object.hasOwn(row, "item")) || (Object.hasOwn(data, "settings") && Object.hasOwn(data, "threshold")));
    if (saved) restoreSavedRecords(data, sourceLabel);
    else await ingest(itemsFromJson(text), sourceLabel);
  }
  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (_) { return new TextDecoder("shift_jis").decode(buf); }
  }

  // ------------------------------------------------------------------
  // screens / events
  // ------------------------------------------------------------------
  function showScreen(name) {
    S.screen = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.screen === name));
    $("screen-sort").hidden = name !== "sort";
    $("screen-review").hidden = name !== "review";
    if (name === "review") renderReview(); else { renderBuckets(); pump(); }
  }

  function setPaused(p) {
    S.paused = p;
    $("btnPause").textContent = p ? "▶ 再開" : "⏸ 一時停止";
    $("belt").classList.toggle("is-paused", p);
    syncAnimations();
  }

  function replay() {
    if (S.riding) return;
    S.queue = S.items.filter((it) => S.results[it.id]).map((it) => it.id);
    document.querySelectorAll("#belt .card").forEach((c) => c.remove());
    $("focus").innerHTML = `<div class="focus-empty">最初から流します</div>`;
    renderBuckets();
    pump();
  }

  function bind() {
    $("btnStorageJson").addEventListener("click", exportJson);
    $("btnStorageRetry").addEventListener("click", () => {
      if (save()) toast("ブラウザーの自動保存が完了しました");
      else toast("自動保存に失敗しました。閉じる前にJSONを保存してください", true);
    });
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showScreen(t.dataset.screen)));
    $("btnFile").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", async (ev) => {
      const file = ev.target.files[0]; ev.target.value = "";
      if (!file) return;
      try {
        const text = await readFileText(file);
        if (file.name.toLowerCase().endsWith(".json")) await importJson(text, file.name);
        else await ingest(itemsFromCsv(text), file.name);
      } catch (e) { toast(`読み込みに失敗: ${e.message}`, true); }
    });
    $("btnDemo").addEventListener("click", async () => {
      try { const d = await (await fetch("/api/sample")).json(); await ingest(d.items || [], "demo"); }
      catch (e) { toast(`見本の帳面を取得できません: ${e.message}`, true); }
    });
    $("btnManual").addEventListener("click", () => { $("manualAmountError").hidden = true; $("mDate").value ||= new Date().toISOString().slice(0, 10); $("dlgManual").showModal(); });
    $("mAmount").addEventListener("input", () => { $("manualAmountError").hidden = true; });
    $("mCancel").addEventListener("click", () => $("dlgManual").close());
    $("dlgManual").querySelector("form").addEventListener("submit", (ev) => {
      if (ev.submitter?.value !== "add") return;
      ev.preventDefault();
      const item = { date: $("mDate").value, payee: $("mPayee").value.trim(), amount: toNumber($("mAmount").value), memo: $("mMemo").value.trim(), method: $("mMethod").value, direction: $("mDirection").value };
      if (!supportedAmount(item.amount) && !Number.isNaN(item.amount)) { $("manualAmountError").textContent = AMOUNT_ERROR; $("manualAmountError").hidden = false; return; }
      if (!item.payee || !(item.amount > 0)) { toast("支払先と金額を入れてください", true); return; }
      $("dlgManual").close(); $("mPayee").value = ""; $("mAmount").value = ""; $("mMemo").value = "";
      ingest([item], "manual");
    });
    $("btnRetry").addEventListener("click", () => judgeItems(S.items.filter((it) => !S.results[it.id])));
    $("btnPause").addEventListener("click", () => setPaused(!S.paused));
    $("btnStep").addEventListener("click", () => { if (!S.paused) setPaused(true); S.stepOnce = true; syncAnimations(); pump(); });
    $("btnReplay").addEventListener("click", replay);
    $("speed").addEventListener("input", (ev) => { S.speed = Number(ev.target.value); $("speedOut").textContent = `×${S.speed.toFixed(2)}`; save(); });
    $("threshold").addEventListener("input", (ev) => {
      S.threshold = Number(ev.target.value); $("thresholdOut").textContent = pct(S.threshold);
      recomputeAll(); renderBuckets(); updateCounters(); save();
      if (S.screen === "review") renderReview();
    });
    $("btnSettings").addEventListener("click", () => {
      $("sEntity").value = S.settings.entity; $("sMode").value = S.settings.mode; $("sBusiness").value = S.settings.business; $("sMethod").value = S.settings.defaultMethod;
      $("dlgSettings").showModal();
    });
    $("dlgSettings").addEventListener("close", async () => {
      if ($("dlgSettings").returnValue !== "save") return;
      S.settings = { entity: $("sEntity").value, mode: $("sMode").value, business: $("sBusiness").value.trim(), defaultMethod: $("sMethod").value };
      save();
      try { await loadConfig(); toast("設定を保存しました"); } catch (e) { toast(e.message, true); }
    });
    $("buckets").addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-id]"); if (!li) return;
      S.reviewAll = true; $("reviewAll").checked = true;
      buildReviewList(); S.reviewIdx = Math.max(0, S.reviewIds.indexOf(li.dataset.id)); showScreen("review");
    });
    $("confirmedList").addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-id]"); if (!li) return;
      if (!S.reviewIds.includes(li.dataset.id)) { S.reviewAll = true; $("reviewAll").checked = true; buildReviewList(); }
      S.reviewIdx = Math.max(0, S.reviewIds.indexOf(li.dataset.id)); renderReview();
    });
    $("reviewAll").addEventListener("change", (ev) => { S.reviewAll = ev.target.checked; S.reviewIdx = 0; renderReview(); });
    $("rvPrev").addEventListener("click", () => { if (S.reviewIdx > 0) { S.reviewIdx--; renderReview(); } });
    $("rvNext").addEventListener("click", () => { if (S.reviewIdx < S.reviewIds.length - 1) { S.reviewIdx++; renderReview(); } });
    $("rvConfirm").addEventListener("click", confirmCurrent);
    $("rvHold").addEventListener("click", holdCurrent);
    $("entryForm").addEventListener("submit", (ev) => { ev.preventDefault(); confirmCurrent(); });
    $("fTax").addEventListener("change", syncAmounts);
    $("fAmount").addEventListener("input", syncAmounts);
    $("btnExportCsv").addEventListener("click", exportCsv);
    $("btnExportJson").addEventListener("click", exportJson);
    $("btnClear").addEventListener("click", () => {
      if (!confirm("持ち込んだ羊皮紙と仕訳をすべて消します。よろしいですか？")) return;
      S.items = []; S.results = {}; S.entries = {}; S.queue = []; S.failed = new Set(); S.usage = { input_tokens: 0, estimated_cost_usd: 0 };
      save(); updateCounters(); renderBuckets(); renderUsage(); renderReview(); renderStatus();
      $("focus").innerHTML = `<div class="focus-empty">Jev の前に来た羊皮紙の見立てがここに出ます</div>`;
      toast("すべて消しました");
    });

    document.addEventListener("keydown", (ev) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
      if (document.querySelector("dialog[open]")) return;
      if (S.screen === "sort") {
        if (ev.code === "Space" && !typing) { ev.preventDefault(); setPaused(!S.paused); }
        if (ev.key === "ArrowRight" && !typing) { ev.preventDefault(); $("btnStep").click(); }
      } else if (S.screen === "review") {
        if (ev.key === "Enter" && ev.target.tagName !== "TEXTAREA") { ev.preventDefault(); confirmCurrent(); }
        else if (ev.key === "ArrowLeft" && !typing) $("rvPrev").click();
        else if (ev.key === "ArrowRight" && !typing) $("rvNext").click();
        else if ((ev.key === "s" || ev.key === "S") && !typing) holdCurrent();
      }
    });
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  async function boot() {
    restore();
    $("speed").value = S.speed; $("speedOut").textContent = `×${S.speed.toFixed(2)}`;
    $("threshold").value = S.threshold; $("thresholdOut").textContent = pct(S.threshold);
    bind();
    try { await loadConfig(); } catch (e) { toast(e.message, true); return; }
    recomputeAll();
    renderBuckets(); updateCounters(); renderUsage(); renderStatus();
  }
  boot();
})();
