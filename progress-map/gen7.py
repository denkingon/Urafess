#!/usr/bin/env python3
"""B' 夜の時計 ─ 表と裏（11/06 更新）。data.py の一つの表から作る。
これから（日付未定）を時間の帯の先に足し、点線の○で「次に行きたい所」を出す。
"""
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import data as D  # noqa: E402

spec = importlib.util.spec_from_file_location("g3", os.path.join(HERE, "gen3.py"))
g3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g3)

PROJ = g3.PROJ
W, H = 1720, 1700
CX, CY = 840, 780
RING = [340, 275, 210, 145, 85, 30]
RU = 380
RIM = 650
SEAM = 628
RR = {"ita": 200, "eta": 320, "sfc": 440, "world": 600}
FONT, MONO = g3.FONT, g3.MONO
DEF = g3.DEF
FS = [28, 24, 17]
STAGE_RAY = None  # set after sectors
RLA = -20.0  # 裏の輪の名前（いた人・イータ・SFC・世界）を置く角度


def back(a):
    return 180.0 - a


# ---------- layout from the one table ----------
def sectors():
    cnt = {s: 0 for s in D.SECTORS}
    for it in D.ITEMS:
        cnt[it["sec"]] += 1
    w = {s: 1 + 0.5 * cnt[s] for s in D.SECTORS}
    tot = sum(w.values())
    a = -90.0
    out = {}
    for s in D.SECTORS:
        span = 360.0 * w[s] / tot
        out[s] = (a, a + span)
        a += span
    return out


SEC = sectors()
ANG = {}
for s in D.SECTORS:
    ids = [it for it in D.ITEMS if it["sec"] == s]
    a0, a1 = SEC[s]
    for i, it in enumerate(ids):
        ANG[it["k"]] = a0 + (a1 - a0) * (i + 0.5) / len(ids)
STAGE_RAY = SEC["最後の発表"][0]


def ura_angle(u):
    if "item" in u:
        fa = ANG[u["item"]]
    else:
        a0, a1 = SEC[u["sec"]]
        fa = (a0 + a1) / 2
    return back(fa + u.get("shift", 0))


# ---------- geometry checks (same rules the page uses) ----------
def needle_boxes(word, ang, r0, fs):
    a = math.radians(ang)
    ux, uy = math.cos(a), math.sin(a)
    acc = r0 + 4
    boxes = []
    for c in word:
        w, h = g3.glyph_box(c, fs)
        cand = []
        if abs(ux) > 1e-6:
            cand.append(w / abs(ux))
        if abs(uy) > 1e-6:
            cand.append(h / abs(uy))
        s = min(cand) + 0.06 * fs
        d = acc + s / 2
        x, y = CX + ux * d, CY + uy * d
        boxes.append((x - w / 2, y - h / 2, x + w / 2, y + h / 2))
        acc += s
    return boxes


def arc_boxes(word, theta, R, fs):
    th = math.radians(theta)
    tx, ty = -math.sin(th), math.cos(th)
    steps = [g3.step_along(c, fs, tx, ty) for c in word]
    tot = sum(steps)
    acc = -tot / 2
    out = []
    for s in steps:
        a = th + (acc + s / 2) / R
        x, y = CX + R * math.cos(a), CY + R * math.sin(a)
        out.append((x - fs / 2, y - fs / 2, x + fs / 2, y + fs / 2))
        acc += s
    return out


def overlap(A, B, pad=1.0):
    for a in A:
        for b in B:
            if a[0] < b[2] - pad and b[0] < a[2] - pad and a[1] < b[3] - pad and b[1] < a[3] - pad:
                return True
    return False


def r_of(s):
    return RU if s == "u" else RING[s]


def check():
    problems = []
    rim = [arc_boxes(s, (SEC[s][0] + SEC[s][1]) / 2, RIM, 20) for s in D.SECTORS]
    stage_lbl = [arc_boxes(n, STAGE_RAY, r, 13) for n, r in [("妄想", 340), ("問い", 275), ("決定", 210), ("試作", 145), ("実地", 85), ("段階不明", RU)]]
    for k in range(len(D.EVENTS)):
        words = []
        for it in D.ITEMS:
            s = it["s"][k]
            if s is None:
                continue
            words.append((it["n"], needle_boxes(it["n"], ANG[it["k"]], r_of(s), FS[it["t"]])))
        for i in range(len(words)):
            for j in range(i + 1, len(words)):
                if overlap(words[i][1], words[j][1]):
                    problems.append(f"event {k}: {words[i][0]} x {words[j][0]}")
            for rb in rim:
                if overlap(words[i][1], rb):
                    problems.append(f"event {k}: {words[i][0]} x rim")
            for sb in stage_lbl:
                if overlap(words[i][1], sb):
                    problems.append(f"event {k}: {words[i][0]} x stage label")
    # 裏 rings
    def ura_list():
        out = []
        for u in D.URA_SOLID:
            out.append((u["txt"], ura_angle(u), RR[u["ring"]], 20 if u["ring"] != "ita" else 17))
        for u in D.URA_PLANNED:
            out.append((u["txt"], ura_angle(u), RR[u["ring"]], 20 if u["ring"] != "ita" else 15))
        for u in D.URA_EMPTY:
            out.append((u["txt"], ura_angle(u), RR[u["ring"]], 17))
        out.append((D.MOTTO["txt"], ura_angle(D.MOTTO), RR[D.MOTTO["ring"]], 22))
        out.append(("いた人 ─ のべ150人・約10回", RLA, RR["ita"], 15))
        for n, r in [("イータ", "eta"), ("SFC", "sfc"), ("世界", "world")]:
            out.append((n, RLA, RR[r], 15))
        out.append(("ここまで届いたものが、縁を越えて表で次の回の妄想になる →", -90, RR["world"], 18))
        return out
    ul = [(n, arc_boxes(n, a, r, fs)) for n, a, r, fs in ura_list()]
    for i in range(len(ul)):
        for j in range(i + 1, len(ul)):
            if overlap(ul[i][1], ul[j][1]):
                problems.append(f"ura: {ul[i][0]} x {ul[j][0]}")
    return problems


