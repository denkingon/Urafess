#!/usr/bin/env python3
"""B' 夜の時計 と V のぼり ─ 合流を入れた版（11/06 夜）。data.py の一つの表から両方を作る。

合流：途中で大きい流れに加わった件は、合流先の字（旗）の脇へ移って小さくなり、
そのあとは合流先と一緒に動く。字の大きさ＝その行為のインパクト、という読みに合わせる。
  B'：合流先の字と同じ向きに並んで走る小さい列になる。来た道を薄い線で残す
  V ：合流先の竿まで歩いていき、旗の下に小さい旗として下がる
"""
import importlib.util
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import data as D  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


g7 = load("g7", os.path.join(HERE, "gen7.py"))
g3 = g7.g3
PROJ = g7.PROJ
IDX = {it["k"]: i for i, it in enumerate(D.ITEMS)}


def relayout():
    """時間帯の幅と、その中の件の幅。
    内側（仕上がった段階）ほど同じ字幅でも角度を食うので広く取り、合流先には脇の字の分を足す。
    合流して出ていった件の元の場所は細くする（合流の前にしか使わない）"""
    nsat = {}
    for it in D.ITEMS:
        if "merge" in it:
            nsat[it["merge"][0]] = nsat.get(it["merge"][0], 0) + 1
    STW = {None: 0.75, "u": 0.8, 0: 0.75, 1: 0.85, 2: 1.0, 3: 1.8, 4: 2.3, 5: 2.0}
    TW_ = {0: 1.15, 1: 1.0, 2: 0.8}

    def iw(it):
        if "merge" in it:
            return 0.5
        inner = max(STW[it["s"][-2]], STW[it["s"][-1]])
        return inner * TW_[it["t"]] + 0.62 * nsat.get(it["k"], 0)

    w = {s: 1.8 + sum(iw(it) for it in D.ITEMS if it["sec"] == s) for s in D.SECTORS}
    LEAD = {"最後の発表": 0.55}  # 段階の名前（妄想・問い…）を書く光線のための空き
    for k_, v_ in LEAD.items():
        w[k_] += v_
    tot = sum(w.values())
    a, sec, ang = -90.0, {}, {}
    ray = 0.0
    for s in D.SECTORS:
        span = 360.0 * w[s] / tot
        sec[s] = (a, a + span)
        ids = [it for it in D.ITEMS if it["sec"] == s]
        tw = sum(iw(it) for it in ids)
        pad = span * 0.45 / w[s]
        lead = span * LEAD.get(s, 0) / w[s]
        if s == "最後の発表":
            ray = a + lead * 0.5
        b = a + pad + lead
        for it in ids:
            d = (span - 2 * pad - lead) * iw(it) / tw
            ang[it["k"]] = b + d / 2
            b += d
        a += span
    g7.SEC, g7.ANG, g7.STAGE_RAY = sec, ang, ray  # 段階の名前は最後の発表の側へ少し寄せる（直前の件の字とぶつけない）
    g7.RLA = -40.0  # 裏の輪の名前を少し前へ寄せ、イータへ・アイスの裏を空ける


relayout()
STAGE = ["妄想", "問い", "決定", "試作", "実地", "本番"]


# ---------- 合流（統一させる層の一部：表の merge から両方のボードの並びを決める） ----------
def merges():
    out, byp = {}, {}
    n_ev = len(D.EVENTS)
    for i, it in enumerate(D.ITEMS):
        if "merge" not in it:
            continue
        pk, at = it["merge"]
        assert pk in IDX, pk
        par = D.ITEMS[IDX[pk]]
        assert "merge" not in par, "合流先がさらに合流するのは未対応"
        b = next(k for k, s in enumerate(it["s"]) if s is not None)
        assert b <= at, (it["k"], "生まれる前に合流している")
        assert par["s"][at] is not None, (it["k"], "合流先がまだ無い")
        assert all(it["s"][k] == it["s"][at] for k in range(at, n_ev)), (it["k"], "合流したあとに自分だけ段階が動いている")
        byp.setdefault(pk, []).append((at, i))
    for pk, lst in byp.items():
        lst.sort()
        pa = g7.ANG[pk]
        cnt = {1: 0, -1: 0}
        for k, (at, i) in enumerate(lst):
            # 来た側に付く（角度が大きい側＝+1）
            sd = 1 if math.sin(math.radians(g7.ANG[D.ITEMS[i]["k"]] - pa)) >= 0 else -1
            out[i] = {"into": IDX[pk], "at": at, "side": sd, "slot": cnt[sd], "k": k}
            cnt[sd] += 1
    return out


M = merges()

# ---------- 両方のボードで同じ時間の決まり ----------
TIME_JS = r"""
    var lin = (this.props.motion ?? '当日だけ動く') === '日付の間を直線で';
    // これから（日付未定）は、今日から先の帯いっぱいに一直線で動く
    var startOf = function (k) { return (lin || E[k].future) && k > 0 ? E[k - 1].day : E[k].day - 1; };
    var prog = function (k) { return cl((t - startOf(k)) / (E[k].day - startOf(k))); };
    // 合流する日に自分の動き（生まれる・段階が変わる）もあれば、その日の前6割で動いて、後ろ4割で合流する
    var split = function (it, k) { return !!it.m && it.m.at === k && (k === 0 || it.s[k] !== it.s[k - 1]); };
    var progOwn = function (it, k) { return split(it, k) ? cl(prog(k) / 0.6) : prog(k); };
    var progMerge = function (it) { if (!it.m) return 0; var p = prog(it.m.at); return split(it, it.m.at) ? cl((p - 0.6) / 0.4) : p; };
"""

