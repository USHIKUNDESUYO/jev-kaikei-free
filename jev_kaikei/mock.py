"""API キーなしで動かすためのモック Jev。

キーワードで勘定科目を当て、確信度はハッシュから決める（同じ入力なら同じ答え）。
応答の形は本物の /v1/systemone と同じにしてある。
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

# (正規表現, 支出時の科目コード) の順で最初にマッチしたものを採用
OUT_RULES: list[tuple[str, str]] = [
    (r"カード|VISA|JCB|AMEX|アメックス|楽天カード|三井住友カード|イオンカード|セゾン|ｶｰﾄﾞ", "card_settlement"),
    (r"給与|給料|賞与|アルバイト", "salaries"),
    (r"役員報酬", "director_pay"),
    (r"源泉|特別徴収", "withholding_payment"),
    (r"年金事務所|健康保険|厚生年金|労働保険|雇用保険", "statutory_welfare"),
    (r"国民年金|国民健康保険|国保|所得税|住民税|生活費|生命保険|個人口座", "private_out_kojin"),
    (r"法人税|法人住民税|法人事業税", "corporate_tax"),
    (r"印紙|固定資産税|自動車税|事業税|消費税|税務署|登録免許", "taxes"),
    (r"火災保険|賠償責任|自動車保険|損保|保険料", "insurance"),
    (r"家賃|賃料|月極|コワーキング|レンタルオフィス|WeWork|管理費", "rent"),
    (r"敷金|保証金", "deposit"),
    (r"電力|電気|ガス|水道", "utilities"),
    (r"ドコモ|docomo|ソフトバンク|SoftBank|au |KDDI|楽天モバイル|NTT|光回線|さくらインターネット|Xserver|エックスサーバー|Cloudflare|AWS|Amazon Web|Google Workspace|Google Cloud|OpenAI|ChatGPT|Anthropic|Notion|Slack|Zoom|Adobe|Microsoft 365|GitHub|Vercel|お名前|ドメイン|サーバー|サーバ |AI|郵便|切手|レターパック|通信", "communication"),
    (r"Google広告|Google Ads|Meta|Facebook広告|Instagram広告|X広告|広告|チラシ|名刺|ノベルティ|出展", "advertising"),
    (r"JR|東日本|西日本|東海|新幹線|急行|鉄道|電鉄|乗車券|きっぷ|Suica|PASMO|モバイルSuica|地下鉄|メトロ|バス|タクシー|GO |Uber|ANA|JAL|Peach|航空|ホテル|宿泊|高速|ETC|NEXCO|パーキング|タイムズ|三井のリパーク|駐車", "travel"),
    (r"ガソリン|ENEOS|出光|コスモ|車検|オイル交換|洗車", "vehicle"),
    (r"接待|会食|居酒屋|焼肉|寿司|鳥貴族|串カツ|ビアホール|お中元|お歳暮|手土産|香典|祝儀|ゴルフ", "entertainment"),
    (r"スターバックス|スタバ|ドトール|タリーズ|コメダ|カフェ|珈琲|コーヒー|会議室|貸会議|打合せ|打ち合わせ|サイゼリヤ|ガスト|ファミレス", "meetings"),
    (r"書店|紀伊國屋|ジュンク堂|有隣堂|丸善|Kindle|書籍|新聞|日経|雑誌|note|有料記事", "books"),
    (r"セミナー|講座|研修|勉強会|Udemy|スクール", "training"),
    (r"振込手数料|手数料|Stripe|PayPal|税理士|司法書士|弁護士|社労士|行政書士|証明書", "fees"),
    (r"修理|修繕|保守|メンテナンス", "repairs"),
    (r"ヤマト|佐川|ゆうパック|発送|梱包|ダンボール", "shipping"),
    (r"商工会|協会|団体|年会費|会費", "dues"),
    (r"寄付|義援金|ふるさと納税", "donations"),
    (r"利息|利子", "interest_paid"),
    (r"返済|公庫|融資", "loan_repayment"),
    (r"外注|業務委託|デザイン料|執筆料|制作費|ランサーズ|クラウドワークス|ココナラ", "outsourcing"),
    (r"仕入|問屋|卸", "purchases"),
    (r"Amazon|アマゾン|ヨドバシ|ビックカメラ|ヤマダ|ノジマ|コジマ|Apple|文具|文房具|事務用品|アスクル|カウネット|ダイソー|セリア|100円|無印|ニトリ|IKEA|PC|パソコン|モニター|キーボード|マウス|インク|コピー用紙|ソフト|端末|ストレージ|羊皮紙|薬屋|薬局|洗剤|ティッシュ", "consumables"),
    (r"コンビニ|セブン|ローソン|ファミリーマート|ファミマ|ミニストップ|スーパー|イオン|マルエツ|成城石井|ライフ|弁当|飲料|お茶|ドラッグ|マツキヨ|ウエルシア|ツルハ", "consumables"),
    (r"振替|振込 自分|自社口座|定期預金", "transfer_out"),
]

IN_RULES: list[tuple[str, str]] = [
    (r"利息|利子", "interest_income"),
    (r"公庫|融資|借入|ローン", "loan_received"),
    (r"補助金|助成金|給付金", "subsidy"),
    (r"還付", "tax_refund"),
    (r"手付|前受|着手金|予約金", "advance_received"),
    (r"個人|事業主|自分|振替", "private_in_kojin"),
    (r"資本金|増資|出資", "capital"),
    (r"メルカリ|ヤフオク|買取|不用品|キャッシュバック|ポイント|還元", "misc_income"),
    (r"振込|入金|株式会社|有限会社|合同会社|\(株\)|（株）|ｶ\)|Stripe|PayPal|BASE|STORES|Amazon|note|報酬|原稿料|売上|請求", "sales"),
]

REDUCED_8_HINT = r"コンビニ|セブン|ローソン|ファミマ|ファミリーマート|スーパー|イオン|マルエツ|成城石井|ライフ|弁当|飲料|お茶|食品|パン|水|新聞購読|テイクアウト|Uber Eats|出前"
EXEMPT_HINT = r"保険|利息|利子|切手|印紙|住民票|証明書"
PRIVATE_HINT = r"国民年金|国民健康保険|国保|所得税|住民税|生活費|生命保険|個人口座|家族|プライベート|私用"


def _hash01(text: str, salt: str = "") -> float:
    h = hashlib.sha256((salt + text).encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big") / 0xFFFFFFFF


def _pick(rules: list[tuple[str, str]], text: str) -> str | None:
    for pattern, code in rules:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return code
    return None


class MockJevClient:
    """JevClient と同じ system_one(state, questions) を持つ。"""

    is_mock = True
    model = "mock-jev"

    def system_one(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        direction = ""
        if isinstance(state, dict):
            direction = str(state.get("direction", ""))
            text = " ".join(str(state.get(k, "")) for k in ("payee", "description", "memo", "counterparty"))
        side_in = "in" in direction.lower() or "収入" in direction or "入金" in direction

        answers: dict[str, Any] = {}
        for qid, q in questions.items():
            qtype = q.get("type")
            if qtype == "choice":
                answers[qid] = self._choice(qid, q, text, side_in)
            elif qtype == "noul":
                answers[qid] = {"type": "noul", "noul": self._noul(qid, text)}
            elif qtype == "score":
                crit = q.get("criteria") or []
                n = max(1, len(crit))
                s = _hash01(text, qid) * (n - 1)
                answers[qid] = {"type": "score", "score": round(s, 3), "confidence": 0.7, "probabilities": {}}
        approx_tokens = max(60, len(text) + sum(len(json.dumps(q, ensure_ascii=False)) for q in questions.values()) // 3)
        return {"model": self.model, "answers": answers, "usage": {"input_tokens": approx_tokens, "output_tokens": 0}}

    # ----------------------------------------------------------------
    def _choice(self, qid: str, q: dict[str, Any], text: str, side_in: bool) -> dict[str, Any]:
        options = list((q.get("criteria") or {}).keys())
        if not options:
            return {"type": "choice", "choice": None, "probabilities": {}, "confidence": 0.0}

        hit: str | None = None
        if qid == "tax":
            if re.search(EXEMPT_HINT, text, re.IGNORECASE) and "exempt" in options:
                hit = "exempt"
            elif re.search(REDUCED_8_HINT, text, re.IGNORECASE) and "reduced_8" in options:
                hit = "reduced_8"
            elif "taxable_10" in options:
                hit = "taxable_10"
            base = 0.80
        else:
            hit = _pick(IN_RULES if side_in else OUT_RULES, text)
            if hit and hit.endswith("_kojin") and hit not in options:
                hit = hit.replace("_kojin", "_hojin")
            if hit not in options:
                hit = None
            base = 0.84

        r = _hash01(text, qid)
        if hit is None:
            # 該当なし: 「不明」系か雑費に低確信度で落とす
            fallback = next((o for o in ("suspense_out", "suspense_in", "misc_expense", "misc_income") if o in options), options[0])
            hit = fallback
            p_main = 0.35 + 0.25 * r
        else:
            p_main = base + (1 - base) * r  # 0.84〜1.0 / 0.80〜1.0
            if re.search(r"コンビニ|セブン|ローソン|ファミマ|ファミリーマート", text) and qid == "account":
                p_main = 0.55 + 0.25 * r  # コンビニは会議費/消耗品/私用で揺れるので低め

        probs = self._spread(options, hit, p_main, text + qid)
        conf = self._confidence(probs)
        return {"type": "choice", "choice": hit, "probabilities": probs, "confidence": round(conf, 3)}

    @staticmethod
    def _spread(options: list[str], main: str, p_main: float, salt: str) -> dict[str, float]:
        others = [o for o in options if o != main]
        rest = 1.0 - p_main
        probs = {o: 0.0 for o in options}
        probs[main] = p_main
        if others:
            # 残りを 2〜3 個の候補にハッシュで配分、その他は微小
            ranked = sorted(others, key=lambda o: _hash01(o, salt))
            top = ranked[: min(3, len(ranked))]
            weights = [0.6, 0.3, 0.1][: len(top)]
            wsum = sum(weights)
            for o, w in zip(top, weights):
                probs[o] = rest * (w / wsum)
        # 丸め
        return {k: round(v, 4) for k, v in probs.items()}

    @staticmethod
    def _confidence(probs: dict[str, float]) -> float:
        """分布の尖り具合。1位と2位の差を主に見る簡易版。"""
        vals = sorted(probs.values(), reverse=True)
        if not vals:
            return 0.0
        top = vals[0]
        second = vals[1] if len(vals) > 1 else 0.0
        return max(0.0, min(1.0, top - second * 0.5 + (top - 0.5) * 0.3))

    @staticmethod
    def _noul(qid: str, text: str) -> float:
        if qid == "is_private":
            if re.search(PRIVATE_HINT, text, re.IGNORECASE):
                return round(0.85 + 0.14 * _hash01(text, qid), 3)
            return round(0.03 + 0.2 * _hash01(text, qid), 3)
        return round(_hash01(text, qid), 3)