# ---------- page ----------
JS = r"""class Component extends DCLogic {
  componentWillUnmount() { this.stop(); }
  stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
  data() { return __DATA__; }
  clamp01(x) { return x <= 0 ? 0 : (x >= 1 ? 1 : x); }
  setT(t) { var E = this.data().end; this.setState({ t: Math.max(0, Math.min(E, t)) }); }
  needle(word, angDeg, r0, fs) {
    var a = angDeg * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
    var chars = Array.from(word);
    var fwd = Math.abs(ux) > Math.abs(uy) ? ux > 0 : uy > 0;
    var seq = fwd ? chars : chars.slice().reverse();
    var out = [], acc = r0 + 4;
    for (var i = 0; i < seq.length; i++) {
      var c = seq[i], w = fs, h = fs;
      if (c === ' ') { w = 0.35 * fs; h = 0.35 * fs; } else if (c.charCodeAt(0) < 128) { w = 0.62 * fs; h = 0.8 * fs; }
      var cand = [];
      if (Math.abs(ux) > 1e-6) cand.push(w / Math.abs(ux));
      if (Math.abs(uy) > 1e-6) cand.push(h / Math.abs(uy));
      var s = Math.min.apply(null, cand) + 0.06 * fs;
      var d = acc + s / 2;
      out.push({ c: c, x: ux * d, y: uy * d });
      acc += s;
    }
    return out;
  }
  renderVals() {
    var self = this;
    var D = this.data();
    var E = D.events, END = D.end, TODAY = D.today, NE = E.length;
    var st = this.state || {};
    var t = typeof st.t === 'number' ? st.t : TODAY;
    var playing = !!this._raf;
    var side = st.side === 'ura' ? 'ura' : 'omote';
    var col = {
      kabe: this.props.kabe ?? '#FF8A3D', hako: this.props.hako ?? '#3FD0A0',
      yume: this.props.yume ?? '#A98BFF', gu: this.props.gu ?? '#F2D74B', none: '#A6A8AD'
    };
    var CX = 840, CY = 780, RING = [340, 275, 210, 145, 85, 30], RU = 380, OUT = RU + 110, FS = [28, 24, 17];
    var rOf = function (s) { return s === 'u' ? RU : RING[s]; };
    var pt = function (a, r) { var q = a * Math.PI / 180; return [CX + Math.cos(q) * r, CY + Math.sin(q) * r]; };
    var cl = this.clamp01;
    var lin = (this.props.motion ?? '当日だけ動く') === '日付の間を直線で';
    // これから（日付未定）は、今日から先の帯いっぱいに一直線で動く
    var startOf = function (k) { return (lin || E[k].future) && k > 0 ? E[k - 1].day : E[k].day - 1; };
    var prog = function (k) { return cl((t - startOf(k)) / (E[k].day - startOf(k))); };
    var segOf = function (a, r0, r1, c, op) {
      var p0 = pt(a, r0), p1 = pt(a, r1), dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      return { x: p0[0].toFixed(1), y: p0[1].toFixed(1), len: Math.sqrt(dx * dx + dy * dy).toFixed(1), rot: (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2), col: c, op: op.toFixed(2) };
    };
    var chars = [], tips = [], trails = [], segs = [], verts = [], ghosts = [], gsegs = [];
    D.items.forEach(function (it) {
      var b = -1;
      for (var k = 0; k < NE; k++) { if (it.s[k] !== null && it.s[k] !== undefined) { b = k; break; } }
      var alive = 0, r = OUT, unknown = false, c = col[it.x];
      if (b >= 0) {
        unknown = it.s[b] === 'u';
        alive = prog(b);
        r = OUT + (rOf(it.s[b]) - OUT) * alive;
        if (alive >= 1) {
          for (var k2 = b + 1; k2 < NE; k2++) {
            var sp = it.s[k2 - 1], sk = it.s[k2];
            if (sk === sp || sk === 'u' || sp === 'u') continue;
            var f = prog(k2);
            if (f <= 0) break;
            var rp = rOf(sp), rn = rp + (rOf(sk) - rp) * f;
            var p0 = pt(it.a, rp);
            trails.push({ x: p0[0].toFixed(1), y: p0[1].toFixed(1), col: c });
            segs.push(segOf(it.a, rp, rn, c, E[k2].future ? 0.55 : 0.7));
            r = rn;
            if (f < 1) break;
          }
        }
      }
      // 次に行きたい所（これからの段階）を点線の○で
      var sNow = it.s[NE - 2], sPlan = it.s[NE - 1];
      if (sNow !== null && sNow !== undefined && sNow !== 'u' && sPlan !== sNow && alive >= 1 && t > TODAY - 1 && t < E[NE - 1].day) {
        var fade = Math.min(cl(t - (TODAY - 1)), 1 - prog(NE - 1));
        var gp = pt(it.a, rOf(sPlan));
        ghosts.push({ x: gp[0].toFixed(1), y: gp[1].toFixed(1), col: c, op: (0.95 * fade).toFixed(2) });
        gsegs.push(segOf(it.a, r, rOf(sPlan), c, 0.45 * fade));
      }
      var g = 0;
      it.now.forEach(function (k) {
        var dd = E[k].day, v;
        if (E[k].future) v = 0.85 * prog(k);
        else v = t <= dd ? cl(t - (dd - 1)) : 1 - cl((t - dd) / 3);
        if (v > g) g = v;
      });
      var fs = FS[it.t];
      var op = alive * (unknown ? 0.45 : 0.55 + 0.45 * g);
      var glow = g > 0.02 ? '0 0 10px rgba(255,255,255,' + (0.55 * g).toFixed(2) + '), 0 0 26px rgba(255,255,255,' + (0.22 * g).toFixed(2) + ')' : 'none';
      self.needle(it.n, it.a, r, fs).forEach(function (p) {
        chars.push({ c: p.c, x: (CX + p.x).toFixed(1), y: (CY + p.y).toFixed(1), fs: fs, col: c, op: op.toFixed(3), glow: glow, fw: it.t === 0 ? 900 : 700 });
      });
      var tp = pt(it.a, r);
      tips.push({ x: tp[0].toFixed(1), y: tp[1].toFixed(1), bg: g >= 0.5 ? '#FFFFFF' : c, op: (alive * (unknown ? 0.45 : 1)).toFixed(3), cls: g >= 0.5 ? 'now-ring' : '' });
      verts.push({ a: it.a, r: alive > 0 ? r : RU });
    });
    verts.sort(function (p, q) { return p.a - q.a; });
    var P = verts.map(function (v) { return pt(v.a, Math.min(v.r, RU)); });
    var n = P.length, f2 = function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); };
    var shapeD = 'M ' + f2(P[0]);
    for (var i = 0; i < n; i++) {
      var a0 = P[(i - 1 + n) % n], a1 = P[i], a2 = P[(i + 1) % n], a3 = P[(i + 2) % n];
      shapeD += ' C ' + f2([a1[0] + (a2[0] - a0[0]) / 6, a1[1] + (a2[1] - a0[1]) / 6]) + ' ' + f2([a2[0] - (a3[0] - a1[0]) / 6, a2[1] - (a3[1] - a1[1]) / 6]) + ' ' + f2(a2);
    }
    shapeD += ' Z';
    // 日付・直近の動き
    var inFuture = t > TODAY + 1e-6;
    var day = Math.floor(Math.min(t, TODAY) + 1e-6);
    var dt = new Date(2026, 9, 7 + day);
    var dateStr = inFuture ? 'これから' : (dt.getMonth() + 1) + '/' + ('0' + dt.getDate()).slice(-2);
    var last = 0;
    for (var e = 0; e < NE; e++) { if (E[e].day <= t + 1e-6) last = e; }
    var ramping = -1;
    for (var e2 = 0; e2 < NE; e2++) { if (t > startOf(e2) + 1e-6 && t < E[e2].day - 1e-6) ramping = e2; }
    var caption;
    if (ramping >= 0) caption = (E[ramping].future ? '' : '→ ' + E[ramping].d + '：') + E[ramping].t;
    else if (t - E[last].day < 1) caption = E[last].t;
    else caption = E[last].d + ' から ' + Math.floor(t - E[last].day) + '日、動きなし';
    var k0 = ramping >= 0 ? ramping : last;
    var fut = !!E[k0].future;
    var born = [], moved = [], touched = [];
    D.items.forEach(function (it) {
      var s = it.s[k0], before = k0 > 0 ? it.s[k0 - 1] : null;
      var al = s !== null && s !== undefined, was = before !== null && before !== undefined;
      if (al && !was) born.push(it.n);
      else if (al && was && s !== before && s !== 'u') moved.push(it.n + ' ' + D.stageName[before] + '→' + D.stageName[s]);
      else if (it.now.indexOf(k0) >= 0) touched.push(it.n);
    });
    var log = [];
    if (born.length) log.push({ k: '生まれた', v: born.join('、') });
    if (moved.length) log.push({ k: fut ? '進めたい' : '進んだ', v: moved.join('、') });
    if (touched.length) log.push({ k: fut ? '手を入れたい' : '手を入れた', v: touched.join('、') });
    // 時間の帯：日数はそのまま一直線。日の数字と月、今日、これから
    var TW = 780, PAD = 9, X = function (d) { return PAD + (TW - 2 * PAD) * d / END; };
    var ticks = E.map(function (ev, k) {
      var cnt = 0;
      D.items.forEach(function (it) { if (it.now.indexOf(k) >= 0) cnt++; });
      var on = ev.future ? inFuture : Math.abs(t - ev.day) < 0.5;
      var lab = ev.future ? 'これから' : String(parseInt(ev.d.split('/')[1], 10));
      return {
        d: lab, x: X(ev.day).toFixed(1), h: ev.future ? 0 : 6 + cnt * 5, top: ev.future ? 40 : 40 - (6 + cnt * 5),
        w: ev.future ? 72 : 22, col: on ? '#FFFFFF' : '#8E8E8A', bar: on ? '#FFFFFF' : '#55585F', fw: on ? 600 : 500,
        go: function () { self.stop(); self.setT(ev.day); }
      };
    });
    var days = [];
    for (var dd2 = 0; dd2 <= TODAY; dd2++) { days.push({ x: X(dd2).toFixed(1) }); }
    var plans = D.items.filter(function (it) { return !!it.plan; }).map(function (it) { return { n: it.n, p: it.plan, col: col[it.x] }; });
    return {
      kabe: col.kabe, hako: col.hako, yume: col.yume, gu: col.gu,
      flipDeg: side === 'ura' ? 180 : 0, omotePE: side === 'ura' ? 'none' : 'auto', uraPE: side === 'ura' ? 'auto' : 'none',
      isOmote: side !== 'ura', isUra: side === 'ura',
      omoteBtn: side !== 'ura' ? '#ECECEA' : '#8E8E8A', uraBtn: side === 'ura' ? '#ECECEA' : '#8E8E8A',
      omoteBd: side !== 'ura' ? '#ECECEA' : '#34373E', uraBd: side === 'ura' ? '#ECECEA' : '#34373E',
      toUra: function () { self.setState({ side: 'ura' }); },
      toOmote: function () { self.setState({ side: 'omote' }); },
      chars: chars, tips: tips, trails: trails, segs: segs, shapeD: shapeD, ghosts: ghosts, gsegs: gsegs,
      tStr: t.toFixed(2), end: END, dateStr: dateStr, dateFs: inFuture ? 64 : 96, caption: caption,
      logHead: fut ? 'これからやりたいこと（段階が動くもの）' : E[k0].d + ' の動き', log: log, ticks: ticks, days: days, plans: plans,
      todayX: (X(TODAY) - 1).toFixed(1), futX: X(TODAY).toFixed(1), futW: (X(END) - X(TODAY)).toFixed(1),
      m11X: X(25).toFixed(1),
      playing: playing, notPlaying: !playing, playLabel: playing ? '止める' : '10/07から再生',
      prev: function () {
        self.stop(); var tg = 0;
        E.forEach(function (ev) { if (ev.day < t - 0.01) tg = ev.day; });
        self.setT(tg);
      },
      next: function () {
        self.stop(); var tg = END;
        for (var q = NE - 1; q >= 0; q--) { if (E[q].day > t + 0.01) tg = E[q].day; }
        self.setT(tg);
      },
      onRange: function (ev) { self.stop(); self.setT(parseFloat(ev.target.value) || 0); },
      togglePlay: function () {
        if (self._raf) { self.stop(); self.forceUpdate(); return; }
        var tt = t >= END - 0.01 ? 0 : t, lastTs = null, rate = END / 11;
        self.setT(tt);
        var loop = function (ts) {
          if (lastTs === null) lastTs = ts;
          tt = Math.min(END, tt + (ts - lastTs) / 1000 * rate);
          lastTs = ts;
          if (tt >= END) { self._raf = null; self.setT(END); return; }
          self._raf = requestAnimationFrame(loop);
          self.setT(tt);
        };
        self._raf = requestAnimationFrame(loop);
      },
      onWheel: function (ev) { self.stop(); self.setT(t + (ev.deltaY || 0) / 80); }
    };
  }
}"""


