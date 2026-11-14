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
print('start overlaps', bad_count())
orig = {u['txt']: u.get('shift', 0) for u, _ in E}
for it in range(6):
    changed = False
    for i, (u, fs) in enumerate(E):
        if bad_for(i) == 0: continue
        s0 = u.get('shift', 0)
        best = None
        for ds in [x * 0.5 for x in range(-30, 31)]:
            s = round(s0 + ds, 1)
            if abs(s) > 16: continue
            u['shift'] = s
            sc = (bad_for(i), bad_count(), abs(s - orig[u['txt']]))
            if best is None or sc < best[0]: best = (sc, s)
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
