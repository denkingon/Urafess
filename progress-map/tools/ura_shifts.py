"""裏の字（その時間帯が残していくもの）が重ならないずらし（shift）を探す。出た値を data.py の URA_* に手で写す。"""
import sys, importlib.util, itertools
import os
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location('g9', os.path.join(HERE, 'gen9.py')); g9 = importlib.util.module_from_spec(spec); spec.loader.exec_module(g9)
g7, D = g9.g7, g9.D
RR = g7.RR
def entries():
    out = []
    for u in D.URA_SOLID: out.append((u, 20 if u['ring'] != 'ita' else 17))
    for u in D.URA_PLANNED: out.append((u, 20 if u['ring'] != 'ita' else 15))
    for u in D.URA_EMPTY: out.append((u, 17))
    out.append((D.MOTTO, 22))
    return out
FIXED = [("いた人 ─ のべ150人・約10回", g7.RLA, RR["ita"], 15)] + [(n, g7.RLA, RR[r], 15) for n, r in [("イータ", "eta"), ("SFC", "sfc"), ("世界", "world")]] + [("ここまで届いたものが、縁を越えて表で次の回の妄想になる →", -90, RR["world"], 18)]
fixed_boxes = [g7.arc_boxes(n, a, r, fs) for n, a, r, fs in FIXED]
E = entries()
def boxes(u, fs):
    return g7.arc_boxes(u['txt'], g7.ura_angle(u), RR[u['ring']], fs)
def bad_count():
    bx = [boxes(u, fs) for u, fs in E]
    n = 0
    for i in range(len(bx)):
        for j in range(i + 1, len(bx)):
            n += g7.overlap(bx[i], bx[j])
        for fb in fixed_boxes:
            n += g7.overlap(bx[i], fb)
    return n
def bad_for(i):
    u, fs = E[i]
    b = boxes(u, fs); n = 0
    for j, (v, fs2) in enumerate(E):
        if j != i: n += g7.overlap(b, boxes(v, fs2))
    for fb in fixed_boxes: n += g7.overlap(b, fb)
    return n
MAXS = int(os.environ.get('MAXS', '16'))  # ずらしの上限（度）。入りきらないときだけ広げる
if os.environ.get('RESET'):
    for u, _ in E: u['shift'] = 0
print('start overlaps', bad_count())
orig = {u['txt']: u.get('shift', 0) for u, _ in E}
for it in range(0 if os.environ.get('RELAX') else 12):
    changed = False
    for i, (u, fs) in enumerate(E):
        if bad_for(i) == 0: continue
        s0 = u.get('shift', 0)
        best = None
        for ds in [x * 0.5 for x in range(-2 * MAXS, 2 * MAXS + 1)]:
            s = round(s0 + ds, 1)
            if abs(s) > MAXS: continue
            u['shift'] = s
            sc = (bad_for(i), bad_count(), abs(s - orig[u['txt']]))
            if best is None or sc < best[0]: best = (sc, s)
        if best is None: continue  # もう上限より大きくずれている（RELAX で解いたあと）
        u['shift'] = best[1]; changed = True
    if bad_count() == 0: break
print('end overlaps', bad_count())
for u, _ in E:
    if u.get('shift', 0) != orig[u['txt']]: print('  ', u['txt'], orig[u['txt']], '→', u['shift'])
# 残りを表示し、輪の名前の角度も動かして探す
def remaining():
    bx = [(u['txt'], boxes(u, fs)) for u, fs in E]
    out = []
    for i in range(len(bx)):
        for j in range(i + 1, len(bx)):
            if g7.overlap(bx[i][1], bx[j][1]): out.append((bx[i][0], bx[j][0]))
        for (n, a, r, fs), fb in zip(FIXED, fixed_boxes):
            if g7.overlap(bx[i][1], fb): out.append((bx[i][0], n))
    return out
print(remaining())
import math
for u, fs in E:
    print(round(g7.ura_angle(u), 1), u['ring'], u['txt'], u.get('shift', 0))