def js_data():
    return {
        "end": D.END, "today": D.TODAY, "events": D.EVENTS,
        "stageName": ["妄想", "問い", "決定", "試作", "実地", "本番"],
        "items": [{"n": it["n"], "a": round(ANG[it["k"]], 2), "t": it["t"], "x": it["x"], "s": it["s"], "now": it["now"], "plan": it.get("plan")} for it in D.ITEMS],
    }


def ura_text():
    arc = g3.arc_text
    out = []
    for u in D.URA_SOLID:
        out.append(arc(u["txt"], ura_angle(u), RR[u["ring"]], 20 if u["ring"] != "ita" else 17, "{{" + u["col"] + "}}", 900))
    for u in D.URA_PLANNED:
        out.append(arc(u["txt"], ura_angle(u), RR[u["ring"]], 20 if u["ring"] != "ita" else 15, "{{" + u["col"] + "}}", 700).replace("font-weight: 700;", "font-weight: 700; opacity: 0.55;"))
    for u in D.URA_EMPTY:
        out.append(arc(u["txt"], ura_angle(u), RR[u["ring"]], 17, "#6E7177", 700))
    out.append(arc(D.MOTTO["txt"], ura_angle(D.MOTTO), RR[D.MOTTO["ring"]], 22, "#ECECEA", 900))
    return "\n".join(out) + "\n"


