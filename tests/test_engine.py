import json
import unittest
from pathlib import Path

from jev_kaikei.engine import (
    TAX_CATEGORIES,
    annotate,
    build_questions,
    build_state,
    judge_many,
    load_master,
    method_account,
    options_for,
    ui_master,
)
from jev_kaikei.mock import MockJevClient

MASTER = load_master()
SAMPLES = Path(__file__).resolve().parent.parent / "samples" / "receipts_sample.json"


def raw(choice, conf, probs=None, tax="taxable_10", tax_conf=0.9, private=0.05):
    probs = probs or {choice: conf, "misc_expense": 1 - conf}
    return {
        "model": "jev-1.13.0",
        "answers": {
            "account": {"type": "choice", "choice": choice, "confidence": conf, "probabilities": probs},
            "tax": {"type": "choice", "choice": tax, "confidence": tax_conf, "probabilities": {tax: tax_conf}},
            "is_private": {"type": "noul", "noul": private},
        },
        "usage": {"input_tokens": 500, "output_tokens": 0},
    }


class MasterTests(unittest.TestCase):
    def test_codes_unique_and_fields_present(self):
        codes = [o["code"] for o in MASTER["options"]]
        self.assertEqual(len(codes), len(set(codes)))
        for o in MASTER["options"]:
            for k in ("side", "account", "tax", "what", "examples", "not_for"):
                self.assertIn(k, o, o["code"])
            self.assertIn(o["tax"], set(TAX_CATEGORIES) | {"taxable"})

    def test_entity_and_mode_filtering(self):
        kojin = {o["code"] for o in options_for(MASTER, "out", "kojin", "cash")}
        hojin = {o["code"] for o in options_for(MASTER, "out", "hojin", "cash")}
        self.assertIn("private_out_kojin", kojin)
        self.assertNotIn("private_out_hojin", kojin)
        self.assertIn("private_out_hojin", hojin)
        self.assertIn("director_pay", hojin)
        self.assertNotIn("director_pay", kojin)
        cash_in = {o["code"] for o in options_for(MASTER, "in", "kojin", "cash")}
        accrual_in = {o["code"] for o in options_for(MASTER, "in", "kojin", "accrual")}
        self.assertIn("sales", cash_in)
        self.assertNotIn("receivable_collection", cash_in)
        self.assertIn("receivable_collection", accrual_in)
        self.assertNotIn("sales", accrual_in)

    def test_method_accounts(self):
        self.assertEqual(method_account("bank", "kojin", "out"), "普通預金")
        self.assertEqual(method_account("card", "kojin", "out"), "未払金")
        self.assertEqual(method_account("private", "kojin", "out"), "事業主借")
        self.assertEqual(method_account("private", "kojin", "in"), "事業主貸")
        self.assertEqual(method_account("private", "hojin", "out"), "役員借入金")

    def test_ui_master_shape(self):
        m = ui_master(MASTER, "kojin", "cash")
        self.assertTrue(m["accounts"]["out"])
        self.assertIn("taxable_10", m["tax_categories"])
        self.assertEqual(m["counter_accounts"]["card"]["out"], "未払金")


class QuestionTests(unittest.TestCase):
    def test_questions_follow_api_shape(self):
        opts = options_for(MASTER, "out", "kojin", "cash")
        q = build_questions(opts, "out")
        self.assertEqual(q["account"]["type"], "choice")
        self.assertEqual(set(q["account"]["criteria"]), {o["code"] for o in opts})
        self.assertEqual(q["tax"]["type"], "choice")
        self.assertEqual(set(q["tax"]["criteria"]), set(TAX_CATEGORIES))
        self.assertEqual(q["is_private"]["type"], "noul")
        self.assertNotIn("criteria", q["is_private"])
        json.dumps(q, ensure_ascii=False)  # シリアライズできる

    def test_state_is_compact(self):
        item = {"date": "2026-08-10", "payee": "スターバックス", "amount": 1320, "memo": "打合せ", "method": "card", "direction": "out"}
        st = build_state(item, "会計ライター")
        self.assertEqual(st["payee"], "スターバックス")
        self.assertEqual(st["amount_jpy"], 1320)
        self.assertIn("outflow", st["direction"])
        self.assertEqual(st["payment_method"], "クレジットカード")
        self.assertEqual(st["business_profile"], "会計ライター")
        self.assertNotIn("business_profile", build_state(item, ""))


