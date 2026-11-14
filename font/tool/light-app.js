(function () {
  "use strict";
  const UR = window.URAJI, GEO = window.URAJI_GEOM;
  const $ = (id) => document.getElementById(id);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const B = UR.build({});
  const byCp = new Map(), byName = new Map(), kern = new Map();
  for (const g of B.glyphs) { byName.set(g.name, g); for (const u of g.u) byCp.set(u, g); }
  for (const [a, c, v] of B.kern) kern.set(a + "|" + c, v);
  const H = B.geo.H, LINE = (B.geo.S0 + B.geo.S1) / 2;
  const outl = new Map();
  function outline(g) {
    if (!outl.has(g.name)) {
      let mp = [];
      try { mp = GEO.outline(g.tree); } catch (e) { mp = []; }
      let per = 0;
      for (const poly of mp) for (const r of poly) for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
      outl.set(g.name, { mp, per });
    }
    return outl.get(g.name);
  }
  function inside(mp, x, y) {
    let c = false;
    for (const poly of mp) for (const r of poly) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
    }
    return c;
  }
  function layout(str) {
    const out = []; let prev = null, pen = 0;
    for (const ch of str) {
      const g = byCp.get(ch.codePointAt(0));
      if (!g) { pen += 600; prev = null; continue; }
      pen += prev ? (kern.get(prev.name + "|" + g.name) || 0) : 0;
      out.push({ g, x: pen }); pen += g.adv; prev = g;
    }
    return { items: out, w: pen };
  }
  const val = (id) => parseFloat($(id).value);
  const color = () => document.querySelector('input[name="col"]:checked').value;
  function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }
  function lighten(hex) { const n = parseInt(hex.slice(1), 16); const m = (c) => Math.round(c + (255 - c) * 0.55); return "rgb(" + m(n >> 16) + "," + m((n >> 8) & 255) + "," + m(n & 255) + ")"; }

  function prep(cv) {
    const lines = $("text").value.split("\n").map((l) => l.trimEnd()).filter((l) => l.length).slice(0, 4);
    if (!lines.length) lines.push("URAFESS");
    const L = lines.map(layout);
    const W = cv.clientWidth || 800;
    const maxU = Math.max(1400, ...L.map((l) => l.w));
    const px = Math.max(30, Math.min(170, Math.floor(W * 1000 / maxU)));
    const lh = Math.round(px * 1.25), Hh = L.length * lh + Math.round(px * 0.25);
    return { L, W, px, lh, Hh };
  }
  function blit(cv, off, W, Hh) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); cv.style.height = Hh + "px";
    const ctx = cv.getContext("2d");
    const d = val("dist");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.filter = d > 0 ? "blur(" + (d * 0.9 * dpr) + "px)" : "none";
    ctx.globalAlpha = 1 - d * 0.035;
    ctx.drawImage(off, 0, 0);
    ctx.filter = "none"; ctx.globalAlpha = 1;
  }
  function renderOutline() {
    const cv = $("cvO"), { L, W, px, lh, Hh } = prep(cv);
    const off = document.createElement("canvas"); off.width = Math.round(W * dpr); off.height = Math.round(Hh * dpr);
    const x = off.getContext("2d");
    const col = color(), s = px / 1000, tube = val("tube"), bloom = val("bloom");
    let per = 0;
    L.forEach((ln, i) => {
      const base = i * lh + px * 0.98;
      for (const it of ln.items) {
        const o = outline(it.g); per += o.per;
        const p = new Path2D();
        for (const poly of o.mp) for (const r of poly) { p.moveTo(r[0][0], r[0][1]); for (let k = 1; k < r.length; k++) p.lineTo(r[k][0], r[k][1]); p.closePath(); }
        const passes = [[2.6, 0.18, bloom * 1.6, col], [1.5, 0.45, bloom * 0.7, col], [1, 1, bloom * 0.25, col], [0.42, 0.9, 0, lighten(col)]];
        for (const [wm, a, blur, c] of passes) {
          x.save();
          x.setTransform(s * dpr, 0, 0, -s * dpr, it.x * s * dpr, base * dpr);
          x.lineWidth = tube * wm; x.lineJoin = "round"; x.lineCap = "round";
          x.strokeStyle = typeof c === "string" && c[0] === "#" ? rgba(c, a) : c;
          x.globalAlpha = c[0] === "#" ? 1 : a;
          if (blur > 0) { x.shadowColor = rgba(col, 0.9); x.shadowBlur = blur * dpr; }
          x.stroke(p); x.restore();
        }
      }
    });
    blit(cv, off, W, Hh);
    const h = val("hO"), m = per * h / H;
    $("figO").innerHTML = "LEDテープ 約 <b>" + (m < 10 ? m.toFixed(1) : Math.round(m)) + " m</b>（字の高さ " + h.toFixed(1) + " m で、輪郭を全部一周）";
  }
  function renderDots() {
    const cv = $("cvD"), { L, W, px, lh, Hh } = prep(cv);
    const off = document.createElement("canvas"); off.width = Math.round(W * dpr); off.height = Math.round(Hh * dpr);
    const x = off.getContext("2d");
    const col = color(), s = px / 1000, rows = val("rows"), pitch = H / rows, rad = val("dot") * pitch / 2;
    const lineRow = $("lineRow").checked ? Math.floor(LINE / pitch) : null;
    let n = 0;
    x.fillStyle = col; x.shadowColor = rgba(col, 0.85);
    L.forEach((ln, i) => {
      const base = i * lh + px * 0.98;
      const cols = Math.ceil(ln.w / pitch) + 1;
      for (let r = Math.floor(-160 / pitch); r * pitch < 820; r++) {
        if (r === lineRow) continue;
        const yc = (r + 0.5) * pitch;
        for (let c = 0; c < cols; c++) {
          const xc = (c + 0.5) * pitch;
          let lit = false;
          for (const it of ln.items) {
            if (xc < it.x - 300 || xc > it.x + it.g.adv + 300) continue;
            if (inside(outline(it.g).mp, xc - it.x, yc)) { lit = true; break; }
          }
          if (!lit) continue;
          n++;
          const X = xc * s * dpr, Y = (base - yc * s) * dpr, R = Math.max(0.6, rad * s * dpr);
          x.shadowBlur = R * 2.2;
          x.beginPath(); x.arc(X, Y, R, 0, Math.PI * 2); x.fill();
        }
      }
    });
    blit(cv, off, W, Hh);
    const h = val("hD"), gap = h / rows;
    $("figD").innerHTML = "光の点 <b>" + n + "</b> 個 ＝ スマホ " + n + " 台／提灯 " + n + " 個。点の間隔 " + gap.toFixed(2) + " m（字の高さ " + h.toFixed(1) + " m のとき）";
  }

  const outs = { dist: (v) => v === 0 ? "近い" : (v < 4 ? "少し離れる" : v < 7 ? "離れる" : "遠い"), tube: (v) => v + "", bloom: (v) => v + "", hO: (v) => v.toFixed(1) + " m", rows: (v) => v + " 段", dot: (v) => Math.round(v * 100) + "%", hD: (v) => v.toFixed(1) + " m" };
  function sync() { for (const k in outs) $("o_" + k).textContent = outs[k](val(k)); }
  let raf = 0;
  function schedule() { sync(); if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderOutline(); renderDots(); }); }
  for (const id of ["dist", "tube", "bloom", "hO", "rows", "dot", "hD"]) $(id).addEventListener("input", schedule);
  for (const r of document.querySelectorAll('input[name="col"]')) r.addEventListener("change", schedule);
  $("lineRow").addEventListener("change", schedule);
  $("text").addEventListener("input", schedule);
  let rt = 0; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(schedule, 120); });
  schedule();
})();
