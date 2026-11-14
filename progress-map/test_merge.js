// B' と V のスクリプトをそのまま動かして、合流の動き・字の重なり・壊れた値を確かめる
const fs = require('fs');

function load(path) {
  const html = fs.readFileSync(path, 'utf8');
  const m = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('script not found in ' + path);
  class DCLogic { constructor() { this.props = {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } forceUpdate() {} }
  global.requestAnimationFrame = () => 1; global.cancelAnimationFrame = () => {};
  const Component = new Function('DCLogic', m[2] + '\nreturn Component;')(DCLogic);
  return { Component, props: JSON.parse(m[1]), html };
}

function boxOf(c, x, y, fs) {
  let w = fs, h = fs;
  if (c === ' ') { w = h = 0.35 * fs; } else if (c.charCodeAt(0) < 128) { w = 0.62 * fs; h = 0.8 * fs; }
  return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
}
function ov(a, b, pad) {
  const dx = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) - pad, dy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) - pad;
  return dx > 0 && dy > 0 ? dx * dy : 0;
}
function bad(obj) { const s = JSON.stringify(obj); return /NaN|undefined|Infinity/.test(s); }

// ---------- B' ----------
const B = load(__dirname + '/project/NightClock.dc.html');
const statics = JSON.parse(fs.readFileSync(__dirname + '/static_boxes.json', 'utf8'));
const cb = new B.Component();
const D = cb.data();
const names = D.items.map((it) => it.n);
const probs = new Map();
let nanAt = null, maxChars = 0;
for (const motion of ['当日だけ動く', '日付の間を直線で']) {
  cb.props = { motion };
  for (let t = 0; t <= D.end + 1e-9; t += 0.05) {
    cb.state = { t };
    const v = cb.renderVals();
    if (!nanAt && (bad(v.chars) || bad(v.tips) || bad(v.segs) || bad(v.trails) || bad(v.tribs) || bad(v.ghosts) || bad(v.gsegs) || /NaN/.test(v.shapeD))) nanAt = motion + ' t=' + t.toFixed(2);
    maxChars = Math.max(maxChars, v.chars.length);
    const vis = v.chars.filter((c) => +c.op > 0.08).map((c) => ({ w: c.w, b: boxOf(c.c, +c.x, +c.y, +c.fs) }));
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        if (vis[i].w === vis[j].w) continue;
        const a = ov(vis[i].b, vis[j].b, 1.0);
        if (a > 0) {
          const key = [names[vis[i].w], names[vis[j].w]].sort().join(' × ');
          const p = probs.get(key) || { first: motion + ' t=' + t.toFixed(2), max: 0, n: 0 };
          p.max = Math.max(p.max, a); p.n++; probs.set(key, p);
        }
      }
      for (const s of statics) {
        for (const sb of s.b) {
          const a = ov(vis[i].b, sb, 1.0);
          if (a > 0) {
            const key = names[vis[i].w] + ' × ' + s.n;
            const p = probs.get(key) || { first: motion + ' t=' + t.toFixed(2), max: 0, n: 0 };
            p.max = Math.max(p.max, a); p.n++; probs.set(key, p);
          }
        }
      }
    }
  }
}
console.log("B': 壊れた値", nanAt || 'なし', '／字の数の最大', maxChars);
console.log("B': 重なり", probs.size === 0 ? 'なし' : '');
for (const [k, p] of probs) console.log('   ', k, '最初', p.first, '最大', p.max.toFixed(1) + 'px²', p.n + '回');

// 合流の様子（今日の終わり・これからの終わり）
cb.props = {};
for (const t of [27.0, 27.4, 27.8, 28, 29.5, 30, 36]) {
  cb.state = { t };
  const v = cb.renderVals();
  const byW = {};
  v.chars.forEach((c) => { (byW[c.w] = byW[c.w] || []).push(c); });
  const show = ['通信（Wi-Fi調査）', 'ホーム画面アプリ化', 'タッチ判定', '走ると全員に通知', 'KICとの交渉'];
  const row = show.map((n) => {
    const w = names.indexOf(n), cs = byW[w];
    if (!cs) return n + ':—';
    return n.slice(0, 4) + ':(' + (+cs[0].x).toFixed(0) + ',' + (+cs[0].y).toFixed(0) + ') fs' + cs[0].fs + ' op' + cs[0].op;
  });
  console.log('t=' + t, row.join('  '), '| 来た道', v.tribs.length, '| 点線○', v.ghosts.length);
}
cb.state = { t: 28 }; let v28 = cb.renderVals();
console.log('11/04 の動き', JSON.stringify(v28.log));
cb.state = { t: 30 }; let v30 = cb.renderVals();
console.log('11/06 の動き', JSON.stringify(v30.log));
cb.state = { t: 36 }; let v36 = cb.renderVals();
console.log('これから', JSON.stringify(v36.log));
console.log('これからの一覧', JSON.stringify(v36.plans.map((p) => p.n + '｜' + p.p)));

