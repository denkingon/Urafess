#!/usr/bin/env python3
"""
build.py <glyphs.json> <outdir> [--style Black] [--family URAJI]
src/glyphs.js（＋kana.js）が書き出した字形の木を pathops で解いて OTF / WOFF2 を作る。
同時に、閉じた穴（型紙で抜けない字）と、線の近くの細切れ（スリバー）を報告する。
"""
import json, os, sys
from pathops import Path, PathOp, op, simplify, LineCap, LineJoin
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.roundingPen import RoundingPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.areaPen import AreaPen
from fontTools.ttLib import TTFont


def ev(n):
    t = n[0]
    if t == "path":
        p = Path(); pen = p.getPen()
        for c in n[1]:
            if c[0] == "M": pen.moveTo((c[1], c[2]))
            elif c[0] == "L": pen.lineTo((c[1], c[2]))
            elif c[0] == "C": pen.curveTo((c[1], c[2]), (c[3], c[4]), (c[5], c[6]))
            elif c[0] == "Z": pen.closePath()
        return p
    if t == "U":
        out = Path()
        for ch in n[1:]:
            out = op(out, ev(ch), PathOp.UNION)
        return out
    if t == "D":
        a = ev(n[1])
        for b in n[2:]:
            a = op(a, ev(b), PathOp.DIFFERENCE)
        return a
    if t == "I":
        return op(ev(n[1]), ev(n[2]), PathOp.INTERSECTION)
    if t == "O":
        base = ev(n[2])
        if not nonempty(base):
            return base
        st = Path(base)
        st.stroke(2 * n[1], LineCap.BUTT_CAP, LineJoin.MITER_JOIN, 4)
        return op(base, st, PathOp.UNION)
    if t == "X":
        out = Path()
        ev(n[2]).draw(TransformPen(out.getPen(), tuple(n[1])))
        return out
    raise ValueError(t)


def nonempty(p):
    return p is not None and len(list(p.segments)) > 0


def solve(tree):
    p = ev(tree)
    return simplify(p, clockwise=False) if nonempty(p) else Path()


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    style = sys.argv[sys.argv.index("--style") + 1] if "--style" in sys.argv else "Black"
    family = sys.argv[sys.argv.index("--family") + 1] if "--family" in sys.argv else "URAJI"
    data = json.load(open(src))
    glyphs = data["glyphs"]
    order = [".notdef"] + [g["name"] for g in glyphs]
    cmap, cs, metrics = {}, {}, {}
    report = {"holes": [], "slivers": []}

    def charstring(path, adv):
        pen = T2CharStringPen(adv, None)
        if nonempty(path):
            path.draw(RoundingPen(pen))
        return pen.getCharString()

    nd = op(ev(["path", [["M", 50, 0], ["L", 450, 0], ["L", 450, 700], ["L", 50, 700], ["Z"]]]),
            ev(["path", [["M", 110, 60], ["L", 390, 60], ["L", 390, 640], ["L", 110, 640], ["Z"]]]), PathOp.DIFFERENCE)
    cs[".notdef"] = charstring(simplify(nd, clockwise=False), 500)
    metrics[".notdef"] = (500, 50)

    for g in glyphs:
        name, adv = g["name"], round(g["adv"])
        p = solve(g["tree"])
        cs[name] = charstring(p, adv)
        bp = BoundsPen(None)
        if nonempty(p):
            p.draw(bp)
        metrics[name] = (adv, round(bp.bounds[0]) if bp.bounds else 0)
        for u in g["u"]:
            cmap[u] = name
        if nonempty(p):
            for ct in p.contours:
                if ct.clockwise and not name.endswith(".ss01") and name not in report["holes"]:
                    report["holes"].append(name)
                b = BoundsPen(None); ct.draw(b)
                a = AreaPen(); ct.draw(a)
                x0, y0, x1, y1 = b.bounds
                if (min(x1 - x0, y1 - y0) < 26 or abs(a.value) < 2200) and name not in report["slivers"]:
                    report["slivers"].append(name)

    kern_names = set(order)
    lines = ["languagesystem DFLT dflt;", "languagesystem latn dflt;", "languagesystem kana dflt;", "languagesystem hani dflt;", "feature kern {"]
    lines += [f"  pos {a} {b} {v};" for a, b, v in data["kern"] if a in kern_names and b in kern_names]
    lines.append("} kern;")
    if data.get("liga"):
        lines += ["feature liga {"]
        lines += [f"  sub {' '.join(seq)} by {lig};" for seq, lig in data["liga"]]
        lines.append("} liga;")
    if data.get("ss02"):
        lines += ["feature ss02 {", '  featureNames { name "Urasai"; };']
        lines += [f"  sub {a} by {b};" for a, b in data["ss02"]]
        lines.append("} ss02;")
    if data["ss01"]:
        lines += ["feature ss01 {", '  featureNames { name "Stencil"; };']
        lines += [f"  sub {a} by {b};" for a, b in data["ss01"]]
        lines.append("} ss01;")
    fea = "\n".join(lines)

    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    ps = f"{family}-{style}"
    fb.setupCFF(ps, {"FullName": f"{family} {style}", "FamilyName": family, "Weight": style}, cs, {})
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=880, descent=-220)
    fb.setupNameTable({
        "copyright": "(c) 2026 Urafess",
        "familyName": family, "styleName": "Regular",
        "uniqueFontIdentifier": f"{ps};0.4", "fullName": f"{family} {style}", "psName": ps,
        "version": "Version 0.400", "typographicFamily": family, "typographicSubfamily": style,
        "description": "裏フェスのための書体。字の高さの0.618に一本の線が走る。小文字は線の下に収まる。",
    })
    fb.setupOS2(version=4, sTypoAscender=880, sTypoDescender=-220, sTypoLineGap=0,
                usWinAscent=900, usWinDescent=260, sxHeight=round(data["geo"]["S0"]), sCapHeight=700,
                usWeightClass=900, fsSelection=0x0040 | 0x0080, achVendID="URAF",
                ulUnicodeRange1=0b11, ulCodePageRange1=(1 << 0) | (1 << 17))
    fb.setupPost()
    fb.addOpenTypeFeatures(fea)
    os.makedirs(outdir, exist_ok=True)
    otf = os.path.join(outdir, f"{ps}.otf")
    fb.save(otf)
    f = TTFont(otf); f.flavor = "woff2"
    woff2 = os.path.join(outdir, f"{ps}.woff2"); f.save(woff2)
    print(json.dumps({"otf": otf, "woff2": woff2, "glyphs": len(glyphs), **report}, ensure_ascii=False))


if __name__ == "__main__":
    main()
