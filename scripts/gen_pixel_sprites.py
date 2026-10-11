"""ドット絵スプライトを SVG(data URI) として jev_kaikei/static/sprites.css に書き出す。

文字で描いたグリッドを 1 マス = 1 rect の SVG にする。画面側は image-rendering: pixelated で拡大する。
実行: python scripts/gen_pixel_sprites.py
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "jev_kaikei" / "static" / "sprites.css"

PALETTE = {
    "G": "#f2c14e",  # 金
    "D": "#c9a227",  # 金の影
    "L": "#ffe08a",  # 金のハイライト
    "R": "#f24f75",  # 深紅（角）
    "M": "#8f1f3a",  # 深紅の影
    "K": "#1a1230",  # 黒に近い紫
    "W": "#f5eedc",  # 象牙
    "P": "#8e5bd1",  # 紫
    "V": "#5b3a8a",  # 紫の影
    "E": "#e8dcc0",  # 羊皮紙の影
    "w": "#3b3560",  # 遠い星（にぶい白）
    "p": "#332352",  # 遠い星（紫）
    "g": "#5a4722",  # 遠い星（金）
}

# 判定の魔物 Jev（15×13）
IMP = """
..M.........M..
.MR.........RM.
.MRG.......GRM.
..LGGGGGGGGGL..
.LGGGGGGGGGGGL.
.GGKKGGGGGKKGG.
.GGKWGGGGGKWGG.
.GGGGGGGGGGGGG.
.GGGGGGGGGGGGG.
..GGKKKKKKKGG..
..GGGWKKKWGGG..
...DGGGGGGGD...
....DDDDDDD....
"""

# 金貨（9×9）
COIN = """
..DGGGD..
.DLGGGGD.
DLGGGGGGD
GLGGKGGGG
GGGGKGGGG
GGGGKGGGD
DGGGGGGDD
.DGGGGDD.
..DDDDD..
"""

# 深紅の封蝋・注意（9×9）
SEAL = """
..MRRRM..
.MRRRRRM.
MRRWRRRRM
RRRWRRRRR
RRRWRRRRR
RRRRRRRRR
MRRWRRRRM
.MRRRRRM.
..MMMMM..
"""

# 羊皮紙のレシート（11×13、上下ギザギザ）
RECEIPT = """
W.W.W.W.W.W
WWWWWWWWWWW
WWWWWWWWWWW
WKKKKKKKKKW
WWWWWWWWWWW
WKKKKWWWWWW
WWWWWWWWWWW
WKKKKKKKWWW
WWWWWWWWWWW
WWWWWKKKKKW
WWWWWWWWWWW
EEEEEEEEEEE
E.E.E.E.E.E
"""


# 夜空のタイル（48×48、繰り返し。1 マス 4px = 192px で薄くまばらに散らす）
STARS = """
................................................
................................................
................................................
................................................
................................................
.............w..................................
................................................
................................................
................................................
................................................
................................................
..................................p.............
................................................
................................................
................................................
................................................
................................................
................................................
.......w........................................
................................................
................................................
................................................
................................................
................................................
.........................................g......
................................................
................................................
................................................
................................................
................................................
....................W...........................
................................................
................................................
................................................
................................................
................................................
................................................
.............................w..................
................................................
................................................
................................................
................................................
................................................
...........p....................................
................................................
................................................
................................................
................................................
"""


def to_svg(grid: str) -> tuple[str, int, int]:
    rows = [r for r in grid.strip("\n").splitlines() if r]
    h, w = len(rows), max(len(r) for r in rows)
    rects = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            # CSS の url("...") に入れるので属性は単引用符。# は %23 にする（下の data_uri）
            rects.append(f"<rect x='{x}' y='{y}' width='1' height='1' fill='{PALETTE[ch]}'/>")
    svg = (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' shape-rendering='crispEdges'>"
           + "".join(rects) + "</svg>")
    return svg, w, h


def data_uri(svg: str) -> str:
    return "data:image/svg+xml," + quote(svg, safe="/:=,.<>' -")


def main() -> None:
    sprites = {"imp": IMP, "coin": COIN, "seal": SEAL, "receipt": RECEIPT, "stars": STARS}
    lines = ["/* 自動生成: python scripts/gen_pixel_sprites.py で作り直す。手で編集しない */", ":root {"]
    for name, grid in sprites.items():
        svg, w, h = to_svg(grid)
        lines.append(f'  --px-{name}: url("{data_uri(svg)}");')
        lines.append(f"  --px-{name}-w: {w}; --px-{name}-h: {h};")
    lines.append("}")
    for name, grid in sprites.items():
        _, w, h = to_svg(grid)
        lines.append(f".px-{name} {{ background-image: var(--px-{name}); background-repeat: no-repeat; background-size: 100% 100%; image-rendering: pixelated; aspect-ratio: {w} / {h}; }}")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(sprites)} sprites)")


if __name__ == "__main__":
    main()
