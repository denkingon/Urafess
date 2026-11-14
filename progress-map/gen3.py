#!/usr/bin/env python3
"""B' 夜の時計・変遷 — text-as-shape night clock with a time bar."""
import json
import math
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.join(ROOT, "project")
W, H = 1720, 1700
CX, CY = 840, 780
RING = [340, 275, 210, 145, 85, 30]   # 妄想 問い 決定 試作 実地 本番 (tip radius)
RU = 380                              # 段階不明
RIM = 650
FONT = "'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', system-ui, sans-serif"
MONO = "'IBM Plex Mono', ui-monospace, monospace"
DEF = {"kabe": "#FF8A3D", "hako": "#3FD0A0", "yume": "#A98BFF", "gu": "#F2D74B"}
AXNAME = {"kabe": "壁突破", "hako": "箱庭建築", "yume": "夢・妄想・神", "gu": "妄想具現"}

# 当日の流れ（11/04 本人記述）を時計回りに。幅は「1 + 0.5×そこにある件数」で歪ませる
SECTORS = [
    ("召集", 2.0), ("集合", 1.5), ("説明・チーム分け", 1.5), ("ドロケイ", 3.0), ("結果・反省", 1.0),
    ("増やし鬼", 1.0), ("最後の発表", 1.5), ("イータへ・アイス", 1.0), ("後", 1.5), ("土台", 3.5), ("前", 1.5),
]


def sector_angles():
    tot = sum(w for _, w in SECTORS)
    a = -90.0
    out = []
    for name, w in SECTORS:
        span = 360.0 * w / tot
        out.append((name, a, a + span))
        a += span
    return out


def glyph_box(ch, fs):
    if ch == " ":
        return 0.35 * fs, 0.35 * fs
    if ord(ch) < 128:
        return 0.62 * fs, 0.8 * fs
    return fs, fs


def step_along(ch, fs, dx, dy):
    w, h = glyph_box(ch, fs)
    cands = []
    if abs(dx) > 1e-6:
        cands.append(w / abs(dx))
    if abs(dy) > 1e-6:
        cands.append(h / abs(dy))
    return min(cands) + 0.06 * fs


def arc_text(word, theta_deg, R, fs, color, weight=700):
    """upright glyphs along a circle, centred on theta, normalised to read L→R / top→bottom"""
    th = math.radians(theta_deg)
    tx, ty = -math.sin(th), math.cos(th)
    fwd = tx > 0 if abs(tx) > abs(ty) else ty > 0
    seq = list(word) if fwd else list(word)[::-1]
    steps = [step_along(c, fs, tx, ty) for c in seq]
    total = sum(steps)
    pos, acc = [], -total / 2
    for c, s in zip(seq, steps):
        mid = acc + s / 2
        a = th + mid / R
        pos.append((c, CX + R * math.cos(a), CY + R * math.sin(a)))
        acc += s
    return "".join(
        f'<span style="position: absolute; left: {x - fs / 2:.1f}px; top: {y - fs / 2:.1f}px; width: {fs}px; height: {fs}px; display: flex; align-items: center; justify-content: center; font-size: {fs}px; line-height: 1; font-weight: {weight}; color: {color}">{c}</span>'
        for c, x, y in pos
    )