# 日付・直近の動き・時間の帯・これから（ラベルだけボードごと）
LOG_JS = r"""
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
    var born = [], moved = [], joined = [], touched = [];
    IT.forEach(function (it) {
      var s = it.s[k0], before = k0 > 0 ? it.s[k0 - 1] : null;
      var al = s !== null && s !== undefined, was = before !== null && before !== undefined;
      var mj = !!it.m && it.m.at === k0;
      if (mj) joined.push(it.n + '→' + IT[it.m.into].n);
      if (al && !was) born.push(it.n);
      else if (al && was && s !== before && s !== 'u') moved.push(it.n + ' ' + D.stageName[before] + '→' + D.stageName[s]);
      else if (!mj && it.now.indexOf(k0) >= 0) touched.push(it.n);
    });
    var log = [];
    if (born.length) log.push({ k: '__BORN__', v: born.join('、') });
    if (moved.length) log.push({ k: fut ? '__MOVED_F__' : '__MOVED__', v: moved.join('、') });
    if (joined.length) log.push({ k: fut ? '合流させたい' : '大きい流れに合流した', v: joined.join('、') });
    if (touched.length) log.push({ k: fut ? '手を入れたい' : '手を入れた', v: touched.join('、') });
    // 時間の帯：日数はそのまま一直線。日の数字と月、今日、これから
    var TW = 780, PAD = 9, X = function (d) { return PAD + (TW - 2 * PAD) * d / END; };
    var ticks = E.map(function (ev, k) {
      var cnt = 0;
      IT.forEach(function (it) { if (it.now.indexOf(k) >= 0) cnt++; });
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
    // これから：合流したものは合流先の下に並べる。合流先ごとのまとまりを崩さずに3列へ分ける
    var kids = {};
    IT.forEach(function (it) { if (it.m && it.plan) (kids[it.m.into] = kids[it.m.into] || []).push(it); });
    var groups = [];
    IT.forEach(function (it, i) {
      if (it.m) return;
      var ks = kids[i] || [];
      if (!it.plan && !ks.length) return;
      var gr = [{ n: it.n, p: it.plan || '', col: col[it.x], pad: 0, fs: 13 }];
      ks.forEach(function (c) { gr.push({ n: '└ ' + c.n, p: c.plan, col: col[c.x], pad: 16, fs: 12 }); });
      groups.push(gr);
    });
    var hOf = function (e) { return Math.ceil(Array.from(e.n + '　' + e.p).length * e.fs / (490 - e.pad)) * 19 + 8; };
    var totH = 0;
    groups.forEach(function (gr) { gr.h = gr.reduce(function (a, e) { return a + hOf(e); }, 0); totH += gr.h; });
    var cols3 = [[], [], []], ci = 0, accH = 0;
    groups.forEach(function (gr) {
      if (ci < 2 && accH > 0 && accH + gr.h / 2 > totH / 3 * (ci + 1)) ci++;
      gr.forEach(function (e) { cols3[ci].push(e); });
      accH += gr.h;
    });
    var plans = cols3[0].concat(cols3[1], cols3[2]);
"""

CONTROLS_JS = r"""
      tStr: t.toFixed(2), end: END, dateStr: dateStr, dateFs: inFuture ? 64 : 96, caption: caption,
      log: log, ticks: ticks, days: days, plans: plans, plansA: cols3[0], plansB: cols3[1], plansC: cols3[2],
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
      onWheel: function (ev) { self.stop(); self.setT(t + (ev.deltaY || 0) / 80); }"""

HEAD_JS = r"""class Component extends DCLogic {
  componentWillUnmount() { this.stop(); }
  stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
  data() { return __DATA__; }
  clamp01(x) { return x <= 0 ? 0 : (x >= 1 ? 1 : x); }
  setT(t) { var E = this.data().end; this.setState({ t: Math.max(0, Math.min(E, t)) }); }
"""

COLORS_JS = r"""
    var col = {
      kabe: this.props.kabe ?? '#FF8A3D', hako: this.props.hako ?? '#3FD0A0',
      yume: this.props.yume ?? '#A98BFF', gu: this.props.gu ?? '#F2D74B', none: '#A6A8AD'
    };
    var cl = this.clamp01;
"""