class AnnotateTests(unittest.TestCase):
    def setUp(self):
        self.out_opts = options_for(MASTER, "out", "kojin", "cash")
        self.in_opts = options_for(MASTER, "in", "kojin", "cash")

    def test_expense_by_card(self):
        item = {"id": "a", "date": "2026-08-12", "payee": "ヨドバシ", "amount": 24800, "method": "card", "direction": "out"}
        r = annotate(item, raw("consumables", 0.92), self.out_opts, "kojin")
        self.assertEqual(r["account"], "消耗品費")
        self.assertEqual(r["counter_account"], "未払金")
        self.assertEqual(r["tax_code"], "taxable_10")
        self.assertEqual(r["tax_source"], "jev")
        self.assertFalse(r["force_review"])
        self.assertEqual(r["candidates"][0]["account"], "消耗品費")

    def test_fixed_asset_threshold_hint(self):
        item = {"id": "b", "date": "2026-08-29", "payee": "Apple", "amount": 248000, "method": "card", "direction": "out"}
        r = annotate(item, raw("consumables", 0.95), self.out_opts, "kojin")
        self.assertTrue(r["force_review"])
        self.assertTrue(any("10万円以上" in h for h in r["hints"]))

    def test_fixed_tax_for_non_taxable_account(self):
        item = {"id": "c", "date": "2026-09-03", "payee": "税務署", "amount": 41200, "method": "bank", "direction": "out"}
        r = annotate(item, raw("taxes", 0.97, tax="taxable_10"), self.out_opts, "kojin")
        self.assertEqual(r["tax_code"], "out_of_scope")
        self.assertEqual(r["tax_source"], "fixed")

    def test_low_tax_confidence_falls_back_to_default(self):
        item = {"id": "d", "date": "2026-08-30", "payee": "セブン", "amount": 1580, "method": "cash", "direction": "out"}
        r = annotate(item, raw("consumables", 0.9, tax="reduced_8", tax_conf=0.4), self.out_opts, "kojin")
        self.assertEqual(r["tax_code"], "taxable_10")
        self.assertEqual(r["tax_source"], "default")

    def test_private_probability_forces_review(self):
        item = {"id": "e", "date": "2026-08-30", "payee": "ドラッグストア", "amount": 2780, "method": "cash", "direction": "out"}
        r = annotate(item, raw("consumables", 0.9, private=0.7), self.out_opts, "kojin")
        self.assertTrue(r["force_review"])
        self.assertTrue(any("私的支出" in h for h in r["hints"]))

    def test_entertainment_rule_hint(self):
        item = {"id": "f", "date": "2026-08-10", "payee": "スタバ", "amount": 1320, "method": "card", "direction": "out"}
        r = annotate(item, raw("meetings", 0.9), self.out_opts, "kojin")
        self.assertFalse(r["force_review"])
        self.assertTrue(any("1万円ルール" in h for h in r["hints"]))
        big = dict(item, amount=18400)
        r2 = annotate(big, raw("meetings", 0.9), self.out_opts, "kojin")
        self.assertTrue(r2["force_review"])

    def test_income_by_bank(self):
        item = {"id": "g", "date": "2026-08-31", "payee": "株式会社ノート出版", "amount": 66000, "method": "bank", "direction": "in"}
        r = annotate(item, raw("sales", 0.93), self.in_opts, "kojin")
        self.assertEqual(r["account"], "売上高")
        self.assertEqual(r["counter_account"], "普通預金")
        self.assertEqual(r["tax_label"], "課税売上 10%")

    def test_flagged_option_forces_review(self):
        item = {"id": "h", "date": "2026-09-01", "payee": "振替", "amount": 100000, "method": "bank", "direction": "out"}
        r = annotate(item, raw("transfer_out", 0.99), self.out_opts, "kojin")
        self.assertTrue(r["force_review"])

    def test_unknown_code_raises(self):
        item = {"id": "i", "date": "", "payee": "x", "amount": 1, "method": "cash", "direction": "out"}
        with self.assertRaises(ValueError):
            annotate(item, raw("director_pay", 0.9), self.out_opts, "kojin")  # 法人専用は個人の選択肢にない


