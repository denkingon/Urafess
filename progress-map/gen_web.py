#!/usr/bin/env python3
"""ウェブ版：B'（夜の時計）と V（のぼり）を、キャンバスの外で開ける1枚のページにする。
ボードのファイル（NightClock.dc.html・Vision.dc.html）をそのまま読み、ひな形と動きのコードを
小さな描画係（穴埋め・くり返し・出し分け）で動かす。gen9.py --build のあとに走らせる。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import data as D  # noqa: E402

PROJ = os.path.join(HERE, "project")
OUT = os.path.join(HERE, "web", "index.html")


def read_board(fname):
    s = open(os.path.join(PROJ, fname), encoding="utf-8").read()
    css = re.search(r"<helmet>.*?<style>\n?(.*?)</style>", s, re.S).group(1)
    body = s.split("</helmet>", 1)[1].split("</x-dc>", 1)[0]
    code = re.search(r"<script type=\"text/x-dc\" data-dc-script data-props='[^']*'>\n(.*?)\n</script>", s, re.S).group(1)
    h = int(re.search(r"width: 1720px; height: (\d+)px; overflow: hidden", body).group(1))
    assert "</template" not in body and "</script" not in body and "</script" not in code
    return {"css": css, "body": body, "code": code, "h": h}


PAGE_CSS = """
*{box-sizing:border-box}
html,body{margin:0;background:#101114;color:#ECECEA}
body{font-family:'Noto Sans JP','Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',system-ui,sans-serif;min-height:100vh}
button{font-family:inherit}
.top{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:10px 16px;background:#16181C;border-bottom:1px solid #2A2C31}
.top h1{margin:0;font-size:16px;line-height:24px;font-weight:900;white-space:nowrap}
.top .upd{font-size:13px;line-height:18px;color:#A3A3A0;white-space:nowrap}
.tabs,.zoom{display:flex;gap:6px;align-items:center}
.zoom{margin-left:auto}
.tb{min-height:40px;min-width:40px;padding:0 14px;border-radius:8px;border:1px solid #34373E;background:#1C1E23;color:#C9C9C5;font-size:14px;line-height:20px;font-weight:700;cursor:pointer;white-space:nowrap}
.tb[aria-pressed="true"],.tb[aria-selected="true"]{background:#ECECEA;color:#101114;border-color:#ECECEA}
.tb:focus-visible,.bar input:focus-visible{outline:2px solid #FFFFFF;outline-offset:2px}
.zl{font-size:13px;line-height:18px;color:#A3A3A0;min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
#wrap{overflow-x:auto;overflow-y:hidden;padding-bottom:92px}
#stage{position:relative;overflow:hidden}
#board{position:absolute;left:0;top:0;transform-origin:0 0}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;align-items:center;gap:10px;padding:10px 16px calc(10px + env(safe-area-inset-bottom, 0px));background:#16181C;border-top:1px solid #2A2C31}
.bar .date{flex:none;min-width:86px;font-family:'IBM Plex Mono','Noto Sans JP',monospace;font-size:20px;line-height:24px;font-weight:600;white-space:nowrap}
.bar input[type=range]{flex:1 1 auto;min-width:80px;height:40px;margin:0;accent-color:#ECECEA;cursor:pointer}
.bar .tb{padding:0;width:44px;height:44px;display:flex;align-items:center;justify-content:center;flex:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:560px){.top h1{font-size:15px}.zoom{margin-left:0}.bar{gap:6px;padding-left:10px;padding-right:10px}.bar .date{min-width:70px;font-size:17px}}
@media (prefers-reduced-motion:reduce){#board *{animation:none !important}}
"""

RUNTIME_JS = r"""
class DCLogic {
  constructor() { this.props = {}; this.state = {}; }
  setState(s) { Object.assign(this.state, s); if (this._changed) this._changed(); }
  forceUpdate() { if (this._changed) this._changed(); }
}
// ---- 描画係：{{穴}}・<sc-for>・<sc-if> を、一度作った DOM を使い回しながら埋める ----
var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
var EVT = { onclick: 'click', onchange: 'input', onpointerdown: 'pointerdown', onpointermove: 'pointermove', onpointerup: 'pointerup', onpointerleave: 'pointerleave' };
function lookup(scope, path) {
  if (path === 'true') return true;
  if (path === 'false') return false;
  var parts = path.split('.'), s = scope;
  while (s && !(parts[0] in s.vars)) s = s.parent;
  var v = s ? s.vars[parts[0]] : undefined;
  for (var i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
  return v;
}
function fill(str, scope) {
  return str.replace(HOLE, function (_, p) { var v = lookup(scope, p); return v == null ? '' : String(v); });
}
function holePath(str) { var m = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(str || ''); return m ? m[1] : null; }
function make(tn) {
  if (tn.nodeType === 3) {
    var txt = tn.nodeValue;
    return function (scope, parent, before) {
      var n = document.createTextNode(''), last = null;
      var inst = {
        update: function (sc) { var v = txt.indexOf('{{') < 0 ? txt : fill(txt, sc); if (v !== last) { n.nodeValue = v; last = v; } },
        remove: function () { if (n.parentNode) n.parentNode.removeChild(n); }
      };
      inst.update(scope); parent.insertBefore(n, before); return inst;
    };
  }
  if (tn.nodeType !== 1) return function () { return { update: function () {}, remove: function () {} }; };
  var tag = tn.localName, kids = Array.prototype.map.call(tn.childNodes, make);
  if (tag === 'sc-for' || tag === 'sc-if') {
    var isFor = tag === 'sc-for', path = holePath(tn.getAttribute(isFor ? 'list' : 'value')), as = tn.getAttribute('as') || 'item';
    return function (scope, parent, before) {
      var anchor = document.createComment(tag), items = [];
      parent.insertBefore(anchor, before);
      var inst = {
        update: function (sc) {
          var v = lookup(sc, path), arr = isFor ? (v || []) : (v ? [null] : []);
          for (var i = 0; i < arr.length; i++) {
            var vars = {}; if (isFor) vars[as] = arr[i];
            var child = { vars: vars, parent: sc };
            if (i < items.length) { for (var j = 0; j < items[i].length; j++) items[i][j].update(child); }
            else { items.push(kids.map(function (f) { return f(child, anchor.parentNode, anchor); })); }
          }
          while (items.length > arr.length) { items.pop().forEach(function (x) { x.remove(); }); }
        },
        remove: function () { items.forEach(function (it) { it.forEach(function (x) { x.remove(); }); }); items = []; if (anchor.parentNode) anchor.parentNode.removeChild(anchor); }
      };
      inst.update(scope); return inst;
    };
  }
  var dyn = [], evs = [], drop = [];
  Array.prototype.forEach.call(tn.attributes, function (a) {
    var nm = a.name.toLowerCase();
    if (nm.indexOf('on') === 0 && holePath(a.value)) { drop.push(a.name); if (EVT[nm]) evs.push([EVT[nm], holePath(a.value)]); }
    else if (nm.indexOf('hint-') === 0) drop.push(a.name);
    else if (a.value.indexOf('{{') >= 0) dyn.push([a.name, a.value]);
  });
  return function (scope, parent, before) {
    var el = tn.cloneNode(false), cur = scope, last = {};
    drop.forEach(function (n) { el.removeAttribute(n); });
    evs.forEach(function (e) { el.addEventListener(e[0], function (ev) { var fn = lookup(cur, e[1]); if (typeof fn === 'function') fn(ev); }); });
    var setDyn = function (sc) {
      for (var i = 0; i < dyn.length; i++) {
        var v = fill(dyn[i][1], sc);
        if (last[dyn[i][0]] === v) continue;
        last[dyn[i][0]] = v;
        el.setAttribute(dyn[i][0], v);
        if (dyn[i][0] === 'value' && 'value' in el && el.value !== v) el.value = v;
      }
    };
    setDyn(scope);
    el = document.adoptNode(el);
    var insts = kids.map(function (f) { return f(scope, el, null); });
    parent.insertBefore(el, before);
    return {
      update: function (sc) { cur = sc; setDyn(sc); for (var i = 0; i < insts.length; i++) insts[i].update(sc); },
      remove: function () { if (el.parentNode) el.parentNode.removeChild(el); }
    };
  };
}
"""

APP_JS = r"""
// ---- ページ：ボードの切りかえ・大きさ・下の時間の帯 ----
(function () {
  var W = 1720, $ = function (id) { return document.getElementById(id); };
  var wrap = $('wrap'), stage = $('stage'), board = $('board'), styleEl = $('board-style');
  var cur = null, vals = null, zoom = null, key = null, started = false;
  var facs = {};
  Object.keys(BOARDS).forEach(function (k) { facs[k] = Array.prototype.map.call($(BOARDS[k].tpl).content.childNodes, make); });
  function fit() { return Math.max(0.2, Math.min(1, wrap.clientWidth / W)); }
  function layout() {
    if (!key) return;
    var s = zoom === null ? fit() : zoom;
    stage.style.width = (W * s) + 'px'; stage.style.height = (BOARDS[key].h * s) + 'px';
    board.style.width = W + 'px'; board.style.height = BOARDS[key].h + 'px';
    board.style.transform = 'scale(' + s + ')';
    $('zl').textContent = Math.round(s * 100) + '%';
    $('zfit').setAttribute('aria-pressed', zoom === null ? 'true' : 'false');
  }
  function syncBar() {
    if (!vals) return;
    $('bdate').textContent = vals.dateStr;
    var r = $('brange');
    r.max = vals.end;
    if (r.value !== vals.tStr) r.value = vals.tStr;
    $('bplay').setAttribute('aria-label', vals.playLabel);
    $('ico-play').style.display = vals.playing ? 'none' : '';
    $('ico-stop').style.display = vals.playing ? '' : 'none';
  }
  function mount(k) {
    if (key === k) return;
    var t0 = null;
    if (cur) {
      t0 = typeof cur.comp.state.t === 'number' ? cur.comp.state.t : null;
      if (cur.comp.componentWillUnmount) cur.comp.componentWillUnmount();
      cur.comp._changed = null;
      cur.insts.forEach(function (x) { x.remove(); });
    }
    key = k;
    var B = BOARDS[k], comp = new B.C(), insts = null;
    if (t0 !== null) comp.state.t = t0;  // 見ていた日付のまま切りかえる
    styleEl.textContent = B.css;
    var render = function () {
      vals = comp.renderVals();
      var scope = { vars: vals, parent: null };
      if (!insts) insts = facs[k].map(function (f) { return f(scope, board, null); });
      else for (var i = 0; i < insts.length; i++) insts[i].update(scope);
      syncBar();
    };
    comp._changed = render;
    render();
    cur = { comp: comp, insts: insts };
    Object.keys(BOARDS).forEach(function (x) { $('tab-' + x).setAttribute('aria-selected', x === k ? 'true' : 'false'); });
    // 細い画面（スマホ）は、字が読める大きさで絵の真ん中から始める
    if (!started && wrap.clientWidth < 700) zoom = 0.5;
    layout();
    if (!started && zoom !== null) wrap.scrollLeft = Math.max(0, 850 * zoom - wrap.clientWidth / 2);
    started = true;
  }
  function route() { var h = (location.hash || '').replace('#', ''); mount(BOARDS[h] ? h : 'clock'); }
  Object.keys(BOARDS).forEach(function (x) {
    $('tab-' + x).addEventListener('click', function () { try { location.hash = x; } catch (e) {} mount(x); });
  });
  $('zin').addEventListener('click', function () { zoom = Math.min(2, (zoom === null ? fit() : zoom) * 1.25); layout(); });
  $('zout').addEventListener('click', function () { zoom = Math.max(0.2, (zoom === null ? fit() : zoom) / 1.25); layout(); });
  $('zfit').addEventListener('click', function () { zoom = null; layout(); });
  $('bprev').addEventListener('click', function () { if (vals) vals.prev(); });
  $('bnext').addEventListener('click', function () { if (vals) vals.next(); });
  $('bplay').addEventListener('click', function () { if (vals) vals.togglePlay(); });
  $('brange').addEventListener('input', function (ev) { if (vals) vals.onRange(ev); });
  window.addEventListener('resize', layout);
  window.addEventListener('hashchange', route);
  route();
})();
"""


def build():
    clock = read_board("NightClock.dc.html")
    flags = read_board("Vision.dc.html")
    # ウェブでは縦に指で送れるように：V の地面は横のドラッグだけ受ける
    assert flags["body"].count("touch-action: none") == 1
    flags["body"] = flags["body"].replace("touch-action: none", "touch-action: pan-y")
    last = [e for e in D.EVENTS if not e.get("future")][-1]["d"]
    ico = 'width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    comp = lambda name, b: f"var {name} = (function (DCLogic) {{\n{b['code']}\nreturn Component;\n}})(DCLogic);\n"
    boards_js = ("var BOARDS = {\n"
                 f"  clock: {{ tpl: 'tpl-clock', C: ClockC, h: {clock['h']}, css: {json.dumps(clock['css'], ensure_ascii=False)} }},\n"
                 f"  flags: {{ tpl: 'tpl-flags', C: FlagsC, h: {flags['h']}, css: {json.dumps(flags['css'], ensure_ascii=False)} }}\n"
                 "};\n")
    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Urafess 進捗マップ（ウェブ版）</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&amp;family=Noto+Sans+JP:wght@400;700;900&amp;display=swap">
<style>{PAGE_CSS}</style>
<style id="board-style"></style>
</head>
<body>
<header class="top">
<h1>Urafess 進捗マップ</h1>
<div class="tabs" role="tablist" aria-label="見え方">
<button type="button" class="tb" role="tab" id="tab-clock" aria-selected="true">夜の時計</button>
<button type="button" class="tb" role="tab" id="tab-flags" aria-selected="false">のぼり</button>
</div>
<span class="upd">{last} 更新</span>
<div class="zoom">
<button type="button" class="tb" id="zout" aria-label="小さく">−</button>
<span class="zl" id="zl">100%</span>
<button type="button" class="tb" id="zin" aria-label="大きく">＋</button>
<button type="button" class="tb" id="zfit" aria-pressed="true">幅に合わせる</button>
</div>
</header>
<main id="wrap"><div id="stage"><div id="board"></div></div></main>
<div class="bar" role="group" aria-label="日付を動かす">
<span class="date" id="bdate"></span>
<button type="button" class="tb" id="bprev" aria-label="前の動きへ"><svg {ico}><path d="M11 4 L6 9 L11 14"></path></svg></button>
<button type="button" class="tb" id="bplay" aria-label="再生"><svg id="ico-play" {ico}><path d="M6 4 L14 9 L6 14 Z"></path></svg><svg id="ico-stop" {ico} style="display:none"><path d="M6 5 L6 13 M12 5 L12 13"></path></svg></button>
<button type="button" class="tb" id="bnext" aria-label="次の動きへ"><svg {ico}><path d="M7 4 L12 9 L7 14"></path></svg></button>
<label class="sr" for="brange">日付</label>
<input id="brange" type="range" min="0" max="{D.END}" step="0.05" value="{D.TODAY}">
</div>
<template id="tpl-clock">{clock['body']}</template>
<template id="tpl-flags">{flags['body']}</template>
<script>
{RUNTIME_JS}
{comp('ClockC', clock)}
{comp('FlagsC', flags)}
{boards_js}
{APP_JS}
</script>
</body>
</html>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(html)
    print("web/index.html", len(html.encode("utf-8")), "bytes")


if __name__ == "__main__":
    build()