# ===================== B' =====================
B_JS = HEAD_JS + r"""  // 字を中心からの光線に沿って並べる（読む向きにそろえる）。返す並びは語の中の字の順
  needle(word, angDeg, r0, fs) {
    var a = angDeg * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
    var chars = Array.from(word), L = chars.length;
    var fwd = Math.abs(ux) > Math.abs(uy) ? ux > 0 : uy > 0;
    var out = new Array(L), acc = r0 + 4;
    for (var q = 0; q < L; q++) {
      var i = fwd ? q : L - 1 - q, c = chars[i], w = fs, h = fs;
      if (c === ' ') { w = 0.35 * fs; h = 0.35 * fs; } else if (c.charCodeAt(0) < 128) { w = 0.62 * fs; h = 0.8 * fs; }
      var cand = [];
      if (Math.abs(ux) > 1e-6) cand.push(w / Math.abs(ux));
      if (Math.abs(uy) > 1e-6) cand.push(h / Math.abs(uy));
      var s = Math.min.apply(null, cand) + 0.06 * fs;
      var d = acc + s / 2;
      out[i] = { c: c, x: ux * d, y: uy * d };
      acc += s;
    }
    return out;
  }
  renderVals() {
    var self = this;
    var D = this.data();
    var E = D.events, END = D.end, TODAY = D.today, NE = E.length, IT = D.items;
    var st = this.state || {};
    var t = typeof st.t === 'number' ? st.t : TODAY;
    var playing = !!this._raf;
    var side = st.side === 'ura' ? 'ura' : 'omote';
""" + COLORS_JS + r"""
    var CX = 840, CY = 780, RING = [340, 275, 210, 145, 85, 30], RU = 380, OUT = RU + 110, FS = [28, 24, 17], FSAT = 13;
    var rOf = function (s) { return s === 'u' ? RU : RING[s]; };
    var pt = function (a, r) { var q = a * Math.PI / 180; return [CX + Math.cos(q) * r, CY + Math.sin(q) * r]; };
""" + TIME_JS + r"""
    var lineOf = function (p0, p1, c, op) {
      var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      return { x: p0[0].toFixed(1), y: p0[1].toFixed(1), len: Math.sqrt(dx * dx + dy * dy).toFixed(1), rot: (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2), col: c, op: op.toFixed(2) };
    };
    var segOf = function (a, r0, r1, c, op) { return lineOf(pt(a, r0), pt(a, r1), c, op); };
    var glowOf = function (g) { return g > 0.02 ? '0 0 10px rgba(255,255,255,' + (0.55 * g).toFixed(2) + '), 0 0 26px rgba(255,255,255,' + (0.22 * g).toFixed(2) + ')' : 'none'; };
    // 1周目：それぞれ自分だけの動き
    var S = IT.map(function (it) {
      var b = -1;
      for (var k = 0; k < NE; k++) { if (it.s[k] !== null && it.s[k] !== undefined) { b = k; break; } }
      var o = { a: it.a, alive: 0, r: OUT, unknown: false, c: col[it.x], g: 0, trails: [], segs: [] };
      if (b >= 0) {
        o.unknown = it.s[b] === 'u';
        o.alive = progOwn(it, b);
        o.r = OUT + (rOf(it.s[b]) - OUT) * o.alive;
        if (o.alive >= 1) {
          for (var k2 = b + 1; k2 < NE; k2++) {
            if (it.m && k2 > it.m.at) break;
            var sp = it.s[k2 - 1], sk = it.s[k2];
            if (sk === sp || sk === 'u' || sp === 'u') continue;
            var f = progOwn(it, k2);
            if (f <= 0) break;
            var rp = rOf(sp), rn = rp + (rOf(sk) - rp) * f;
            o.trails.push(pt(it.a, rp));
            o.segs.push(segOf(it.a, rp, rn, o.c, E[k2].future ? 0.55 : 0.7));
            o.r = rn;
            if (f < 1) break;
          }
        }
      }
      it.now.forEach(function (k) {
        var dd = E[k].day, v;
        if (E[k].future) v = 0.85 * prog(k);
        else v = t <= dd ? cl(t - (dd - 1)) : 1 - cl((t - dd) / 3);
        if (v > o.g) o.g = v;
      });
      o.fs = FS[it.t];
      o.op = o.alive * (o.unknown ? 0.45 : 0.55 + 0.45 * o.g);
      return o;
    });
    // 合流先の字の脇：同じ向きに並んで走る列。どちら側の何列目かは表で決めてある（来た側に付く）
    var ext = function (fs, a) { var q = a * Math.PI / 180; return fs * (Math.abs(Math.cos(q)) + Math.abs(Math.sin(q))) / 2; };
    var beside = function (m, P) {
      var d = ext(P.fs, P.a) + 5 + ext(FSAT, P.a) + m.slot * (2 * ext(FSAT, P.a) + 3), q = P.a * Math.PI / 180;
      return [-Math.sin(q) * m.side * d, Math.cos(q) * m.side * d];
    };
    // 2周目：合流したものは合流先について動く
    var chars = [], tips = [], trails = [], segs = [], ghosts = [], gsegs = [], tribs = [];
    IT.forEach(function (it, i) {
      var o = S[i], f = progMerge(it), P = it.m ? S[it.m.into] : null, keep = 1 - f;
      var fw = it.t === 0 ? 900 : 700, gl = glowOf(o.g);
      o.trails.forEach(function (p) { trails.push({ x: p[0].toFixed(1), y: p[1].toFixed(1), col: o.c, op: keep.toFixed(2) }); });
      o.segs.forEach(function (sg) { sg.op = (parseFloat(sg.op) * keep).toFixed(2); segs.push(sg); });
      var own = self.needle(it.n, it.a, o.r, o.fs), tipOwn = pt(it.a, o.r);
      if (P && f > 0) {
        var nv = beside(it.m, P), sat = self.needle(it.n, P.a, P.r, FSAT);
        var fsx = o.fs + (FSAT - o.fs) * f;
        var opS = P.alive * (P.unknown ? 0.42 : 0.5 + 0.45 * o.g);
        var op = o.op + (opS - o.op) * f;
        own.forEach(function (p, j) {
          var s = sat[j];
          chars.push({ c: p.c, w: i, x: (CX + p.x + (s.x + nv[0] - p.x) * f).toFixed(1), y: (CY + p.y + (s.y + nv[1] - p.y) * f).toFixed(1), fs: fsx.toFixed(1), col: o.c, op: op.toFixed(3), glow: gl, fw: fw });
        });
        // 来た道：動いている間だけ、元の場所から合流先の脇の付け根まで薄く引く（合流し終えたら消える）
        var pa = pt(P.a, P.r), anc = [pa[0] + nv[0], pa[1] + nv[1]], trOp = 0.5 * Math.sin(Math.PI * f) * o.alive;
        if (trOp > 0.01) tribs.push(lineOf(tipOwn, [tipOwn[0] + (anc[0] - tipOwn[0]) * f, tipOwn[1] + (anc[1] - tipOwn[1]) * f], o.c, trOp));
      } else {
        own.forEach(function (p) {
          chars.push({ c: p.c, w: i, x: (CX + p.x).toFixed(1), y: (CY + p.y).toFixed(1), fs: o.fs, col: o.c, op: o.op.toFixed(3), glow: gl, fw: fw });
        });
      }
      tips.push({ x: tipOwn[0].toFixed(1), y: tipOwn[1].toFixed(1), bg: o.g >= 0.5 ? '#FFFFFF' : o.c, op: (o.alive * (o.unknown ? 0.45 : 1) * keep).toFixed(3), cls: o.g >= 0.5 && keep > 0.5 ? 'now-ring' : '' });
      // 次に行きたい所を点線の○で（これから合流するものは、合流先の脇に）
      if (o.alive >= 1 && t > TODAY - 1 && t < E[NE - 1].day) {
        var fade = Math.min(cl(t - (TODAY - 1)), 1 - prog(NE - 1));
        if (it.m && E[it.m.at].future) {
          var rP = rOf(IT[it.m.into].s[NE - 1]), nv2 = beside(it.m, P), pp = pt(P.a, rP), gq = [pp[0] + nv2[0], pp[1] + nv2[1]];
          ghosts.push({ x: gq[0].toFixed(1), y: gq[1].toFixed(1), col: o.c, op: (0.95 * fade).toFixed(2) });
          gsegs.push(lineOf(tipOwn, gq, o.c, 0.45 * fade));
        } else if (!it.m) {
          var sNow = it.s[NE - 2], sPlan = it.s[NE - 1];
          if (sNow !== null && sNow !== undefined && sNow !== 'u' && sPlan !== sNow) {
            var gp = pt(it.a, rOf(sPlan));
            ghosts.push({ x: gp[0].toFixed(1), y: gp[1].toFixed(1), col: o.c, op: (0.95 * fade).toFixed(2) });
            gsegs.push(segOf(it.a, o.r, rOf(sPlan), o.c, 0.45 * fade));
          }
        }
      }
    });
    // 外形（いまの先端を結ぶ線）：合流したものの頂点は、両どなりを結ぶ線の上へ平らにならす
    var vr = S.map(function (o) { return Math.min(o.alive > 0 ? o.r : RU, RU); });
    var base = [];
    IT.forEach(function (it, i) { if (!it.m) base.push({ a: it.a, r: vr[i] }); });
    base.sort(function (p, q) { return p.a - q.a; });
    var between = function (a) {
      var n = base.length;
      for (var j = 0; j < n; j++) {
        var p = base[j], q = base[(j + 1) % n], qa = q.a + (j + 1 === n ? 360 : 0), aa = a < p.a ? a + 360 : a;
        if (aa >= p.a && aa <= qa) return p.r + (q.r - p.r) * (aa - p.a) / (qa - p.a);
      }
      return RU;
    };
    var verts = IT.map(function (it, i) {
      var r = vr[i];
      if (it.m) r += (between(it.a) - r) * progMerge(it);
      return { a: it.a, r: r };
    });
    verts.sort(function (p, q) { return p.a - q.a; });
    var PP = verts.map(function (v) { return pt(v.a, v.r); });
    var n = PP.length, f2 = function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); };
    var shapeD = 'M ' + f2(PP[0]);
    for (var i2 = 0; i2 < n; i2++) {
      var a0 = PP[(i2 - 1 + n) % n], a1 = PP[i2], a2 = PP[(i2 + 1) % n], a3 = PP[(i2 + 2) % n];
      shapeD += ' C ' + f2([a1[0] + (a2[0] - a0[0]) / 6, a1[1] + (a2[1] - a0[1]) / 6]) + ' ' + f2([a2[0] - (a3[0] - a1[0]) / 6, a2[1] - (a3[1] - a1[1]) / 6]) + ' ' + f2(a2);
    }
    shapeD += ' Z';
""" + LOG_JS.replace("__BORN__", "生まれた").replace("__MOVED_F__", "進めたい").replace("__MOVED__", "進んだ") + r"""
    return {
      kabe: col.kabe, hako: col.hako, yume: col.yume, gu: col.gu,
      flipDeg: side === 'ura' ? 180 : 0, omotePE: side === 'ura' ? 'none' : 'auto', uraPE: side === 'ura' ? 'auto' : 'none',
      isOmote: side !== 'ura', isUra: side === 'ura',
      omoteBtn: side !== 'ura' ? '#ECECEA' : '#8E8E8A', uraBtn: side === 'ura' ? '#ECECEA' : '#8E8E8A',
      omoteBd: side !== 'ura' ? '#ECECEA' : '#34373E', uraBd: side === 'ura' ? '#ECECEA' : '#34373E',
      toUra: function () { self.setState({ side: 'ura' }); },
      toOmote: function () { self.setState({ side: 'omote' }); },
      chars: chars, tips: tips, trails: trails, segs: segs, shapeD: shapeD, ghosts: ghosts, gsegs: gsegs, tribs: tribs,
      logHead: fut ? 'これからやりたいこと（段階が動くもの）' : E[k0].d + ' の動き',""" + CONTROLS_JS + r"""
    };
  }
}"""


