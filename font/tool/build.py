# tool/build.py — 正本（src/*.js）と道具のコードを1枚ずつのページにまとめる
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
common = [("__PC__", "tool/vendor/polygon-clipping.umd.min.js"), ("__KANA__", "src/kana.js"), ("__GLYPHS__", "src/glyphs.js"), ("__GEOM__", "tool/geom.js")]
for tpl, out, extra in [("knobs.template.html", "knobs.html", [("__APP__", "tool/app.js")]),
                        ("light.template.html", "light.html", [("__LIGHT__", "tool/light-app.js")])]:
    t = (root / "tool" / tpl).read_text()
    for key, f in common + extra:
        s = (root / f).read_text()
        assert "</script" not in s.lower(), f
        t = t.replace("/*" + key + "*/", s)
    (root / "tool" / out).write_text(t)
    print("tool/" + out, len(t))
