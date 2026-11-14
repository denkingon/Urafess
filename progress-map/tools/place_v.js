// V（のぼり）の旗が重ならない地面の位置（g）を、いまの位置の近くから探す。 node tools/place_v.js 名前 名前 …
const fs = require('fs');
function load(path) {
  const html = fs.readFileSync(path, 'utf8');
  const m = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>\n([\s\S]*?)\n<\/script>/);
  class DCLogic { constructor() { this.props = {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } forceUpdate() {} }
  return new Function('DCLogic', m[2] + '\nreturn Component;')(DCLogic);
}
function ov(a, b, pad) { const dx = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) - pad, dy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) - pad; return dx > 0 && dy > 0 ? dx * dy : 0; }
function labelBox(fl) { const fsz = +fl.fs, lh = +fl.lh; let w = 0; for (const ch of Array.from(fl.n)) w += ch.charCodeAt(0) < 128 ? 0.6 * fsz : fsz; return [+fl.x - 3, +fl.y - lh / 2 - 2, +fl.x + w + 3, +fl.y + lh / 2 + 2]; }
const V = load(__dirname + '/../project/Vision.dc.html');
const cv = new V(); const D2 = JSON.parse(JSON.stringify(cv.data())); cv.data = () => D2;
const T = [7, 15, 28, 29, 30, 31, 33, 35, 36, 38, 40, 42];
function score(wi) {
  let tot = 0;
  for (const t of T) {
    cv.state = { t, rot: 332, dim: 70 }; const v = cv.renderVals();
    const a = v.flags[wi]; if (+a.op < 0.08) continue;
    const ia = D2.items[wi];
    v.flags.forEach((b, j) => {
      if (j === wi || +b.op < 0.08) return;
      const ib = D2.items[j];
      if ((ia.m && ia.m.into === j) || (ib.m && ib.m.into === wi) || (ia.m && ib.m && ia.m.into === ib.m.into)) return;
      tot += ov(labelBox(a), labelBox(b), 0);
    });
  }
  return tot;
}
const order = process.argv.slice(2);  // 置き場所を探す件の名前（data.py の n）
for (const name of order) {
  const wi = D2.items.findIndex((i) => i.n === name); const g0 = D2.items[wi].g.slice();
  const s0 = score(wi);
  let best = { g: g0, d: 0, sc: s0 };
  if (s0 > 0) {
    best = null;
    for (let dx = -0.45; dx <= 0.4501; dx += 0.03) for (let dy = -0.45; dy <= 0.4501; dy += 0.03) {
      const g = [+(g0[0] + dx).toFixed(2), +(g0[1] + dy).toFixed(2)];
      if (Math.abs(g[0]) > 0.95 || Math.abs(g[1]) > 0.95) continue;
      D2.items[wi].g = g; const sc = score(wi), d = Math.hypot(dx, dy);
      if (!best || sc < best.sc - 1e-6 || (Math.abs(sc - best.sc) < 1e-6 && d < best.d)) best = { g, d, sc };
    }
  }
  D2.items[wi].g = best.g;
  console.log(name, JSON.stringify(g0), '→', JSON.stringify(best.g), '重なり', s0.toFixed(0), '→', best.sc.toFixed(0));
}