def b_data():
    items = []
    for i, it in enumerate(D.ITEMS):
        d = {"n": it["n"], "a": round(g7.ANG[it["k"]], 2), "t": it["t"], "x": it["x"], "s": it["s"], "now": it["now"], "plan": it.get("plan")}
        if i in M:
            d["m"] = M[i]
        items.append(d)
    return {"end": D.END, "today": D.TODAY, "events": D.EVENTS, "stageName": STAGE, "items": items}


TRIB_LAYER = ('<sc-for list="{{tribs}}" as="tb" hint-placeholder-count="5"><span style="position: absolute; left: 0px; top: 0px; width: {{tb.len}}px; height: 0px; '
              'border-top: 1px solid {{tb.col}}; opacity: {{tb.op}}; transform-origin: 0 0; transform: translate({{tb.x}}px, {{tb.y}}px) rotate({{tb.rot}}deg); pointer-events: none"></span></sc-for>\n')
PLAN_OLD = '<span style="font-size: 12px; line-height: 16px; color: #C9C9C5"><b style="color: {{pl.col}}">{{pl.n}}</b>　{{pl.p}}</span>'
PLAN_NEW = '<span style="padding-left: {{pl.pad}}px; font-size: {{pl.fs}}px; line-height: 16px; color: #C9C9C5"><b style="color: {{pl.col}}">{{pl.n}}</b>　{{pl.p}}</span>'
def plans_footer(top):
    col = lambda k: ('<div style="flex: 1 1 0px; display: flex; flex-direction: column; gap: 8px">'
                     f'<sc-for list="{{{{plans{k}}}}}" as="pl" hint-placeholder-count="6"><span style="padding-left: {{{{pl.pad}}}}px; font-size: {{{{pl.fs}}}}px; line-height: 19px; color: #C9C9C5">'
                     '<b style="color: {{pl.col}}">{{pl.n}}</b>　{{pl.p}}</span></sc-for></div>')
    return (f'<div data-part="plans" style="position: absolute; left: 64px; top: {top}px; width: 1592px; pointer-events: none">'
            '<div style="display: flex; align-items: baseline; gap: 14px; border-top: 1px solid #2A2C31; padding-top: 14px; margin-bottom: 14px">'
            '<span style="font-size: 20px; line-height: 24px; font-weight: 900; color: #ECECEA">これから</span>'
            '<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">会話から拾ったやりたいこと。日付と順番は未定。└ ＝合流したもの（合流先の下に並ぶ）</span></div>'
            '<div style="display: flex; gap: 40px; align-items: flex-start">' + col("A") + col("B") + col("C") + '</div>'
            '<span data-part="plans-end" style="display: none"></span></div>')