class StreamTests(unittest.TestCase):
    def test_stream_yields_results_then_done(self):
        from jev_kaikei.engine import judge_stream

        items = [
            {"id": "a", "date": "2026-08-10", "payee": "スターバックス", "amount": 1320, "memo": "打合せ", "method": "card", "direction": "out"},
            {"id": "b", "date": "2026-08-31", "payee": "みずほ銀行", "amount": 12, "memo": "利息", "method": "bank", "direction": "in"},
        ]
        events = list(judge_stream(MockJevClient(), items, MASTER, "kojin", "cash", "", workers=2))
        self.assertEqual([e["type"] for e in events[:-1]].count("result"), 2)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["ok"], 2)
        self.assertEqual({e["id"] for e in events[:-1]}, {"a", "b"})

    def test_stream_reports_per_item_errors(self):
        from jev_kaikei.engine import judge_stream

        class Flaky(MockJevClient):
            def system_one(self, state, questions):
                if "壊れる" in json.dumps(state, ensure_ascii=False):
                    raise RuntimeError("529 混雑")
                return super().system_one(state, questions)

        items = [
            {"id": "ok", "date": "", "payee": "文具店", "amount": 100, "method": "cash", "direction": "out"},
            {"id": "ng", "date": "", "payee": "壊れる店", "amount": 100, "method": "cash", "direction": "out"},
        ]
        events = list(judge_stream(Flaky(), items, MASTER, "kojin", "cash", "", workers=2))
        types = {e.get("id"): e["type"] for e in events if e["type"] != "done"}
        self.assertEqual(types, {"ok": "result", "ng": "error"})
        self.assertEqual(events[-1]["failed"], 1)
        many = judge_many(Flaky(), items, MASTER, "kojin", "cash", "", workers=2)
        self.assertEqual([r["id"] for r in many["results"]], ["ok"])
        self.assertEqual(many["errors"][0]["id"], "ng")


class MockEndToEndTests(unittest.TestCase):
    def test_sample_runs_through_mock(self):
        items = json.loads(SAMPLES.read_text(encoding="utf-8"))["items"]
        for i, it in enumerate(items):
            it["id"] = f"s{i}"
        out = judge_many(MockJevClient(), items, MASTER, "kojin", "cash", "会計ライター", workers=4)
        self.assertEqual(len(out["results"]), len(items))
        self.assertEqual(out["errors"], [])
        self.assertTrue(out["mock"])
        by_id = {r["id"]: r for r in out["results"]}
        self.assertEqual(by_id["s0"]["account"], "会議費")        # コンビニ 打合せ用 飲料
        self.assertEqual(by_id["s9"]["account"], "水道光熱費")    # 東京電力
        self.assertEqual(by_id["s10"]["account"], "未払金")       # 三井住友カード 引落し
        self.assertEqual(by_id["s18"]["account"], "売上高")       # 原稿料 入金
        self.assertEqual(by_id["s19"]["account"], "受取利息")     # 預金利息
        self.assertTrue(by_id["s14"]["force_review"])            # MacBook 248,000 円
        self.assertGreater(out["usage"]["input_tokens"], 0)

    def test_mock_is_deterministic(self):
        item = {"id": "x", "date": "2026-08-10", "payee": "スターバックス 渋谷店", "amount": 1320, "memo": "打合せ", "method": "card", "direction": "out"}
        a = judge_many(MockJevClient(), [item], MASTER, "kojin", "cash", "", workers=1)["results"][0]
        b = judge_many(MockJevClient(), [item], MASTER, "kojin", "cash", "", workers=1)["results"][0]
        self.assertEqual(a["confidence"], b["confidence"])
        self.assertEqual(a["account"], b["account"])


if __name__ == "__main__":
    unittest.main()
