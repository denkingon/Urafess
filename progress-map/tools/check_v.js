// V（のぼり）の既定の向きで、旗どうしの重なりを全部の日付で数える。 node tools/check_v.js
const fs = require('fs');
function load(path) {
  const html = fs.readFileSync(path, 'utf8');
  const m = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>\n([\s\S]*?)\n<\/script>/);
  class DCLogic { constructor() { this.props = {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } forceUpdate() {} }
  return new Function('DCLogic', m[2] + '\nreturn Component;')(DCLogic);
}
function ov(a, b, pad) { const dx = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) - pad, dy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) - pad; return dx > 0 && dy > 0 ? dx * dy : 0; }
function labelBox(fl) { const fsz = +fl.fs, lh = +fl.lh; let w = 0; for (const ch of Array.from(fl.n)) w += ch.charCodeAt(0) < 128 ? 0.6 * fsz : fsz; return [+fl.x, +fl.y - lh / 2, +fl.x + w, +fl.y + lh / 2]; }
const path = process.argv[2] || (__dirname + '/../project/Vision.dc.html');
const V = load(path); const cv = new V(); const DV = cv.data();
const res = new Map();
for (let t = 0; t <= 36.001; t += 0.25) {
  cv.state = { t, rot: 332, dim: 70 }; const v = cv.renderVals();
  const fl = v.flags.filter((x) => +x.op > 0.08);
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    const a = fl[i], b = fl[j], ia = DV.items[a.w], ib = DV.items[b.w];
    if (!ia || !ib) continue;
    if ((ia.m && ia.m.into === b.w) || (ib.m && ib.m.into === a.w) || (ia.m && ib.m && ia.m.into === ib.m.into)) continue;
    const ar = ov(labelBox(a), labelBox(b), 1);
    if (ar > 0) { const k = [ia.n, ib.n].sort().join(' × '); const p = res.get(k) || { first: t, last: t, max: 0 }; p.last = t; p.max = Math.max(p.max, ar); res.set(k, p); }
  }
}
console.log('V 既定の向き：旗どうしの重なり', res.size);
for (const [k, p] of res) console.log('  ', k, 't=' + p.first + '〜' + p.last, '最大', p.max.toFixed(0) + 'px²');