PLANS_RE = re.compile(r'<div data-part="plans"[\s\S]*?<span data-part="plans-end" style="display: none"></span></div>')


def swap_plans(s, old_prefix, top):
    """右上の「これから」（古い形）か、前に作った下の「これから」を、いまの形に入れ替える"""
    if PLANS_RE.search(s):
        return PLANS_RE.sub(lambda _m: plans_footer(top), s, count=1)
    i = s.index(old_prefix)
    j = s.index("</sc-for></div>", i) + len("</sc-for></div>")
    return s[:i] + plans_footer(top) + s[j:]


B_LEGEND = ('<span style="display: flex; flex-direction: column; gap: 1px; color: #ECECEA">'
            '<span style="font-size: 17px; line-height: 20px; font-weight: 700">大きい流れ</span>'
            '<span style="font-size: 12px; line-height: 15px; font-weight: 700; opacity: 0.7">合流したもの＝もう単独では動かない</span></span>')


B_H, V_H = 2160, 2130  # 11/04・11/06 の動きの一覧と、下の「これから」が切れない高さ
B_FT, V_FT = 1800, 1770  # 下の「これから」の上端


def build_b():
    g7.H = B_H
    g7.JS = B_JS
    g7.js_data = b_data
    g7.build()  # 枠・裏・帯は前と同じものを作る
    p = os.path.join(PROJ, "NightClock.dc.html")
    s = open(p, encoding="utf-8").read()
    rep = [
        ("border: 1.5px solid {{tr.col}}; transform:", "border: 1.5px solid {{tr.col}}; opacity: {{tr.op}}; transform:"),
        ('<sc-for list="{{trails}}"', TRIB_LAYER + '<sc-for list="{{trails}}"'),
        (PLAN_OLD, PLAN_NEW),
        ("点線の○＝これから行きたい段階</span>", "点線の○＝これから行きたい段階</span>" + B_LEGEND),
        ("準備しているもの（11/06）", "準備しているもの（" + [e for e in D.EVENTS if not e.get("future")][-1]["d"] + "）"),
    ]
    for a, b in rep:
        assert s.count(a) == 1, a[:60]
        s = s.replace(a, b)
    s = swap_plans(s, '<div style="position: absolute; left: 1366px; top: 112px; width: 300px;', B_FT)
    open(p, "w", encoding="utf-8").write(s)
    print("NightClock.dc.html", len(s))


