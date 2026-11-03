/* 字形の木を多角形の演算で解く（ブラウザ・Node 共通）。継ぎ目のない輪郭を得るため。 */
(function (root) {
  "use strict";
  const PC = root.polygonClipping || (typeof require !== "undefined" ? require("polygon-clipping") : null);
  const mul = (M, m) => [M[0] * m[0] + M[2] * m[1], M[1] * m[0] + M[3] * m[1], M[0] * m[2] + M[2] * m[3], M[1] * m[2] + M[3] * m[3],
    M[0] * m[4] + M[2] * m[5] + M[4], M[1] * m[4] + M[3] * m[5] + M[5]];
  const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  function area(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function flatten(node, M) {
    const out = []; let ring = null, cx = 0, cy = 0;
    const push = () => { if (ring && ring.length > 2 && Math.abs(area(ring)) > 0.5) out.push([ring]); ring = null; };
    for (const c of node[1]) {
      if (c[0] === "M") { push(); ring = [ap(M, c[1], c[2])]; cx = c[1]; cy = c[2]; }
      else if (c[0] === "L") { ring.push(ap(M, c[1], c[2])); cx = c[1]; cy = c[2]; }
      else if (c[0] === "C") {
        const N = 10;
        for (let i = 1; i <= N; i++) {
          const t = i / N, u = 1 - t;
          const x = u * u * u * cx + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5];
          const y = u * u * u * cy + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
          ring.push(ap(M, x, y));
        }
        cx = c[5]; cy = c[6];
      } else push();
    }
    push();
    return out;
  }
  function geom(node, M) {
    const t = node[0];
    if (t === "path") return flatten(node, M);
    if (t === "U") { const gs = node.slice(1).map((ch) => geom(ch, M)).filter((g) => g.length); return !gs.length ? [] : gs.length === 1 ? gs[0] : PC.union(...gs); }
    if (t === "D") { const a = geom(node[1], M); if (!a.length) return []; const bs = node.slice(2).map((b) => geom(b, M)).filter((g) => g.length); return bs.length ? PC.difference(a, ...bs) : a; }
    if (t === "I") { const a = geom(node[1], M), b = geom(node[2], M); return a.length && b.length ? PC.intersection(a, b) : []; }
    if (t === "X") return geom(node[2], mul(M, node[1]));
    if (t === "O") {
      const a = geom(node[2], M); if (!a.length) return [];
      const e = node[1] * Math.hypot(M[0], M[1]), copies = [a];
      for (let k = 0; k < 12; k++) { const g = k / 12 * Math.PI * 2, dx = Math.cos(g) * e, dy = Math.sin(g) * e; copies.push(a.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy])))); }
      return PC.union(...copies);
    }
    throw new Error("unknown op " + t);
  }
  const api = { outline: (tree) => geom(tree, [1, 0, 0, 1, 0, 0]) };
  root.URAJI_GEOM = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