def band_html():
    btn = "flex: none; width: 44px; height: 44px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: #1C1E23; border: 1px solid #34373E; border-radius: 8px; color: #ECECEA; cursor: pointer; padding: 0px"
    ico = 'width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    return (
        f'<div style="position: absolute; left: 64px; top: 1484px; width: 1592px; display: flex; align-items: flex-start; gap: 40px">'
        f'<div style="flex: none; width: 340px; display: flex; flex-direction: column; gap: 8px">'
        f'<span style="font-family: {MONO}, {FONT}; font-size: {{{{dateFs}}}}px; line-height: 96px; font-weight: 600; letter-spacing: -0.02em; white-space: nowrap">{{{{dateStr}}}}</span>'
        f'<span style="font-size: 17px; line-height: 25px; font-weight: 700">{{{{caption}}}}</span></div>'
        f'<div style="flex: none; width: 780px; display: flex; flex-direction: column; gap: 2px">'
        f'<div style="position: relative; width: 780px; height: 150px">'
        f'<span style="position: absolute; left: {{{{todayX}}}}px; top: 0px; transform: translateX(-50%); font-size: 11px; line-height: 14px; font-weight: 700; color: #FFFFFF; pointer-events: none">今日</span>'
        f'<span style="position: absolute; left: {{{{todayX}}}}px; top: 16px; width: 2px; height: 72px; background: #FFFFFF; opacity: 0.8; pointer-events: none"></span>'
        f'<span style="position: absolute; left: {{{{futX}}}}px; top: 0px; width: {{{{futW}}}}px; text-align: right; font-size: 11px; line-height: 14px; color: #A3A3A0; pointer-events: none">日付未定</span>'
        f'<span style="position: absolute; left: {{{{futX}}}}px; top: 63px; width: {{{{futW}}}}px; height: 0px; border-top: 2px dashed #8E8E8A; pointer-events: none"></span>'
        f'<sc-for list="{{{{days}}}}" as="dy" hint-placeholder-count="31"><span style="position: absolute; left: {{{{dy.x}}}}px; top: 36px; width: 1px; height: 4px; background: #34373E"></span></sc-for>'
        f'<sc-for list="{{{{ticks}}}}" as="tk" hint-placeholder-count="7"><span style="position: absolute; left: {{{{tk.x}}}}px; top: {{{{tk.top}}}}px; width: 3px; height: {{{{tk.h}}}}px; margin-left: -1px; background: {{{{tk.bar}}}}"></span></sc-for>'
        f'<label for="t-range" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">日付</label>'
        f'<input id="t-range" type="range" min="0" max="{{{{end}}}}" step="0.05" value="{{{{tStr}}}}" onChange="{{{{onRange}}}}" style="position: absolute; left: 0px; top: 42px; width: 780px; height: 44px; margin: 0px; accent-color: #ECECEA; cursor: pointer">'
        f'<sc-for list="{{{{ticks}}}}" as="tk" hint-placeholder-count="7"><button type="button" onClick="{{{{tk.go}}}}" style="position: absolute; left: {{{{tk.x}}}}px; top: 86px; transform: translateX(-50%); min-width: {{{{tk.w}}}}px; min-height: 40px; padding: 0px; background: none; border: 0px; color: {{{{tk.col}}}}; font-family: {MONO}, {FONT}; font-size: 14px; font-weight: {{{{tk.fw}}}}; cursor: pointer">{{{{tk.d}}}}</button></sc-for>'
        f'<span style="position: absolute; left: 9px; top: 128px; font-size: 12px; line-height: 16px; color: #8E8E8A">10月</span>'
        f'<span style="position: absolute; left: {{{{m11X}}}}px; top: 128px; font-size: 12px; line-height: 16px; color: #8E8E8A">11月</span>'
        f'</div>'
        f'<div style="display: flex; align-items: center; gap: 10px">'
        f'<button type="button" aria-label="前の動きへ" onClick="{{{{prev}}}}" style="{btn}"><svg {ico}><path d="M11 4 L6 9 L11 14"></path></svg></button>'
        f'<button type="button" aria-label="次の動きへ" onClick="{{{{next}}}}" style="{btn}"><svg {ico}><path d="M7 4 L12 9 L7 14"></path></svg></button>'
        f'<button type="button" aria-label="{{{{playLabel}}}}" onClick="{{{{togglePlay}}}}" style="{btn}">'
        f'<sc-if value="{{{{notPlaying}}}}" hint-placeholder-val="{{{{ true }}}}"><svg {ico}><path d="M6 4 L14 9 L6 14 Z"></path></svg></sc-if>'
        f'<sc-if value="{{{{playing}}}}" hint-placeholder-val="{{{{ false }}}}"><svg {ico}><path d="M6 5 L6 13 M12 5 L12 13"></path></svg></sc-if></button>'
        f'<span style="font-size: 13px; line-height: 18px; color: #8E8E8A">1日ずつ一直線。今日より先は「これから」：日付未定のやりたいことへ動く</span></div></div>'
        f'<div style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding-top: 8px">'
        f'<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">{{{{logHead}}}}</span>'
        f'<sc-for list="{{{{log}}}}" as="l" hint-placeholder-count="3">'
        f'<div style="display: flex; flex-direction: column; gap: 2px"><span style="font-size: 12px; line-height: 16px; color: #A3A3A0">{{{{l.k}}}}</span>'
        f'<span style="font-size: 15px; line-height: 22px; font-weight: 700; color: #ECECEA">{{{{l.v}}}}</span></div>'
        f'</sc-for></div>'
        f'</div>\n'
    )