JS = r"""class Component extends DCLogic {
  componentWillUnmount() { this.stop(); }
  stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
  data() {
    return {
      end: 28,
      // day = 10/07からの日数。この日に動いた
      events: [
        { day: 0, d: '10/07', t: '編集台をつくり、課題が並んだ' },
        { day: 7, d: '10/14', t: 'アプリの設計書・vision・一元管理' },
        { day: 15, d: '10/22', t: 'スマホ連鎖の計画書' },
        { day: 28, d: '11/04', t: 'アプリの根幹が動いた。書体と編集パレット' }
      ],
      stageName: ['妄想', '問い', '決定', '試作', '実地', '本番'],
      // n:名前 a:角度 t:効き(0大 1中 2小) x:主な軸 s:各日の段階(null=まだ無い, 'u'=不明) now:手を入れた日(eventsの番号)
      items: [
        { n: '告知・集客', a: -80, t: 0, x: 'gu', s: [1, 1, 1, 1], now: [0] },
        { n: 'スマホ連鎖', a: -62, t: 2, x: 'kabe', s: [null, 2, 2, 2], now: [1, 2] },
        { n: '入場の儀式', a: -38, t: 1, x: 'yume', s: [1, 1, 1, 1], now: [0] },
        { n: 'アプリの根幹', a: -10, t: 1, x: 'kabe', s: [null, 1, 1, 3], now: [1, 3] },
        { n: 'タッチ判定', a: 14, t: 1, x: 'kabe', s: [null, 2, 2, 2], now: [1] },
        { n: '3勢力ルール', a: 26, t: 1, x: 'hako', s: [null, 1, 1, 1], now: [1] },
        { n: '救助隊・メディック', a: 42, t: 1, x: 'hako', s: [0, 0, 0, 0], now: [0] },
        { n: 'リスク対策', a: 55, t: 0, x: 'gu', s: [null, 0, 0, 0], now: [] },
        { n: 'フィナーレ', a: 113, t: 1, x: 'yume', s: [1, 1, 1, 1], now: [0] },
        { n: 'カメラ・世界向け動画', a: 161, t: 2, x: 'yume', s: [0, 0, 0, 0], now: [0] },
        { n: 'urafess-vision', a: 184, t: 2, x: 'yume', s: [null, 3, 3, 3], now: [1] },
        { n: '編集パレット', a: 196, t: 2, x: 'gu', s: [3, 3, 3, 3], now: [0, 3] },
        { n: '一元管理', a: 207, t: 2, x: 'none', s: [null, 5, 5, 5], now: [1] },
        { n: 'ハラハラ／ヌクヌク', a: 217, t: 1, x: 'yume', s: [null, null, null, 3], now: [3] },
        { n: 'URAJI 裏字', a: 233, t: 1, x: 'yume', s: [null, null, null, 3], now: [3] },
        { n: '会場・大学との交渉', a: 248, t: 0, x: 'kabe', s: ['u', 'u', 'u', 'u'], now: [] }
      ],
      empty: [70.95, 89.85, 137.15]
    };
  }
  clamp01(x) { return x <= 0 ? 0 : (x >= 1 ? 1 : x); }
  setT(t) {
    var E = this.data().end;
    this.setState({ t: Math.max(0, Math.min(E, t)) });
  }
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
    var E = D.events, END = D.end;
    var st = this.state || {};
    var t = typeof st.t === 'number' ? st.t : END;
    var playing = !!this._raf;
    var col = {
      kabe: this.props.kabe ?? '#FF8A3D', hako: this.props.hako ?? '#3FD0A0',
      yume: this.props.yume ?? '#A98BFF', gu: this.props.gu ?? '#F2D74B', none: '#A6A8AD'
    };
    var CX = 840, CY = 780, RING = [340, 275, 210, 145, 85, 30], RU = 380, OUT = RU + 110, FS = [28, 24, 17];
    var rOf = function (s) { return s === 'u' ? RU : RING[s]; };
    var pt = function (a, r) { var q = a * Math.PI / 180; return [CX + Math.cos(q) * r, CY + Math.sin(q) * r]; };
    var cl = this.clamp01;
    var lin = (this.props.motion ?? '当日だけ動く') === '日付の間を直線で';
    var startOf = function (k) { return lin && k > 0 ? E[k - 1].day : E[k].day - 1; };
    var prog = function (k) { return cl((t - startOf(k)) / (E[k].day - startOf(k))); };
    var chars = [], tips = [], trails = [], segs = [], verts = [];
    D.items.forEach(function (it) {
      // 位置：生まれる日と動いた日に、その前日から当日へ一次関数で動く
      var b = -1;
      for (var k = 0; k < E.length; k++) { if (it.s[k] !== null && it.s[k] !== undefined) { b = k; break; } }
      var alive = 0, r = OUT, unknown = false;
      if (b >= 0) {
        unknown = it.s[b] === 'u';
        alive = prog(b);
        r = OUT + (rOf(it.s[b]) - OUT) * alive;
        if (alive >= 1) {
          for (var k2 = b + 1; k2 < E.length; k2++) {
            var sp = it.s[k2 - 1], sk = it.s[k2];
            if (sk === sp || sk === 'u' || sp === 'u') continue;
            var f = prog(k2);
            if (f <= 0) break;
            var rp = rOf(sp), rk = rOf(sk), rn = rp + (rk - rp) * f;
            var p0 = pt(it.a, rp), p1 = pt(it.a, rn);
            trails.push({ x: p0[0].toFixed(1), y: p0[1].toFixed(1), col: col[it.x] });
            var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
            segs.push({ x: p0[0].toFixed(1), y: p0[1].toFixed(1), len: Math.sqrt(dx * dx + dy * dy).toFixed(1), rot: (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2), col: col[it.x] });
            r = rn;
            if (f < 1) break;
          }
        }
      }
      // 光：手を入れた日に向けて一次関数で強まり、3日かけて一次関数で消える
      var g = 0;
      it.now.forEach(function (k) {
        var dd = E[k].day;
        var v = t <= dd ? cl(t - (dd - 1)) : 1 - cl((t - dd) / 3);
        if (v > g) g = v;
      });
      var fs = FS[it.t], c = col[it.x];
      var op = alive * (unknown ? 0.45 : 0.55 + 0.45 * g);
      var glow = g > 0.02 ? '0 0 10px rgba(255,255,255,' + (0.55 * g).toFixed(2) + '), 0 0 26px rgba(255,255,255,' + (0.22 * g).toFixed(2) + ')' : 'none';
      self.needle(it.n, it.a, r, fs).forEach(function (p) {
        chars.push({ c: p.c, x: (CX + p.x).toFixed(1), y: (CY + p.y).toFixed(1), fs: fs, col: c, op: op.toFixed(3), glow: glow, fw: it.t === 0 ? 900 : 700 });
      });
      var tp = pt(it.a, r);
      tips.push({ x: tp[0].toFixed(1), y: tp[1].toFixed(1), bg: g >= 0.5 ? '#FFFFFF' : c, op: (alive * (unknown ? 0.45 : 1)).toFixed(3), cls: g >= 0.5 ? 'now-ring' : '' });
      verts.push({ a: it.a, r: alive > 0 ? r : RU });
    });
    D.empty.forEach(function (a) { verts.push({ a: a, r: RU }); });
    verts.sort(function (p, q) { return p.a - q.a; });
    var P = verts.map(function (v) { return pt(v.a, Math.min(v.r, RU)); });
    var n = P.length, f2 = function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); };
    var shapeD = 'M ' + f2(P[0]);
    for (var i = 0; i < n; i++) {
      var a0 = P[(i - 1 + n) % n], a1 = P[i], a2 = P[(i + 1) % n], a3 = P[(i + 2) % n];
      shapeD += ' C ' + f2([a1[0] + (a2[0] - a0[0]) / 6, a1[1] + (a2[1] - a0[1]) / 6]) + ' ' + f2([a2[0] - (a3[0] - a1[0]) / 6, a2[1] - (a3[1] - a1[1]) / 6]) + ' ' + f2(a2);
    }
    shapeD += ' Z';
    // いまの日付と、直近の動き
    var day = Math.floor(t + 1e-6);
    var dt = new Date(2026, 9, 7 + day);
    var dateStr = (dt.getMonth() + 1) + '/' + ('0' + dt.getDate()).slice(-2);
    var last = 0;
    for (var e = 0; e < E.length; e++) { if (E[e].day <= t + 1e-6) last = e; }
    var ramping = -1;
    for (var e2 = 0; e2 < E.length; e2++) { if (t > startOf(e2) + 1e-6 && t < E[e2].day - 1e-6) ramping = e2; }
    var caption;
    if (ramping >= 0) caption = '→ ' + E[ramping].d + '：' + E[ramping].t;
    else if (t - E[last].day < 1) caption = E[last].t;
    else caption = E[last].d + ' から ' + Math.floor(t - E[last].day) + '日、動きなし';
    var k0 = ramping >= 0 ? ramping : last;
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
    if (moved.length) log.push({ k: '進んだ', v: moved.join('、') });
    if (touched.length) log.push({ k: '手を入れた', v: touched.join('、') });
    var TW = 780, PAD = 9;
    var ticks = E.map(function (ev, k) {
      var cnt = 0;
      D.items.forEach(function (it) { if (it.now.indexOf(k) >= 0) cnt++; });
      var x = PAD + (TW - 2 * PAD) * ev.day / END;
      var on = Math.abs(t - ev.day) < 0.5;
      return {
        d: ev.d, x: x.toFixed(1), h: 6 + cnt * 6, top: 40 - (6 + cnt * 6),
        col: on ? '#FFFFFF' : '#8E8E8A', bar: on ? '#FFFFFF' : '#55585F', fw: on ? 600 : 500,
        go: function () { self.stop(); self.setT(ev.day); }
      };
    });
    var days = [];
    for (var dd2 = 0; dd2 <= END; dd2++) { days.push({ x: (PAD + (TW - 2 * PAD) * dd2 / END).toFixed(1) }); }
    return {
      kabe: col.kabe, hako: col.hako, yume: col.yume, gu: col.gu,
      chars: chars, tips: tips, trails: trails, segs: segs, shapeD: shapeD,
      tStr: t.toFixed(2), end: END, dateStr: dateStr, caption: caption,
      logHead: E[k0].d + ' の動き', log: log, ticks: ticks, days: days,
      playing: playing, notPlaying: !playing, playLabel: playing ? '止める' : '10/07から再生',
      prev: function () {
        self.stop(); var tg = 0;
        E.forEach(function (ev) { if (ev.day < t - 0.01) tg = ev.day; });
        self.setT(tg);
      },
      next: function () {
        self.stop(); var tg = END;
        for (var q = E.length - 1; q >= 0; q--) { if (E[q].day > t + 0.01) tg = E[q].day; }
        self.setT(tg);
      },
      onRange: function (ev) { self.stop(); self.setT(parseFloat(ev.target.value) || 0); },
      togglePlay: function () {
        if (self._raf) { self.stop(); self.forceUpdate(); return; }
        var tt = t >= END - 0.01 ? 0 : t, lastTs = null, rate = END / 10;
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


def build():
    secs = sector_angles()
    o = [f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>B' 夜の時計・変遷</title>
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
</style>
</helmet>
"""]
    o.append(f'<div style="position: relative; width: {W}px; height: {H}px; overflow: hidden; background: #101114; color: #ECECEA; font-family: {FONT}">\n')

    # --- scaffold: rings + sector rays ---
    g = [f'<svg width="{W}" height="1470" viewBox="0 0 {W} 1470" aria-hidden="true" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px">']
    for r in RING[:-1]:
        g.append(f'<circle cx="{CX}" cy="{CY}" r="{r}" fill="none" stroke="#26282D" stroke-width="1"></circle>')
    g.append(f'<circle cx="{CX}" cy="{CY}" r="{RU}" fill="none" stroke="#3A3D44" stroke-width="1" stroke-dasharray="3 6"></circle>')
    g.append(f'<circle cx="{CX}" cy="{CY}" r="22" fill="#1B1D22" stroke="#3A3D44" stroke-width="1"></circle>')
    for _, a0, _a1 in secs:
        t = math.radians(a0)
        g.append(f'<line x1="{CX + 26 * math.cos(t):.1f}" y1="{CY + 26 * math.sin(t):.1f}" x2="{CX + 615 * math.cos(t):.1f}" y2="{CY + 615 * math.sin(t):.1f}" stroke="#2A2C31" stroke-width="1" stroke-dasharray="2 6"></line>')
    g.append("</svg>\n")
    o.append("".join(g))

    # rim labels: the night's flow, written along the rim
    for name, a0, a1 in secs:
        o.append(arc_text(name, (a0 + a1) / 2, RIM, 20, "#8A8D93", 700) + "\n")
    # stage names written along their own rings, in the empty 反省／増やし鬼 slice
    for name, r in [("妄想", 340), ("問い", 275), ("決定", 210), ("試作", 145), ("実地", 85), ("段階不明", RU)]:
        o.append(arc_text(name, 79.0, r, 13, "#7A7D83", 400) + "\n")
    o.append(f'<span style="position: absolute; left: {CX - 30}px; top: {CY - 9}px; width: 60px; text-align: center; font-size: 13px; line-height: 18px; font-weight: 700; color: #ECECEA">本番</span>\n')

    # --- live layer (wheel scrubs time) ---
    o.append(f'<div onWheel="{{{{onWheel}}}}" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px">\n')
    o.append(
        f'<svg width="{W}" height="1470" viewBox="0 0 {W} 1470" aria-hidden="true" style="position: absolute; left: 0px; top: 0px; width: {W}px; height: 1470px; pointer-events: none">'
        "<path d=\"{{shapeD}}\" fill=\"rgba(236,236,234,0.045)\" stroke=\"rgba(236,236,234,0.30)\" stroke-width=\"1.5\" stroke-linejoin=\"round\"></path></svg>\n"
    )
    o.append(
        '<sc-for list="{{segs}}" as="g" hint-placeholder-count="1">'
        '<span style="position: absolute; left: 0px; top: 0px; width: {{g.len}}px; height: 0px; border-top: 1.5px dashed {{g.col}}; opacity: 0.7; transform-origin: 0 0; transform: translate({{g.x}}px, {{g.y}}px) rotate({{g.rot}}deg)"></span>'
        "</sc-for>\n"
    )
    o.append(
        '<sc-for list="{{trails}}" as="tr" hint-placeholder-count="1">'
        '<span style="position: absolute; left: 0px; top: 0px; width: 9px; height: 9px; box-sizing: border-box; border-radius: 5px; border: 1.5px solid {{tr.col}}; transform: translate({{tr.x}}px, {{tr.y}}px) translate(-50%, -50%)"></span>'
        "</sc-for>\n"
    )
    o.append(
        '<sc-for list="{{tips}}" as="t" hint-placeholder-count="16">'
        '<span class="{{t.cls}}" style="position: absolute; left: 0px; top: 0px; width: 8px; height: 8px; border-radius: 4px; background: {{t.bg}}; opacity: {{t.op}}; transform: translate({{t.x}}px, {{t.y}}px) translate(-50%, -50%)"></span>'
        "</sc-for>\n"
    )
    o.append(
        '<sc-for list="{{chars}}" as="ch" hint-placeholder-count="120">'
        '<span style="position: absolute; left: 0px; top: 0px; font-size: {{ch.fs}}px; line-height: 1; font-weight: {{ch.fw}}; color: {{ch.col}}; opacity: {{ch.op}}; text-shadow: {{ch.glow}}; white-space: pre; transform: translate({{ch.x}}px, {{ch.y}}px) translate(-50%, -50%)">{{ch.c}}</span>'
        "</sc-for>\n"
    )
    o.append("</div>\n")

    # --- title + legend (top-left column) ---
    o.append(
        '<div style="position: absolute; left: 64px; top: 44px; display: flex; flex-direction: column; gap: 4px">'
        '<span style="font-size: 40px; line-height: 48px; font-weight: 900; letter-spacing: 0.02em">夜の時計</span>'
        '<span style="font-size: 18px; line-height: 24px; font-weight: 700; color: #A3A3A0">変遷 ─ 10/07 から 11/04 まで、1日ずつ</span></div>\n'
    )
    axis_words = "".join(f'<span style="color: {{{{{k}}}}}">{AXNAME[k]}</span>' for k in ["kabe", "hako", "yume", "gu"])
    o.append(
        '<div style="position: absolute; left: 64px; top: 150px; width: 400px; display: flex; flex-direction: column; gap: 12px">'
        '<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">角度＝当日の流れ　中心に近いほど仕上がり</span>'
        f'<span style="display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 15px; line-height: 20px; font-weight: 700">{axis_words}</span>'
        '<span style="display: flex; align-items: baseline; gap: 14px; color: #ECECEA">'
        '<span style="font-size: 28px; line-height: 32px; font-weight: 900">無いと開けない</span>'
        '<span style="font-size: 24px; line-height: 32px; font-weight: 700">核</span>'
        '<span style="font-size: 17px; line-height: 32px; font-weight: 700">支える</span></span>'
        '<span style="font-size: 15px; line-height: 20px; font-weight: 700; color: #FFFFFF; text-shadow: 0 0 10px rgba(255,255,255,0.55), 0 0 26px rgba(255,255,255,0.22)">光る＝その日に手を入れた</span>'
        "</div>\n"
    )

    # --- time band ---
    btn = "flex: none; width: 44px; height: 44px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: #1C1E23; border: 1px solid #34373E; border-radius: 8px; color: #ECECEA; cursor: pointer; padding: 0px"
    ico = 'width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    o.append(
        f'<div style="position: absolute; left: 64px; top: 1488px; width: 1592px; display: flex; align-items: flex-start; gap: 40px">'
        # date + caption
        f'<div style="flex: none; width: 340px; display: flex; flex-direction: column; gap: 8px">'
        f'<span style="font-family: {MONO}; font-size: 96px; line-height: 96px; font-weight: 600; letter-spacing: -0.02em">{{{{dateStr}}}}</span>'
        f'<span style="font-size: 17px; line-height: 25px; font-weight: 700">{{{{caption}}}}</span></div>'
        # track: activity ticks + range + date buttons
        f'<div style="flex: none; width: 780px; display: flex; flex-direction: column; gap: 4px">'
        f'<div style="position: relative; width: 780px; height: 132px">'
        f'<sc-for list="{{{{days}}}}" as="dy" hint-placeholder-count="29"><span style="position: absolute; left: {{{{dy.x}}}}px; top: 36px; width: 1px; height: 4px; background: #34373E"></span></sc-for>'
        f'<sc-for list="{{{{ticks}}}}" as="tk" hint-placeholder-count="4"><span style="position: absolute; left: {{{{tk.x}}}}px; top: {{{{tk.top}}}}px; width: 3px; height: {{{{tk.h}}}}px; margin-left: -1px; background: {{{{tk.bar}}}}"></span></sc-for>'
        f'<label for="t-range" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">日付</label>'
        f'<input id="t-range" type="range" min="0" max="{{{{end}}}}" step="0.05" value="{{{{tStr}}}}" onChange="{{{{onRange}}}}" style="position: absolute; left: 0px; top: 42px; width: 780px; height: 44px; margin: 0px; accent-color: #ECECEA; cursor: pointer">'
        f'<sc-for list="{{{{ticks}}}}" as="tk" hint-placeholder-count="4"><button type="button" onClick="{{{{tk.go}}}}" style="position: absolute; left: {{{{tk.x}}}}px; top: 86px; transform: translateX(-50%); min-width: 60px; min-height: 44px; padding: 0px 4px; background: none; border: 0px; color: {{{{tk.col}}}}; font-family: {MONO}; font-size: 15px; font-weight: {{{{tk.fw}}}}; cursor: pointer">{{{{tk.d}}}}</button></sc-for>'
        f'</div>'
        f'<div style="display: flex; align-items: center; gap: 10px">'
        f'<button type="button" aria-label="前の動きへ" onClick="{{{{prev}}}}" style="{btn}"><svg {ico}><path d="M11 4 L6 9 L11 14"></path></svg></button>'
        f'<button type="button" aria-label="次の動きへ" onClick="{{{{next}}}}" style="{btn}"><svg {ico}><path d="M7 4 L12 9 L7 14"></path></svg></button>'
        f'<button type="button" aria-label="{{{{playLabel}}}}" onClick="{{{{togglePlay}}}}" style="{btn}">'
        f'<sc-if value="{{{{notPlaying}}}}" hint-placeholder-val="{{{{ true }}}}"><svg {ico}><path d="M6 4 L14 9 L6 14 Z"></path></svg></sc-if>'
        f'<sc-if value="{{{{playing}}}}" hint-placeholder-val="{{{{ false }}}}"><svg {ico}><path d="M6 5 L6 13 M12 5 L12 13"></path></svg></sc-if></button>'
        f'<span style="font-size: 13px; line-height: 18px; color: #8E8E8A">1日ずつ一直線に流れる。縦棒の高さ＝その日に手を入れた数　→ 本番の夜［日付未定］</span></div></div>'
        # log
        f'<div style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding-top: 8px">'
        f'<span style="font-size: 12px; line-height: 16px; color: #A3A3A0">{{{{logHead}}}}</span>'
        f'<sc-for list="{{{{log}}}}" as="l" hint-placeholder-count="3">'
        f'<div style="display: flex; flex-direction: column; gap: 2px"><span style="font-size: 12px; line-height: 16px; color: #A3A3A0">{{{{l.k}}}}</span>'
        f'<span style="font-size: 15px; line-height: 22px; font-weight: 700; color: #ECECEA">{{{{l.v}}}}</span></div>'
        f'</sc-for></div>'
        f'</div>\n'
    )
    o.append("</div>\n")

    props = {k: {"editor": "color", "default": DEF[k], "section": "4軸の色"} for k in ["kabe", "hako", "yume", "gu"]}
    props["motion"] = {"editor": "enum", "options": ["当日だけ動く", "日付の間を直線で"], "default": "当日だけ動く", "section": "時間"}
    props["$preview"] = {"width": W, "height": H}
    o.append(f"""</x-dc>
<script type="text/x-dc" data-dc-script data-props='{json.dumps(props, ensure_ascii=False)}'>
{JS}
</script>
</body>
</html>
""")
    html = "".join(o)
    assert "'" not in json.dumps(props, ensure_ascii=False)
    with open(os.path.join(PROJ, "NightClock.dc.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("NightClock.dc.html", len(html), [(n, round(a0, 1), round(a1, 1)) for n, a0, a1 in secs])


if __name__ == "__main__":
    build()