# ===================== V =====================
V_JS = HEAD_JS + r"""  renderVals() {
    var self = this;
    var D = this.data();
    var E = D.events, END = D.end, TODAY = D.today, NE = E.length, IT = D.items;
    var st = this.state || {};
    var t = typeof st.t === 'number' ? st.t : TODAY;
    var rot = typeof st.rot === 'number' ? st.rot : 332;
    var dim = typeof st.dim === 'number' ? st.dim : 70;
    var playing = !!this._raf;
""" + COLORS_JS + TIME_JS + r"""
    var CX = 860, CY = 820, SC = 360;
    var phi = rot * Math.PI / 180, el = (90 - dim * 0.68) * Math.PI / 180;
    var cp = Math.cos(phi), sp = Math.sin(phi), se = Math.sin(el), ce = Math.cos(el);
    var proj = function (gx, gy, z) { var x = gx * SC, y = gy * SC; return [CX + x * cp - y * sp, CY + (x * sp + y * cp) * se - (z || 0) * ce]; };
    var vec = function (dx, dy) { return [dx * cp - dy * sp, (dx * sp + dy * cp) * se]; };
    var f = function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); };
    var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (c) { return proj(c[0], c[1], 0); });
    var borderD = 'M ' + corners.map(f).join(' L ') + ' Z';
    var gridD = '';
    [-0.5, 0.5].forEach(function (v) {
      gridD += 'M ' + f(proj(v, -1, 0)) + ' L ' + f(proj(v, 1, 0)) + ' ';
      gridD += 'M ' + f(proj(-1, v, 0)) + ' L ' + f(proj(1, v, 0)) + ' ';
    });
    var crossD = 'M ' + f(proj(-1.08, 0, 0)) + ' L ' + f(proj(1.08, 0, 0)) + ' M ' + f(proj(0, -1.08, 0)) + ' L ' + f(proj(0, 1.08, 0));
    var ground = D.poles.map(function (p) {
      var u = vec(p.ex, p.ey), dx = p.ex, dy = p.ey;
      if (u[0] < -0.02 || (Math.abs(u[0]) <= 0.02 && u[1] < 0)) { dx = -dx; dy = -dy; u = vec(dx, dy); }
      var v = vec(-dy, dx), c = proj(p.gx, p.gy, 0);
      return { big: p.big, small: p.small, col: col[p.k],
        tf: 'translate(' + c[0].toFixed(1) + 'px, ' + c[1].toFixed(1) + 'px) matrix(' + u[0].toFixed(4) + ', ' + u[1].toFixed(4) + ', ' + v[0].toFixed(4) + ', ' + v[1].toFixed(4) + ', 0, 0) translate(-50%, -50%)' };
    });
    var HB = 26, HS = 46, DROP = function (k) { return (22 + 17 * k) / ce; };
    // 1周目：それぞれ自分だけの動き
    var OS = IT.map(function (it) {
      var b = -1;
      for (var k = 0; k < NE; k++) { if (it.s[k] !== null && it.s[k] !== undefined) { b = k; break; } }
      var o = { alive: 0, sv: 0, unknown: false, c: col[it.x], g: 0, marks: [] };
      if (b >= 0) {
        o.unknown = it.s[b] === 'u';
        o.alive = progOwn(it, b);
        o.sv = o.unknown ? 0 : it.s[b];
        if (o.alive >= 1 && !o.unknown) {
          for (var k2 = b + 1; k2 < NE; k2++) {
            if (it.m && k2 > it.m.at) break;
            var s0 = it.s[k2 - 1], s1 = it.s[k2];
            if (s1 === s0) continue;
            var fr = progOwn(it, k2);
            if (fr <= 0) break;
            o.marks.push(s0);
            o.sv = s0 + (s1 - s0) * fr;
            if (fr < 1) break;
          }
        }
      }
      it.now.forEach(function (k) {
        var dd = E[k].day, v;
        if (E[k].future) v = 0.85 * prog(k);
        else v = t <= dd ? cl(t - (dd - 1)) : 1 - cl((t - dd) / 3);
        if (v > o.g) o.g = v;
      });
      o.h = o.alive * (HB + HS * o.sv);
      o.op = o.alive * (o.unknown ? 0.5 : 0.62 + 0.38 * o.g);
      return o;
    });
    // 2周目：合流したものは合流先の竿まで歩いていき、旗の下に小さい旗として下がる
    var poles = [], flags = [], dots = [], marks = [], ghosts = [];
    IT.forEach(function (it, i) {
      var o = OS[i], fm = progMerge(it), P = it.m ? OS[it.m.into] : null, Pi = it.m ? IT[it.m.into] : null, keep = 1 - fm;
      var gx = it.g[0], gy = it.g[1], h = o.h, fs = 20, lh = 24, fw = 900, op = o.op;
      if (P && fm > 0) {
        gx += (Pi.g[0] - gx) * fm; gy += (Pi.g[1] - gy) * fm;
        h += (P.h - DROP(it.m.k) - h) * fm;
        fs = 20 - 7 * fm; lh = 24 - 7 * fm; fw = fm >= 0.5 ? 700 : 900;
        op += (P.alive * (P.unknown ? 0.45 : 0.55 + 0.38 * o.g) - op) * fm;
      }
      var gp = proj(gx, gy, 0), tp = proj(gx, gy, h);
      var z = Math.round(gp[1]);
      o.marks.forEach(function (s0) {
        var mp = proj(gx, gy, HB + HS * s0);
        marks.push({ x: mp[0].toFixed(1), y: mp[1].toFixed(1), col: o.c, op: keep.toFixed(2) });
      });
      // 次に行きたい高さ（点線の○）。これから合流するものは、合流先の竿の下がる位置に
      if (o.alive >= 1 && t > TODAY - 1 && t < E[NE - 1].day) {
        var fade = Math.min(cl(t - (TODAY - 1)), 1 - prog(NE - 1));
        if (it.m && E[it.m.at].future) {
          var sP = Pi.s[NE - 1], gq = proj(Pi.g[0], Pi.g[1], HB + HS * (sP === 'u' ? 0 : sP) - DROP(it.m.k));
          ghosts.push({ x: (gq[0] + 5).toFixed(1), y: gq[1].toFixed(1), col: o.c, op: (0.95 * fade).toFixed(2) });
        } else if (!it.m) {
          var sNow = it.s[NE - 2], sPlan = it.s[NE - 1];
          if (sNow !== null && sNow !== undefined && sNow !== 'u' && sPlan !== sNow) {
            var gq2 = proj(it.g[0], it.g[1], HB + HS * sPlan);
            ghosts.push({ x: gq2[0].toFixed(1), y: gq2[1].toFixed(1), col: o.c, op: (0.95 * fade).toFixed(2) });
          }
        }
      }
      poles.push({ x: (gp[0] - 1).toFixed(1), y: gp[1].toFixed(1), h: (Math.max(0, h) * ce).toFixed(1), col: o.g >= 0.5 ? '#FFFFFF' : o.c, op: (op * keep).toFixed(3), z: z, dash: o.unknown ? 'dashed' : 'solid' });
      dots.push({ x: gp[0].toFixed(1), y: gp[1].toFixed(1), w: 10, hh: Math.max(2, 10 * se).toFixed(1), col: o.c, op: (o.alive * 0.9 * keep).toFixed(3) });
      flags.push({
        n: o.unknown ? it.n + '（段階不明）' : it.n, w: i, x: (tp[0] + 5).toFixed(1), y: tp[1].toFixed(1), col: o.c, op: op.toFixed(3), z: z + 1,
        fs: fs.toFixed(1), lh: lh.toFixed(1), fw: fw,
        glow: o.g > 0.02 ? '0 0 10px rgba(255,255,255,' + (0.6 * o.g).toFixed(2) + '), 0 0 24px rgba(255,255,255,' + (0.25 * o.g).toFixed(2) + '), 0 0 3px #101114' : '0 0 3px #101114, 0 0 8px #101114',
        cls: o.g >= 0.5 ? 'now-ring' : ''
      });
    });
    var rp = proj(-1.12, 1.12, 0);
    var ruler = D.stageName.map(function (nm, k) { var p = proj(-1.12, 1.12, HB + HS * k); return { n: nm, x: p[0].toFixed(1), y: p[1].toFixed(1) }; });
    var rulerH = ((HB + HS * 5) * ce).toFixed(1);
""" + LOG_JS.replace("__BORN__", "旗が立った").replace("__MOVED_F__", "上げたい").replace("__MOVED__", "旗が上がった") + r"""
    return {
      kabe: col.kabe, hako: col.hako, yume: col.yume, gu: col.gu,
      borderD: borderD, gridD: gridD, crossD: crossD, ground: ground,
      poles: poles, flags: flags, dots: dots, marks: marks, ghosts: ghosts,
      ruler: ruler, rulerX: (rp[0] - 1).toFixed(1), rulerY: rp[1].toFixed(1), rulerH: rulerH,
      logHead: fut ? 'これからやりたいこと（旗が上がるもの）' : E[k0].d + ' の動き',
      rotStr: String(Math.round(rot)), dimStr: String(Math.round(dim)),
      dimLabel: dim < 8 ? '2D（真上から）' : (dim > 85 ? '3D（低く）' : '3D'),
      onRot: function (ev) { self.setState({ rot: parseFloat(ev.target.value) || 0 }); },
      onDim: function (ev) { self.setState({ dim: parseFloat(ev.target.value) || 0 }); },
      onDown: function (ev) { self._drag = { x: ev.clientX, y: ev.clientY, rot: rot, dim: dim }; },
      onMove: function (ev) {
        var d = self._drag;
        if (!d) return;
        self.setState({ rot: ((d.rot + (ev.clientX - d.x) * 0.35) % 360 + 360) % 360, dim: Math.max(0, Math.min(100, d.dim - (ev.clientY - d.y) * 0.25)) });
      },
      onUp: function () { self._drag = null; },""" + CONTROLS_JS + r"""
    };
  }
}"""


