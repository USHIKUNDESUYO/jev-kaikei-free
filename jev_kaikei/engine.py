"""取引 1 件を Jev に判定させ、仕訳の材料（科目・税区分・確信度・注意点）にまとめる。

しきい値による「自動 / 人の確認」の振り分けは UI 側（スライダーで動かせる）に任せ、
ここでは Jev の生の判定とルールベースの注意点だけを返す。
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import resources
from typing import Any

from .jev_client import estimate_cost_usd

TAX_CATEGORIES: dict[str, dict[str, Any]] = {
    "taxable_10": {
        "label_out": "課税仕入 10%", "label_in": "課税売上 10%", "rate": 10,
        "what": "標準税率10%の取引 (standard 10% taxable)",
        "examples": "一般的な物品・サービスの購入、店内飲食、交通費、通信費、家賃（事業用）",
        "not_for": "持ち帰りや宅配の飲食料品（軽減8%）",
    },
    "reduced_8": {
        "label_out": "課税仕入(軽減) 8%", "label_in": "課税売上(軽減) 8%", "rate": 8,
        "what": "軽減税率8%の対象 (reduced 8% rate)",
        "examples": "コンビニやスーパーでの飲食料品の購入（酒類を除く）、テイクアウト、出前、週2回以上発行の定期購読新聞",
        "not_for": "店内飲食（10%）、酒類（10%）、日用品（10%）",
    },
    "exempt": {
        "label_out": "非課税仕入", "label_in": "非課税売上", "rate": 0,
        "what": "非課税取引 (exempt from consumption tax)",
        "examples": "保険料、預金利息、郵便局で買う切手・印紙、行政手数料、住民票などの証明書",
        "not_for": "税金そのもの（不課税）、給与（不課税）",
    },
    "out_of_scope": {
        "label_out": "対象外", "label_in": "対象外", "rate": 0,
        "what": "消費税の対象外・不課税 (out of scope)",
        "examples": "給与、税金の納付、寄付、敷金、借入と返済、カード引落し、個人的な支出、口座間振替",
        "not_for": "通常の物品・サービス購入",
    },
}

METHOD_ACCOUNTS: dict[str, Any] = {
    "bank": "普通預金",
    "cash": "現金",
    "card": "未払金",
    "private": {"kojin": {"out": "事業主借", "in": "事業主貸"}, "hojin": {"out": "役員借入金", "in": "役員貸付金"}},
}
METHOD_LABELS = {"bank": "銀行口座", "cash": "現金", "card": "クレジットカード", "private": "個人立替"}

DIRECTION_TEXT = {"out": "outflow (money paid out / 支出)", "in": "inflow (money received / 収入)"}

FIXED_ASSET_THRESHOLD = 100_000
ENTERTAINMENT_PER_HEAD = 10_000
# is_private (noul) の警告しきい値。カード引落しや預金利息でも 0.55 前後が出るため、
# 課税の科目（経費・売上）に限って 0.6 以上のときだけ注意を出す（2026-09-21 デモ26件で調整）
PRIVATE_THRESHOLD = 0.6


def load_master() -> dict[str, Any]:
    with resources.files(__package__).joinpath("accounts.json").open("r", encoding="utf-8") as f:
        return json.load(f)


def options_for(master: dict[str, Any], side: str, entity: str, mode: str) -> list[dict[str, Any]]:
    out = []
    for opt in master["options"]:
        if opt["side"] != side:
            continue
        if opt.get("entity") and opt["entity"] != entity:
            continue
        if opt.get("mode") and opt["mode"] != mode:
            continue
        out.append(opt)
    return out


def method_account(method: str, entity: str, side: str) -> str:
    acc = METHOD_ACCOUNTS.get(method, METHOD_ACCOUNTS["bank"])
    if isinstance(acc, dict):
        return acc[entity][side]
    return acc


# ---------------------------------------------------------------------------
# Jev に渡す state / questions
# ---------------------------------------------------------------------------

def build_state(item: dict[str, Any], business: str) -> dict[str, Any]:
    side = item.get("direction", "out")
    state = {
        "date": item.get("date", ""),
        "payee": item.get("payee", ""),
        "description": item.get("memo", ""),
        "amount_jpy": item.get("amount", 0),
        "direction": DIRECTION_TEXT.get(side, side),
        "payment_method": METHOD_LABELS.get(item.get("method", "bank"), item.get("method", "")),
    }
    if item.get("counterparty"):
        state["counterparty"] = item["counterparty"]
    if business:
        state["business_profile"] = business
    return state


def build_questions(options: list[dict[str, Any]], side: str) -> dict[str, dict[str, Any]]:
    account_criteria = {
        o["code"]: {"account": o["account"], "what": o["what"], "examples": o["examples"], "not_for": o["not_for"]}
        for o in options
    }
    tax_criteria = {
        code: {"what": t["what"], "examples": t["examples"], "not_for": t["not_for"]}
        for code, t in TAX_CATEGORIES.items()
    }
    return {
        "account": {
            "type": "choice",
            "instructions": (
                "この取引に最も適した勘定科目を 1 つ選んでください。"
                "Pick the single most appropriate Japanese account title (勘定科目) for this transaction, "
                "based on the payee, description, amount and payment method."
            ),
            "criteria": account_criteria,
        },
        "tax": {
            "type": "choice",
            "instructions": (
                "この取引の消費税区分を選んでください。"
                "Pick the Japanese consumption tax category that applies to this transaction."
            ),
            "criteria": tax_criteria,
        },
        "is_private": {
            "type": "noul",
            "instructions": (
                "この取引は事業とは無関係な、個人的（私的）な支出または個人資金の移動である。"
                "This transaction is personal / private and not for the business."
            ),
        },
    }


# ---------------------------------------------------------------------------
# 判定結果の整形
# ---------------------------------------------------------------------------

def annotate(item: dict[str, Any], raw: dict[str, Any], options: list[dict[str, Any]], entity: str) -> dict[str, Any]:
    by_code = {o["code"]: o for o in options}
    side = item.get("direction", "out")
    answers = raw.get("answers", {})

    acc = answers.get("account") or {}
    code = acc.get("choice")
    if code not in by_code:
        raise ValueError(f"Jev が未知の科目コードを返しました: {code!r}")
    opt = by_code[code]
    confidence = float(acc.get("confidence", 0.0))
    probs = acc.get("probabilities") or {}
    ranked = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)
    candidates = [
        {"code": c, "account": by_code[c]["account"], "p": round(float(p), 4)}
        for c, p in ranked[:5] if c in by_code
    ]

    # 税区分: 科目が taxable のときだけ Jev の答えを使う
    tax_ans = answers.get("tax") or {}
    if opt["tax"] == "taxable":
        tax_conf = float(tax_ans.get("confidence", 0.0))
        tax_choice = tax_ans.get("choice")
        if tax_choice in TAX_CATEGORIES and tax_conf >= 0.6:
            tax_code, tax_source = tax_choice, "jev"
        else:
            tax_code, tax_source = "taxable_10", "default"
    else:
        tax_code, tax_source, tax_conf = opt["tax"], "fixed", 1.0

    p_private = answers.get("is_private", {}).get("noul")
    p_private = float(p_private) if p_private is not None else None

    amount = int(item.get("amount") or 0)
    hints: list[str] = []
    force_review = False

    if opt.get("flag"):
        hints.append(opt["flag"])
        force_review = True
    if p_private is not None and p_private >= PRIVATE_THRESHOLD and not opt.get("private") and opt["tax"] == "taxable":
        hints.append(f"私的支出の可能性 {p_private:.0%}（{'事業主貸' if entity == 'kojin' else '役員貸付金'} も検討）")
        force_review = True
    if side == "out" and code == "consumables" and amount >= FIXED_ASSET_THRESHOLD:
        hints.append("10万円以上: 工具器具備品（固定資産）か少額減価償却資産の特例（30万円未満・青色）を検討")
        force_review = True
    if side == "out" and code == "fixed_asset" and amount < FIXED_ASSET_THRESHOLD:
        hints.append("10万円未満: 消耗品費で処理できます")
        force_review = True
    if side == "out" and code in ("meetings", "entertainment"):
        if amount <= ENTERTAINMENT_PER_HEAD:
            hints.append(f"1万円ルール: ¥{amount:,} は 1人1万円以下 → 飲食なら会議費で処理可（人数と相手を確認）")
        elif code == "meetings":
            hints.append(f"1万円超: ¥{amount:,} は人数によっては接待交際費（1人1万円超）")
            force_review = True
    if side == "out" and code == "card_settlement" and item.get("method") == "card":
        hints.append("カード払いでカード引落しは矛盾。支払方法を確認")
        force_review = True

    return {
        "id": item.get("id"),
        "account_code": code,
        "account": opt["account"],
        "confidence": round(confidence, 4),
        "candidates": candidates,
        "tax_code": tax_code,
        "tax_label": TAX_CATEGORIES[tax_code]["label_out" if side == "out" else "label_in"],
        "tax_rate": TAX_CATEGORIES[tax_code]["rate"],
        "tax_confidence": round(tax_conf, 4),
        "tax_source": tax_source,
        "is_private": round(p_private, 4) if p_private is not None else None,
        "counter_account": method_account(item.get("method", "bank"), entity, side),
        "hints": hints,
        "force_review": force_review,
        "model": raw.get("model"),
        "usage": raw.get("usage", {}),
    }


def judge_one(client, item: dict[str, Any], master: dict[str, Any], entity: str, mode: str, business: str) -> dict[str, Any]:
    side = item.get("direction", "out")
    options = options_for(master, side, entity, mode)
    raw = client.system_one(build_state(item, business), build_questions(options, side))
    return annotate(item, raw, options, entity)


def judge_stream(client, items: list[dict[str, Any]], master: dict[str, Any], entity: str, mode: str, business: str, workers: int = 8):
    """判定できたものから順に yield する（混雑時でも最初の 1 枚がすぐ返る）。

    yield する dict の type: "result"（judge_one の戻り値 + type）/ "error" / "done"
    """
    tokens = 0
    n_ok = n_err = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futures = {ex.submit(judge_one, client, it, master, entity, mode, business): it for it in items}
        for fut in as_completed(futures):
            it = futures[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001
                n_err += 1
                yield {"type": "error", "id": it.get("id"), "error": str(e)}
                continue
            n_ok += 1
            tokens += int((r.get("usage") or {}).get("input_tokens", 0) or 0)
            yield {"type": "result", **r}
    yield {
        "type": "done",
        "ok": n_ok,
        "failed": n_err,
        "usage": {"input_tokens": tokens, "estimated_cost_usd": round(estimate_cost_usd(tokens), 6)},
        "mock": bool(getattr(client, "is_mock", False)),
        "model": getattr(client, "model", None),
    }


def judge_many(client, items: list[dict[str, Any]], master: dict[str, Any], entity: str, mode: str, business: str, workers: int = 8) -> dict[str, Any]:
    """全部そろってから返す版（スクリプトやテスト用）。順序は items と同じ。"""
    by_id: dict[Any, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    done: dict[str, Any] = {}
    for ev in judge_stream(client, items, master, entity, mode, business, workers):
        if ev["type"] == "result":
            r = dict(ev)
            r.pop("type", None)
            by_id[r["id"]] = r
        elif ev["type"] == "error":
            errors.append({"id": ev["id"], "error": ev["error"]})
        else:
            done = ev
    results = [by_id[it.get("id")] for it in items if it.get("id") in by_id]
    return {
        "results": results,
        "errors": errors,
        "usage": done.get("usage", {"input_tokens": 0, "estimated_cost_usd": 0.0}),
        "mock": done.get("mock", bool(getattr(client, "is_mock", False))),
        "model": done.get("model", getattr(client, "model", None)),
    }


def ui_master(master: dict[str, Any], entity: str, mode: str) -> dict[str, Any]:
    """フロントに渡す軽量版マスタ。"""
    return {
        "accounts": {
            "out": [{"code": o["code"], "account": o["account"], "tax": o["tax"]} for o in options_for(master, "out", entity, mode)],
            "in": [{"code": o["code"], "account": o["account"], "tax": o["tax"]} for o in options_for(master, "in", entity, mode)],
        },
        "tax_categories": {
            k: {"label_out": v["label_out"], "label_in": v["label_in"], "rate": v["rate"]} for k, v in TAX_CATEGORIES.items()
        },
        "methods": METHOD_LABELS,
        "counter_accounts": {
            m: {"out": method_account(m, entity, "out"), "in": method_account(m, entity, "in")} for m in METHOD_LABELS
        },
    }