def build():
    arc = g3.arc_text
    o = [f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>B' 夜の時計・表と裏</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&amp;family=Noto+Sans+JP:wght@400;700;900&amp;display=swap">
<style>
body{{margin:0}}
@keyframes nowpulse{{0%{{box-shadow:0 0 0 0 rgba(255,255,255,0.7)}}70%{{box-shadow:0 0 0 12px rgba(255,255,255,0)}}100%{{box-shadow:0 0 0 0 rgba(255,255,255,0)}}}}
.now-ring{{animation:nowpulse 2.2s ease-out infinite}}
@keyframes spread{{0%{{transform:scale(0.04);opacity:0.6}}100%{{transform:scale(1);opacity:0}}}}
@keyframes gather{{0%{{transform:scale(1);opacity:0}}12%{{opacity:0.32}}100%{{transform:scale(0.04);opacity:0.6}}}}
.spread{{animation:spread 6s linear infinite}}
.gather{{animation:gather 6s linear infinite}}
.d2{{animation-delay:-2s}}
.d3{{animation-delay:-4s}}
</style>
</helmet>
"""]
    o.append(f'<div style="position: relative; width: {W}px; height: {H}px; overflow: hidden; background: #101114; color: #ECECEA; font-family: {FONT}">\n')
    o.append('<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; perspective: 2600px">\n')
    o.append(f'<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; transform-style: preserve-3d; transform-origin: {CX}px {CY}px; transform: rotateY({{{{flipDeg}}}}deg); transition: transform 0.9s cubic-bezier(0.4, 0, 0.2, 1)">\n')

    def scaffold(front):
        g = [f'<svg width="{W}" height="1470" viewBox="0 0 {W} 1470" aria-hidden="true" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px">']
        if front:
            for r in RING[:-1]:
                g.append(f'<circle cx="{CX}" cy="{CY}" r="{r}" fill="none" stroke="#26282D" stroke-width="1"></circle>')
            g.append(f'<circle cx="{CX}" cy="{CY}" r="{RU}" fill="none" stroke="#3A3D44" stroke-width="1" stroke-dasharray="3 6"></circle>')
        else:
            for key, op in [("ita", 0.22), ("eta", 0.22), ("sfc", 0.22), ("world", 0.36)]:
                g.append(f'<circle cx="{CX}" cy="{CY}" r="{RR[key]}" fill="none" stroke="rgba(236,236,234,{op})" stroke-width="1" stroke-dasharray="2 7"></circle>')
        g.append(f'<circle cx="{CX}" cy="{CY}" r="{SEAM}" fill="none" stroke="#4A4D54" stroke-width="1.5"></circle>')
        for s in D.SECTORS:
            a0 = SEC[s][0]
            a = a0 if front else back(a0)
            t = math.radians(a)
            g.append(f'<line x1="{CX + 34 * math.cos(t):.1f}" y1="{CY + 34 * math.sin(t):.1f}" x2="{CX + SEAM * math.cos(t):.1f}" y2="{CY + SEAM * math.sin(t):.1f}" stroke="#2A2C31" stroke-width="1" stroke-dasharray="2 6"></line>')
        g.append("</svg>\n")
        return "".join(g)

    def rim(front):
        return "".join(arc(s, ((SEC[s][0] + SEC[s][1]) / 2) if front else back((SEC[s][0] + SEC[s][1]) / 2), RIM, 20, "#8A8D93", 700) + "\n" for s in D.SECTORS)

    seg_tpl = '<span style="position: absolute; left: 0px; top: 0px; width: {{%s.len}}px; height: 0px; border-top: 1.5px dashed {{%s.col}}; opacity: {{%s.op}}; transform-origin: 0 0; transform: translate({{%s.x}}px, {{%s.y}}px) rotate({{%s.rot}}deg); pointer-events: none"></span>'

    # ===== 表 =====
    o.append('<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; backface-visibility: hidden; -webkit-backface-visibility: hidden; pointer-events: {{omotePE}}">\n')
    o.append(scaffold(True))
    o.append(f'<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; transform-origin: {CX}px {CY}px; transform: scaleX(-1); opacity: 0.16; pointer-events: none">\n')
    o.append(ura_text())
    o.append("</div>\n")
    for cls in ("gather", "gather d2", "gather d3"):
        o.append(f'<span class="{cls}" style="position: absolute; left: {CX - SEAM}px; top: {CY - SEAM}px; width: {2 * SEAM}px; height: {2 * SEAM}px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid rgba(236,236,234,0.5); pointer-events: none"></span>\n')
    o.append(rim(True))
    for name, r in [("妄想", 340), ("問い", 275), ("決定", 210), ("試作", 145), ("実地", 85), ("段階不明", RU)]:
        o.append(arc(name, STAGE_RAY, r, 13, "#7A7D83", 400) + "\n")
    o.append(f'<div onWheel="{{{{onWheel}}}}" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px">\n')
    o.append(
        f'<svg width="{W}" height="1470" viewBox="0 0 {W} 1470" aria-hidden="true" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px; pointer-events: none">'
        '<path d="{{shapeD}}" fill="rgba(236,236,234,0.045)" stroke="rgba(236,236,234,0.30)" stroke-width="1.5" stroke-linejoin="round"></path></svg>\n'
    )
    o.append('<sc-for list="{{gsegs}}" as="gs" hint-placeholder-count="9">' + seg_tpl % (("gs",) * 6) + "</sc-for>\n")
    o.append('<sc-for list="{{ghosts}}" as="gh" hint-placeholder-count="9"><span style="position: absolute; left: 0px; top: 0px; width: 14px; height: 14px; box-sizing: border-box; border-radius: 7px; border: 1.5px dashed {{gh.col}}; opacity: {{gh.op}}; transform: translate({{gh.x}}px, {{gh.y}}px) translate(-50%, -50%); pointer-events: none"></span></sc-for>\n')
    o.append('<sc-for list="{{segs}}" as="g" hint-placeholder-count="2">' + seg_tpl % (("g",) * 6) + "</sc-for>\n")
    o.append('<sc-for list="{{trails}}" as="tr" hint-placeholder-count="2"><span style="position: absolute; left: 0px; top: 0px; width: 9px; height: 9px; box-sizing: border-box; border-radius: 5px; border: 1.5px solid {{tr.col}}; transform: translate({{tr.x}}px, {{tr.y}}px) translate(-50%, -50%)"></span></sc-for>\n')
    o.append('<sc-for list="{{tips}}" as="t" hint-placeholder-count="24"><span class="{{t.cls}}" style="position: absolute; left: 0px; top: 0px; width: 8px; height: 8px; border-radius: 4px; background: {{t.bg}}; opacity: {{t.op}}; transform: translate({{t.x}}px, {{t.y}}px) translate(-50%, -50%)"></span></sc-for>\n')
    o.append('<sc-for list="{{chars}}" as="ch" hint-placeholder-count="180"><span style="position: absolute; left: 0px; top: 0px; font-size: {{ch.fs}}px; line-height: 1; font-weight: {{ch.fw}}; color: {{ch.col}}; opacity: {{ch.op}}; text-shadow: {{ch.glow}}; white-space: pre; transform: translate({{ch.x}}px, {{ch.y}}px) translate(-50%, -50%)">{{ch.c}}</span></sc-for>\n')
    o.append("</div>\n")
    o.append(
        f'<button type="button" onClick="{{{{toUra}}}}" aria-label="本番の夜を抜けて裏へ" style="position: absolute; left: {CX - 34}px; top: {CY - 34}px; width: 68px; height: 68px; box-sizing: border-box; border-radius: 34px; border: 1px solid #55585F; background: #101114; color: #ECECEA; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; padding: 0px; font-family: inherit">'
        '<span style="font-size: 14px; line-height: 16px; font-weight: 900">本番</span><span style="font-size: 10px; line-height: 12px; color: #A3A3A0">抜けて裏へ</span></button>\n'
    )
    o.append("</div>\n")

    # ===== 裏 =====
    o.append('<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; transform: rotateY(180deg); backface-visibility: hidden; -webkit-backface-visibility: hidden; background: #0C0D0F; pointer-events: {{uraPE}}">\n')
    o.append(scaffold(False))
    o.append(f'<div style="position: absolute; left: 0px; top: 0px; width: 1720px; height: 1470px; transform-origin: {CX}px {CY}px; transform: scaleX(-1); opacity: 0.13; pointer-events: none">\n')
    o.append('<sc-for list="{{chars}}" as="ch" hint-placeholder-count="180"><span style="position: absolute; left: 0px; top: 0px; font-size: {{ch.fs}}px; line-height: 1; font-weight: {{ch.fw}}; color: {{ch.col}}; white-space: pre; transform: translate({{ch.x}}px, {{ch.y}}px) translate(-50%, -50%)">{{ch.c}}</span></sc-for>\n')
    o.append("</div>\n")
    for cls in ("spread", "spread d2", "spread d3"):
        o.append(f'<span class="{cls}" style="position: absolute; left: {CX - SEAM}px; top: {CY - SEAM}px; width: {2 * SEAM}px; height: {2 * SEAM}px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid rgba(236,236,234,0.6); pointer-events: none"></span>\n')
    o.append(rim(False))
    o.append(arc("いた人 ─ のべ150人・約10回", RLA, RR["ita"], 15, "#A3A3A0", 700) + "\n")
    for name, key in [("イータ", "eta"), ("SFC", "sfc"), ("世界", "world")]:
        o.append(arc(name, RLA, RR[key], 15, "#A3A3A0", 700) + "\n")
    o.append(ura_text())
    o.append(arc("ここまで届いたものが、縁を越えて表で次の回の妄想になる →", -90.0, RR["world"], 18, "#ECECEA", 700) + "\n")
    o.append(
        f'<button type="button" onClick="{{{{toOmote}}}}" aria-label="表に戻る" style="position: absolute; left: {CX - 34}px; top: {CY - 34}px; width: 68px; height: 68px; box-sizing: border-box; border-radius: 34px; border: 1px solid #ECECEA; background: #ECECEA; color: #101114; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; padding: 0px; font-family: inherit">'
        '<span style="font-size: 13px; line-height: 15px; font-weight: 900">本番の夜</span><span style="font-size: 10px; line-height: 12px">表へ戻る</span></button>\n'
    )
    o.append("</div>\n")
    o.append("</div>\n</div>\n")

    # ===== overlay =====
    o.append(
        '<sc-if value="{{isOmote}}" hint-placeholder-val="{{ true }}">'
        '<div style="position: absolute; left: 64px; top: 44px; display: flex; flex-direction: column; gap: 4px; pointer-events: none"><span style="font-size: 40px; line-height: 48px; font-weight: 900; letter-spacing: 0.02em">夜の時計</span><span style="font-size: 18px; line-height: 24px; font-weight: 700; color: #A3A3A0">表 ─ その時間帯のために準備しているもの（11/06）</span></div>'
        '<div style="position: absolute; left: 64px; top: 150px; width: 400px; display: flex; flex-direction: column; gap: 12px; pointer-events: none"><span style="font-size: 12px; line-height: 16px; color: #A3A3A0">角度＝当日の流れ　中心に近いほど仕上がり　中心を抜けると裏へ</span>'
        '<span style="display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 15px; line-height: 20px; font-weight: 700"><span style="color: {{kabe}}">壁突破</span><span style="color: {{hako}}">箱庭建築</span><span style="color: {{yume}}">夢・妄想・神</span><span style="color: {{gu}}">物理</span></span>'
        '<span style="display: flex; align-items: baseline; gap: 14px; color: #ECECEA"><span style="font-size: 28px; line-height: 32px; font-weight: 900">無いと開けない</span><span style="font-size: 24px; line-height: 32px; font-weight: 700">核</span><span style="font-size: 17px; line-height: 32px; font-weight: 700">支える</span></span>'
        '<span style="font-size: 15px; line-height: 20px; font-weight: 700; color: #FFFFFF; text-shadow: 0 0 10px rgba(255,255,255,0.55), 0 0 26px rgba(255,255,255,0.22)">光る＝その日に手を入れた</span>'
        '<span style="display: flex; align-items: center; gap: 8px; font-size: 15px; line-height: 20px; font-weight: 700; color: #ECECEA"><span style="flex: none; width: 14px; height: 14px; box-sizing: border-box; border-radius: 7px; border: 1.5px dashed #ECECEA"></span>点線の○＝これから行きたい段階</span>'
        '<span style="font-size: 15px; line-height: 20px; font-weight: 700; color: #ECECEA; opacity: 0.4">うっすら反転した字＝その時間帯の真裏にあるもの</span>'
        '<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">最初の回は多くても50人ほど（11/05）</span></div>'
        "</sc-if>\n"
    )
    o.append(
        '<sc-if value="{{isUra}}" hint-placeholder-val="{{ false }}">'
        '<div style="position: absolute; left: 64px; top: 44px; display: flex; flex-direction: column; gap: 4px; pointer-events: none"><span style="font-size: 40px; line-height: 48px; font-weight: 900; letter-spacing: 0.02em">夜の時計の裏</span><span style="font-size: 18px; line-height: 24px; font-weight: 700; color: #A3A3A0">裏 ─ その時間帯が残していくもの</span></div>'
        '<div style="position: absolute; left: 64px; top: 150px; width: 400px; display: flex; flex-direction: column; gap: 10px; pointer-events: none">'
        '<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">角度＝表と同じ時間帯（裏から見るので逆回り）　中心から外へ＝届いた範囲：いた人 → イータ → SFC → 世界</span>'
        '<span style="font-size: 17px; line-height: 22px; font-weight: 900; color: #ECECEA">濃い字＝これまでの夜でもう残っている</span>'
        '<span style="font-size: 17px; line-height: 22px; font-weight: 700; color: #ECECEA; opacity: 0.55">薄い字＝今回つくるつもり</span>'
        '<span style="font-size: 17px; line-height: 22px; font-weight: 700; color: #6E7177">灰色＝まだ空いている</span>'
        '<span style="font-size: 15px; line-height: 20px; font-weight: 700; color: #ECECEA; opacity: 0.4">うっすら反転した字＝表で準備しているもの</span>'
        '<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">中心（本番の夜）と縁（世界＝次の妄想）は、表と裏の縫い目</span></div>'
        "</sc-if>\n"
    )
    tb = "min-width: 72px; height: 44px; padding: 0px 14px; box-sizing: border-box; background: #101114; border-radius: 22px; font-size: 15px; font-weight: 900; cursor: pointer; font-family: inherit"
    o.append(
        '<div style="position: absolute; left: 1468px; top: 48px; display: flex; gap: 8px">'
        f'<button type="button" onClick="{{{{toOmote}}}}" style="{tb}; color: {{{{omoteBtn}}}}; border: 1px solid {{{{omoteBd}}}}">表</button>'
        f'<button type="button" onClick="{{{{toUra}}}}" style="{tb}; color: {{{{uraBtn}}}}; border: 1px solid {{{{uraBd}}}}">裏</button>'
        "</div>\n"
    )
    # これから（いつも見える）
    o.append(
        '<div style="position: absolute; left: 1366px; top: 112px; width: 300px; display: flex; flex-direction: column; gap: 6px; pointer-events: none">'
        '<span style="font-size: 16px; line-height: 20px; font-weight: 900; color: #ECECEA">これから</span>'
        '<span style="font-size: 11px; line-height: 14px; color: #A3A3A0">会話から拾ったやりたいこと。日付と順番は未定</span>'
        '<sc-for list="{{plans}}" as="pl" hint-placeholder-count="9">'
        '<span style="font-size: 12px; line-height: 16px; color: #C9C9C5"><b style="color: {{pl.col}}">{{pl.n}}</b>　{{pl.p}}</span>'
        "</sc-for></div>\n"
    )
    o.append(band_html())
    o.append("</div>\n")

    props = {k: {"editor": "color", "default": DEF[k], "section": "4軸の色"} for k in ["kabe", "hako", "yume", "gu"]}
    props["motion"] = {"editor": "enum", "options": ["当日だけ動く", "日付の間を直線で"], "default": "当日だけ動く", "section": "時間"}
    props["$preview"] = {"width": W, "height": H}
    pj = json.dumps(props, ensure_ascii=False)
    assert "'" not in pj
    js = JS.replace("__DATA__", json.dumps(js_data(), ensure_ascii=False))
    o.append(f"""</x-dc>
<script type="text/x-dc" data-dc-script data-props='{pj}'>
{js}
</script>
</body>
</html>
""")
    html = "".join(o)
    with open(os.path.join(PROJ, "NightClock.dc.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    print("NightClock.dc.html", len(html))


if __name__ == "__main__":
    probs = check()
    print("sectors:", {s: (round(a), round(b)) for s, (a, b) in SEC.items()})
    print("stage ray:", round(STAGE_RAY, 1))
    print("problems:", len(probs))
    for p in probs:
        print("  ", p)
    if "--build" in sys.argv:
        build()