def v_data():
    items = []
    for i, it in enumerate(D.ITEMS):
        d = {"n": it["n"], "g": list(it["g"]), "x": it["x"], "s": it["s"], "now": it["now"], "plan": it.get("plan")}
        if i in M:
            d["m"] = M[i]
        items.append(d)
    return {"end": D.END, "today": D.TODAY, "events": D.EVENTS, "stageName": STAGE, "items": items, "poles": D.POLES}


V_LEGEND_OLD = "点線の○＝これから上げたい高さ。最初の回は多くても50人（11/05）"
V_LEGEND_NEW = "点線の○＝これから上げたい高さ。小さく下がった旗＝大きい流れに合流したもの（その竿と一緒に動く）。最初の回は多くても50人（11/05）"


def build_v():
    p = os.path.join(PROJ, "Vision.dc.html")
    s = open(p, encoding="utf-8").read()
    # 旗の字の大きさ・太さを穴にする／刻みに濃さを足す／これからの並び／凡例（何度かけても同じ結果になるように）
    rep = [
        ("font-size: 20px; line-height: 24px; font-weight: 900; color: {{fl.col}}", "font-size: {{fl.fs}}px; line-height: {{fl.lh}}px; font-weight: {{fl.fw}}; color: {{fl.col}}"),
        ("background: {{mk.col}}; z-index: 1500;", "background: {{mk.col}}; opacity: {{mk.op}}; z-index: 1500;"),
        (V_LEGEND_OLD + "</span>", V_LEGEND_NEW + "</span>"),
    ]
    for a, b in rep:
        if a not in s and s.count(b) == 1:
            continue  # もう入っている
        assert s.count(a) == 1, a[:60]
        s = s.replace(a, b)
    s = swap_plans(s, '<div style="position: absolute; left: 1296px; top: 176px; width: 360px;', V_FT)
    s, nh = re.subn(r"width: 1720px; height: \d+px; overflow: hidden;", f"width: 1720px; height: {V_H}px; overflow: hidden;", s)
    assert nh == 1
    pj = json.dumps({**{k: {"editor": "color", "default": g7.DEF[k], "section": "4軸の色"} for k in ["kabe", "hako", "yume", "gu"]},
                     "motion": {"editor": "enum", "options": ["当日だけ動く", "日付の間を直線で"], "default": "当日だけ動く", "section": "時間"},
                     "$preview": {"width": 1720, "height": V_H}}, ensure_ascii=False)
    assert "'" not in pj
    js = V_JS.replace("__DATA__", json.dumps(v_data(), ensure_ascii=False))
    new_script = f"<script type=\"text/x-dc\" data-dc-script data-props='{pj}'>\n{js}\n</script>"
    s, nsub = re.subn(r"<script type=\"text/x-dc\" data-dc-script data-props='[^']*'>\n.*?\n</script>", lambda _m: new_script, s, flags=re.S)
    assert nsub == 1
    open(p, "w", encoding="utf-8").write(s)
    print("Vision.dc.html", len(s))


def static_boxes():
    """B' の動かない字（縁の時間帯名・段階名）の箱。node の重なり確認で使う"""
    out = []
    for sname in D.SECTORS:
        out.append({"n": "縁:" + sname, "b": g7.arc_boxes(sname, (g7.SEC[sname][0] + g7.SEC[sname][1]) / 2, g7.RIM, 20)})
    for nm, r in [("妄想", 340), ("問い", 275), ("決定", 210), ("試作", 145), ("実地", 85), ("段階不明", g7.RU)]:
        out.append({"n": "段階:" + nm, "b": g7.arc_boxes(nm, g7.STAGE_RAY, r, 13)})
    return out


if __name__ == "__main__":
    print("merges:", {D.ITEMS[i]["k"]: m for i, m in M.items()})
    probs = [p for p in g7.check() if p.startswith("ura")]
    print("ura problems:", probs)
    with open(os.path.join(HERE, "static_boxes.json"), "w", encoding="utf-8") as fh:
        json.dump(static_boxes(), fh, ensure_ascii=False)
    if "--build" in sys.argv:
        build_b()
        build_v()
