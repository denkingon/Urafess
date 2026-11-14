(function () {
  "use strict";
  const UR = window.URAJI;
  const DEF = Object.assign({}, UR.DEFAULTS);
  let P = Object.assign({}, DEF);
  const $ = (id) => document.getElementById(id);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const INK = "#f1ede4";
  const VTOP = 900, VBOT = -260, PADL = 260;
  let ss = false, guide = false;

  // ---------- 木から絵へ ----------
  function buildModel(params) {
    const b = UR.build(params);
    const byName = new Map(), byCp = new Map(), kern = new Map();
    for (const g of b.glyphs) { byName.set(g.name, g); for (const u of g.u) byCp.set(u, g); }
    for (const [a, c, v] of b.kern) kern.set(a + "|" + c, v);
    return { b, byName, byCp, kern, geo: b.geo, cache: new Map(), paths: new Map() };
  }
  const pools = new Map();
  function getLayer(w, h) {
    const key = w + "x" + h;
    let pool = pools.get(key); if (!pool) { pool = []; pools.set(key, pool); }
    let L = pool.pop();
    if (!L) { const c = document.createElement("canvas"); c.width = w; c.height = h; L = { c, x: c.getContext("2d") }; }
    L.x.setTransform(1, 0, 0, 1, 0, 0); L.x.globalCompositeOperation = "source-over"; L.x.clearRect(0, 0, w, h);
    return L;
  }
  const putLayer = (L) => pools.get(L.c.width + "x" + L.c.height).push(L);
  const p2 = new WeakMap();
  function path2d(node) {
    let p = p2.get(node); if (p) return p;
    p = new Path2D();
    for (const c of node[1]) {
      if (c[0] === "M") p.moveTo(c[1], c[2]);
      else if (c[0] === "L") p.lineTo(c[1], c[2]);
      else if (c[0] === "C") p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else p.closePath();
    }
    p2.set(node, p); return p;
  }
  function fillPath(L, node, M, op) {
    L.x.setTransform(M); L.x.globalCompositeOperation = op || "source-over";
    L.x.fill(path2d(node));
    L.x.globalCompositeOperation = "source-over"; L.x.setTransform(1, 0, 0, 1, 0, 0);
  }
  function comp(dst, src, op) { dst.x.setTransform(1, 0, 0, 1, 0, 0); dst.x.globalCompositeOperation = op; dst.x.drawImage(src.c, 0, 0); dst.x.globalCompositeOperation = "source-over"; }
  function paint(node, L, M) {
    const t = node[0];
    if (t === "path") { fillPath(L, node, M); return; }
    if (t === "U") {
      for (let i = 1; i < node.length; i++) {
        const ch = node[i];
        if (ch[0] === "path") fillPath(L, ch, M);
        else { const T = getLayer(L.c.width, L.c.height); paint(ch, T, M); comp(L, T, "source-over"); putLayer(T); }
      }
      return;
    }
    if (t === "D" || t === "I") {
      const A = getLayer(L.c.width, L.c.height); paint(node[1], A, M);
      const op = t === "D" ? "destination-out" : "destination-in";
      for (let i = 2; i < node.length; i++) {
        const b = node[i];
        if (b[0] === "path") fillPath(A, b, M, op);
        else { const T = getLayer(L.c.width, L.c.height); paint(b, T, M); comp(A, T, op); putLayer(T); }
      }
      comp(L, A, "source-over"); putLayer(A); return;
    }
    if (t === "X") { const m = node[1]; paint(node[2], L, M.multiply(new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]))); return; }
    if (t === "O") {
      const T = getLayer(L.c.width, L.c.height); paint(node[2], T, M);
      const r = Math.abs(node[1] * M.a);
      L.x.setTransform(1, 0, 0, 1, 0, 0);
      for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; L.x.drawImage(T.c, Math.cos(a) * r, Math.sin(a) * r); }
      L.x.drawImage(T.c, 0, 0); putLayer(T); return;
    }
  }
  function glyphPath(model, g) {
    if (model.paths.has(g.name)) return model.paths.get(g.name);
    let p = null;
    try {
      const mp = window.URAJI_GEOM.outline(g.tree);
      p = new Path2D();
      for (const poly of mp) for (const ring of poly) {
        p.moveTo(ring[0][0], ring[0][1]);
        for (let i = 1; i < ring.length; i++) p.lineTo(ring[i][0], ring[i][1]);
        p.closePath();
      }
    } catch (e) { p = null; }
    model.paths.set(g.name, p);
    return p;
  }
  function drawGlyph(ctx, model, g, x, base, px, color) {
    const p = glyphPath(model, g), s = px / 1000;
    if (p) {
      ctx.save(); ctx.setTransform(s * dpr, 0, 0, -s * dpr, x * dpr, base * dpr);
      ctx.fillStyle = color; ctx.fill(p, "evenodd"); ctx.restore(); return;
    }
    const im = glyphImage(model, g, px, color);
    ctx.drawImage(im.c, (x - PADL * s) * dpr, (base - VTOP * s) * dpr);
  }
  function glyphImage(model, g, px, color) {
    const key = g.name + "|" + px + "|" + color;
    let im = model.cache.get(key); if (im) return im;
    const s = px / 1000 * dpr;
    const w = Math.max(2, Math.ceil((g.adv + PADL * 2) * s)), h = Math.ceil((VTOP - VBOT) * s);
    const L = getLayer(w, h);
    paint(g.tree, L, new DOMMatrix([s, 0, 0, -s, PADL * s, VTOP * s]));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const o = c.getContext("2d"); o.drawImage(L.c, 0, 0);
    o.globalCompositeOperation = "source-in"; o.fillStyle = color; o.fillRect(0, 0, w, h);
    putLayer(L);
    im = { c }; model.cache.set(key, im); return im;
  }

  // ---------- 組む ----------
  function layout(model, str) {
    const out = []; let prev = null;
    for (const ch of str) {
      let g = model.byCp.get(ch.codePointAt(0));
      if (!g) { out.push({ miss: ch }); prev = null; continue; }
      if (ss) { const alt = model.byName.get(g.name + ".ss01"); if (alt) g = alt; }
      const k = prev ? (model.kern.get(prev.name.replace(".ss01", "") + "|" + g.name.replace(".ss01", "")) || 0) : 0;
      out.push({ g, k }); prev = g;
    }
    return out;
  }
  const units = (items) => items.reduce((w, it) => w + (it.g ? it.g.adv + it.k : 600), 0);
  function drawLine(ctx, model, items, x0, base, px, color) {
    let pen = 0;
    for (const it of items) {
      if (!it.g) {
        ctx.save(); ctx.fillStyle = "rgba(160,160,155,.7)"; ctx.font = (px * 0.5 * dpr) + "px system-ui";
        ctx.fillText("□", (x0 + pen * px / 1000) * dpr, (base - px * 0.05) * dpr); ctx.restore(); pen += 600; continue;
      }
      pen += it.k;
      drawGlyph(ctx, model, it.g, x0 + pen * px / 1000, base, px, color);
      pen += it.g.adv;
    }
  }
  function drawGuides(ctx, model, base, px, W) {
    const y = (u) => (base - u * px / 1000) * dpr;
    ctx.save();
    ctx.fillStyle = "rgba(150,150,145,.22)";
    ctx.fillRect(0, y(model.geo.S1), W * dpr, y(model.geo.S0) - y(model.geo.S1));
    ctx.strokeStyle = "rgba(170,170,165,.75)"; ctx.lineWidth = 1 * dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
    for (const u of [0, model.geo.H]) { ctx.beginPath(); ctx.moveTo(0, y(u)); ctx.lineTo(W * dpr, y(u)); ctx.stroke(); }
    ctx.restore();
  }

  let model = buildModel(P);
  function renderStage() {
    const cv = $("stage"), W = cv.clientWidth || 800;
    const lines = $("text").value.split("\n").map((l) => l.trimEnd()).filter((l) => l.length).slice(0, 6);
    if (!lines.length) lines.push("URAFESS");
    const items = lines.map((l) => layout(model, l));
    const maxU = Math.max(1200, ...items.map(units));
    const px = Math.max(28, Math.min(150, Math.floor(W * 1000 / maxU)));
    const lh = Math.round(px * 1.2), H = lines.length * lh + Math.round(px * 0.2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
    items.forEach((it, i) => {
      const base = i * lh + px * 0.95;
      if (guide) drawGuides(ctx, model, base, px, W);
      drawLine(ctx, model, it, 0, base, px, INK);
    });
  }
  function gridGlyphs() {
    return model.b.glyphs.filter((g) => !g.name.endsWith(".ss01") && g.u.length && g.name !== "space" && g.name !== "uni3000")
      .map((g) => (ss && model.byName.get(g.name + ".ss01")) || g);
  }
  function renderGrid() {
    const cv = $("grid"), W = cv.clientWidth || 800;
    const list = gridGlyphs();
    const px = W < 600 ? 40 : 54, cw = Math.round(px * 1.32), ch = Math.round(px * 1.42);
    const cols = Math.max(1, Math.floor(W / cw)), rows = Math.ceil(list.length / cols);
    const H = rows * ch;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
    list.forEach((g, i) => {
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      const base = cy + px * 1.05;
      if (guide) {
        ctx.save(); ctx.fillStyle = "rgba(150,150,145,.18)";
        ctx.fillRect(cx * dpr, (base - model.geo.S1 * px / 1000) * dpr, (cw - 6) * dpr, (model.geo.S1 - model.geo.S0) * px / 1000 * dpr); ctx.restore();
      }
      drawGlyph(ctx, model, g, cx + (cw - g.adv * px / 1000) / 2, base, px, INK);
    });
    $("count").textContent = list.length + " 字";
  }

  // ---------- つまみ ----------
  const knobsEl = $("knobs");
  const groups = {};
  for (const k of UR.KNOBS) {
    if (!groups[k.group]) {
      const g = document.createElement("div"); g.className = "grp";
      g.innerHTML = "<h2>" + k.group + "</h2>"; knobsEl.appendChild(g); groups[k.group] = g;
    }
    const row = document.createElement("div"); row.className = "knob";
    row.innerHTML = '<label for="k_' + k.key + '">' + k.label + '</label><output id="o_' + k.key + '"></output>' +
      '<input type="range" id="k_' + k.key + '" min="' + k.min + '" max="' + k.max + '" step="' + k.step + '">';
    groups[k.group].appendChild(row);
    const input = row.querySelector("input"), label = row.querySelector("label");
    input.addEventListener("input", () => { P[k.key] = parseFloat(input.value); syncKnobs(); schedule(); });
    label.addEventListener("dblclick", () => { P[k.key] = DEF[k.key]; syncKnobs(); schedule(); });
  }
  function syncKnobs() {
    for (const k of UR.KNOBS) {
      $("k_" + k.key).value = P[k.key];
      $("o_" + k.key).textContent = k.fmt(P[k.key]);
      document.querySelector('label[for="k_' + k.key + '"]').classList.toggle("changed", Math.abs(P[k.key] - DEF[k.key]) > 1e-9);
    }
    const g = UR.build(Object.assign({}, P)).geo;
    $("derived").innerHTML =
      "裏 : 表 ＝ " + (P.SLIT / (1 - P.SLIT)).toFixed(3) + " : 1<br>" +
      "線の厚さ ＝ 字の高さの " + (P.T / P.H * 100).toFixed(1) + "%" + (P.T === 0 ? "（線なし＝ベタ）" : "") + "<br>" +
      "線 " + g.S0 + "〜" + g.S1 + " ／ 中間画 " + g.M0 + "〜" + g.M1 + "（単位 1/1000）";
  }

  let raf = 0, gridTimer = 0;
  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; model = buildModel(P); renderStage(); });
    clearTimeout(gridTimer); gridTimer = setTimeout(() => renderGrid(), 160);
  }
  $("text").addEventListener("input", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderStage(); }); });
  $("ss01").addEventListener("change", (e) => { ss = e.target.checked; renderStage(); renderGrid(); });
  $("guide").addEventListener("change", (e) => { guide = e.target.checked; renderStage(); renderGrid(); });
  $("reset").addEventListener("click", () => { P = Object.assign({}, DEF); syncKnobs(); schedule(); });
  let resizeT = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { renderStage(); renderGrid(); }, 120); });

  // ---------- スナップショットと「決める」 ----------
  let db = null, snaps = [], local = false;
  const thumbs = new Map();
  const summary = (p) => "線 " + p.SLIT.toFixed(3) + "/" + Math.round(p.T) + " ・縦 " + Math.round(p.V) + " 横 " + Math.round(p.B) +
    "<br>幅 " + p.WX.toFixed(2) + " ・角 " + Math.round(p.R) + "/" + p.K.toFixed(2) + " ・字間 " + Math.round(p.SB);
  function status(html) { const s = $("status"); s.innerHTML = html; s.classList.toggle("on", !!html); }
  function cleanParams(p) { const o = {}; for (const k of UR.KNOBS) o[k.key] = +p[k.key]; o.H = DEF.H; return o; }
  function renderSnaps() {
    const box = $("snaps"); box.innerHTML = "";
    if (!snaps.length) { box.innerHTML = '<span class="empty">まだない。</span>'; return; }
    for (const s of snaps) {
      const card = document.createElement("div"); card.className = "snap"; card.tabIndex = 0; card.setAttribute("role", "button");
      const cv = document.createElement("canvas");
      const meta = document.createElement("div"); meta.className = "meta";
      meta.innerHTML = summary(Object.assign({}, DEF, s.params));
      const x = document.createElement("button"); x.className = "x"; x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "このスナップショットを消す");
      card.append(cv, meta, x); box.appendChild(card);
      requestAnimationFrame(() => drawThumb(cv, s));
      const apply = () => { P = Object.assign({}, DEF, s.params); syncKnobs(); schedule(); };
      card.addEventListener("click", (e) => { if (e.target !== x) apply(); });
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(); } });
      x.addEventListener("click", (e) => { e.stopPropagation(); removeSnap(s); });
    }
  }
  function drawThumb(cv, s) {
    const W = cv.clientWidth || 170, H = 52;
    cv.width = W * dpr; cv.height = H * dpr;
    let m = thumbs.get(s.id); if (!m) { m = buildModel(Object.assign({}, DEF, s.params)); thumbs.set(s.id, m); }
    const ctx = cv.getContext("2d");
    const items = layout(m, "URA裏");
    const px = Math.min(34, Math.floor((W - 16) * 1000 / units(items)));
    drawLine(ctx, m, items, 8, 26 + px * 0.33, px, INK);
  }
  function saveLocal() { try { localStorage.setItem("uraji-snaps", JSON.stringify(snaps)); } catch (e) { /* 保存できない環境 */ } }
  function loadLocal() { try { snaps = JSON.parse(localStorage.getItem("uraji-snaps") || "[]"); } catch (e) { snaps = []; } renderSnaps(); }
  async function addSnap() {
    const s = { params: cleanParams(P), at: new Date().toISOString() };
    if (db && !local) {
      try { await db.collection("snapshots").add(s); return; } catch (e) { local = true; }
    }
    s.id = "l" + Date.now(); snaps.unshift(s); snaps = snaps.slice(0, 24); saveLocal(); renderSnaps();
  }
  async function removeSnap(s) {
    if (db && !local && !s.id.startsWith("l")) { try { await db.doc("snapshots/" + s.id).delete(); return; } catch (e) { /* 下で消す */ } }
    snaps = snaps.filter((t) => t !== s); saveLocal(); renderSnaps();
  }
  async function decide() {
    const d = { params: cleanParams(P), at: new Date().toISOString() };
    const btn = $("decide"); btn.disabled = true;
    if (db && !local) {
      try {
        await db.doc("decision/current").set(d);
        status("この値をこのページに保存した。チャットで「決めた」と送れば、この値で書体を作り直す。");
        btn.disabled = false; return;
      } catch (e) { /* 下の写しへ */ }
    }
    const json = JSON.stringify(d.params);
    status('このページに保存できなかった。下の値をコピーしてチャットに貼れば、この値で作り直す。<button type="button" id="copy" style="margin-left:8px">コピー</button><pre>' + json + "</pre>");
    $("copy").addEventListener("click", () => { navigator.clipboard.writeText(json).then(() => { $("copy").textContent = "コピーした"; }, () => { $("copy").textContent = "選んでコピーして"; }); });
    btn.disabled = false;
  }
  $("snap").addEventListener("click", addSnap);
  $("decide").addEventListener("click", decide);

  function connect() {
    let done = false;
    const timer = setTimeout(() => { if (!done) { local = true; loadLocal(); } }, 10000);
    db.collection("snapshots").orderBy("at", "desc").limit(24).onSnapshot((q) => {
      done = true; clearTimeout(timer); local = false;
      snaps = q.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      renderSnaps();
    }, () => { done = true; clearTimeout(timer); local = true; loadLocal(); });
    db.doc("decision/current").onSnapshot((d) => {
      if (d.exists && !$("status").classList.contains("on")) {
        const v = d.data();
        status('最後に決めた値（' + new Date(v.at).toLocaleString("ja-JP") + '）：' + summary(Object.assign({}, DEF, v.params)).replace("<br>", " ・") +
          ' <button type="button" id="loaddec" style="margin-left:8px">この値を読み込む</button>');
        $("loaddec").addEventListener("click", () => { P = Object.assign({}, DEF, v.params); syncKnobs(); schedule(); });
      }
    }, () => {});
  }
  (async () => {
    try { if (window.claude && typeof window.claude.use === "function") db = await window.claude.use("db"); } catch (e) { db = null; }
    if (db) connect(); else { local = true; loadLocal(); }
  })();

  syncKnobs();
  renderStage();
  renderGrid();
})();