// 合流先の字との距離（脇に付いているか）
function centroid(cs) { let x = 0, y = 0; cs.forEach((c) => { x += +c.x; y += +c.y; }); return [x / cs.length, y / cs.length]; }
for (const t of [30, 36]) {
  cb.state = { t }; const v = cb.renderVals();
  const byW = {}; v.chars.forEach((c) => { (byW[c.w] = byW[c.w] || []).push(c); });
  D.items.forEach((it, i) => {
    if (!it.m) return;
    const a = centroid(byW[i]), p = centroid(byW[it.m.into]);
    console.log('  t=' + t, it.n, '→', D.items[it.m.into].n, '重心の距離', Math.hypot(a[0] - p[0], a[1] - p[1]).toFixed(0) + 'px', '側', it.m.side, '列', it.m.slot);
  });
}

// これから合流する場合も壊れないか（表を一時的に書き換えて試す）
const cb2 = new B.Component();
const D2 = JSON.parse(JSON.stringify(D));
D2.items.forEach((it) => { if (it.n === 'タッチ判定') { it.m.at = 6; it.s = [null, 2, 2, 2, 2, 2, 2]; } });
cb2.data = () => D2;
let bad2 = null;
for (let t = 28; t <= 36; t += 0.25) { cb2.state = { t }; const v = cb2.renderVals(); if (bad(v)) bad2 = t; }
cb2.state = { t: 31 }; const vf = cb2.renderVals();
console.log('これから合流（試し）: 壊れた値', bad2 === null ? 'なし' : 't=' + bad2, '／点線○', vf.ghosts.length, '／ログ', JSON.stringify(cb2.renderVals.call(Object.assign(cb2, { state: { t: 33 } })).log.map((l) => l.k)));

// ---------- V ----------
const V = load(__dirname + '/project/Vision.dc.html');
const cv = new V.Component();
const DV = cv.data();
let vbad = null;
const vprob = new Map();
function labelBox(fl) {
  const fsz = +fl.fs, lh = +fl.lh;
  let w = 0; for (const ch of Array.from(fl.n)) w += ch.charCodeAt(0) < 128 ? 0.6 * fsz : fsz;
  return [+fl.x, +fl.y - lh / 2, +fl.x + w, +fl.y + lh / 2];
}
for (const [rot, dim] of [[332, 70], [0, 0], [90, 40], [200, 85]]) {
  for (let t = 0; t <= DV.end + 1e-9; t += 0.25) {
    cv.state = { t, rot, dim };
    const v = cv.renderVals();
    if (!vbad && (bad(v.flags) || bad(v.poles) || bad(v.dots) || bad(v.marks) || bad(v.ghosts))) vbad = 'rot ' + rot + ' dim ' + dim + ' t=' + t;
    // 合流した旗（小さい旗）が、合流先以外の旗と重ならないか
    const fl = v.flags.filter((x) => +x.op > 0.08);
    fl.forEach((a) => {
      const ia = DV.items[a.w];
      if (!ia.m || +a.fs > 13.5) return;
      fl.forEach((b) => {
        if (b.w === a.w || b.w === ia.m.into) return;
        const ib = DV.items[b.w];
        if (ib.m && ib.m.into === ia.m.into) return;
        const ar = ov(labelBox(a), labelBox(b), 1);
        if (ar > 0) {
          const key = 'rot ' + rot + ' dim ' + dim + '：' + ia.n + ' × ' + ib.n;
          const p = vprob.get(key) || { first: t, max: 0 }; p.max = Math.max(p.max, ar); vprob.set(key, p);
        }
      });
    });
  }
}
console.log('V: 壊れた値', vbad || 'なし');
console.log('V: 小さい旗とほかの旗の重なり', vprob.size === 0 ? 'なし' : '');
for (const [k, p] of vprob) console.log('   ', k, '最初 t=' + p.first, '最大', p.max.toFixed(0) + 'px²');
cv.state = { t: 30, rot: 332, dim: 70 };
const vv = cv.renderVals();
DV.items.forEach((it, i) => {
  if (!it.m) return;
  const a = vv.flags[i], p = vv.flags[it.m.into];
  console.log('  V t=30', it.n, '旗', a.x, a.y, 'fs', a.fs, '／合流先', p.x, p.y, '／竿の濃さ', vv.poles[i].op);
});
console.log('V 11/06 の動き', JSON.stringify(vv.log));