best = None
for rla in [x * 2.0 for x in range(-90, 90)]:
    FIXED[:4] = [("いた人 ─ のべ150人・約10回", rla, RR["ita"], 15)] + [(n, rla, RR[r], 15) for n, r in [("イータ", "eta"), ("SFC", "sfc"), ("世界", "world")]]
    fixed_boxes[:] = [g7.arc_boxes(n, a, r, fs) for n, a, r, fs in FIXED]
    c = bad_count()
    if c == 0: print('RLA ok', rla)


# ---------- 輪ごとに押し広げて解く（RELAX=1）。上の探し方で残るときに使う ----------
def relax(quiet=False):
    """輪ごとに、字を真裏の角度（shift 0）から始め、重なっている隣どうしを同じだけ押し広げるのをくり返す。
    輪の名前と世界の輪の文は動かさない。並び順は変えない"""
    import math
    for u, _ in E:
        u['shift'] = 0
    # 輪の名前は、いまの決まりの角度（g7.RLA）に戻してから（上の探し方が動かしているため）
    FIXED[:4] = [("いた人 ─ のべ150人・約10回", g7.RLA, RR["ita"], 15)] + [(n, g7.RLA, RR[r], 15) for n, r in [("イータ", "eta"), ("SFC", "sfc"), ("世界", "world")]]
    fixed_boxes[:] = [g7.arc_boxes(n, a, r, fs) for n, a, r, fs in FIXED]
    def half(txt, ang, R, fs):
        bx = g7.arc_boxes(txt, ang, R, fs)
        q = math.radians(ang)
        tx, ty = -math.sin(q), math.cos(q)
        return sum(g7.g3.step_along(c, fs, tx, ty) for c in txt) / 2 / R * 180 / math.pi + 1.2
    for ring, R in RR.items():
        mov = [(u, fs) for u, fs in E if u['ring'] == ring]
        fix = [(n, a, fs) for n, a, r, fs in FIXED if r == R]
        if not mov:
            continue
        base = {id(u): g7.ura_angle(u) for u, _ in mov}
        for _ in range(4000):
            objs = [[g7.ura_angle(u) % 360, half(u['txt'], g7.ura_angle(u), R, fs), u] for u, fs in mov] + [[a % 360, half(n, a, R, fs), None] for n, a, fs in fix]
            objs.sort(key=lambda o: o[0])
            moved = False
            for i in range(len(objs)):
                A, B = objs[i], objs[(i + 1) % len(objs)]
                gap = (B[0] - A[0]) % 360
                lack = A[1] + B[1] - gap
                if len(objs) > 1 and lack > 0.01:
                    moved = True
                    if A[2] is not None and B[2] is not None:
                        # 裏は鏡うつしなので、shift を増やすと裏の角度は減る
                        A[2]['shift'] = A[2].get('shift', 0) + lack / 2 + 0.02; B[2]['shift'] = B[2].get('shift', 0) - lack / 2 - 0.02
                    elif A[2] is not None:
                        A[2]['shift'] = A[2].get('shift', 0) + lack + 0.02
                    elif B[2] is not None:
                        B[2]['shift'] = B[2].get('shift', 0) - lack - 0.02
            if not moved:
                break
    if not quiet:
        print('relax: overlaps', bad_count(), remaining())
        for u, _ in E:
            print('   %-28s shift=%.1f' % (u['txt'], u.get('shift', 0)))
    return bad_count(), sum(abs(u.get('shift', 0)) for u, _ in E)


if os.environ.get('RELAX') == 'search':  # 輪の名前の角度（gen9.py の g7.RLA）も動かして、ずらしの合計がいちばん小さい所を探す
    res = []
    for rla in range(-180, 180, 4):
        g7.RLA = float(rla)
        res.append((relax(quiet=True), rla))
    res.sort()
    print('RLA の候補（重なり, ずらしの合計）:', [(r, round(c[1], 1)) for c, r in res[:6] if c[0] == 0])
    g7.RLA = float(res[0][1])
    relax()
elif os.environ.get('RELAX'):
    relax()
