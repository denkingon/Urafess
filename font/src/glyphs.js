/*
 * URAJI（裏字）— 字形の正本
 * すべての字は、統一層 P のつまみから組み立てる「演算の木」として書く。
 *   ["path", cmds]           cmds: ["M",x,y] ["L",x,y] ["C",x1,y1,x2,y2,x,y] ["Z"]
 *   ["U", ...]  和   ["D", a, ...b]  差   ["I", a, b]  積   ["X", [a,b,c,d,e,f], node]  変形
 * ブラウザ（つまみの道具）は木を canvas で描き、フォントの生成は木を Python（pathops）で読む。
 * 同じ木から作るので、道具で見た形とフォントの形は一致する。
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    H: 700,      // 大文字の高さ
    V: 160,      // 縦画の太さ
    B: 136,      // 横画の太さ
    R: 190,      // 丸い角の外半径
    K: 0.60,     // 角の張り（0.55≒円弧。大きいほど四角寄り）
    SLIT: 0.618, // 線（切れ目）の中心の高さ。H に対する比
    T: 40,       // 線の厚さ（0 で線なし＝ベタ）
    SB: 62,      // 縦画側の字間
    WX: 1.0,     // 字幅の倍率（英数字のみ）
  };

  const KNOBS = [
    { key: "SLIT", label: "線の高さ", group: "線", min: 0.50, max: 0.74, step: 0.001, fmt: (v) => v.toFixed(3) },
    { key: "T", label: "線の厚さ", group: "線", min: 0, max: 90, step: 1, fmt: (v) => String(Math.round(v)) },
    { key: "V", label: "縦画の太さ", group: "骨", min: 100, max: 210, step: 1, fmt: (v) => String(Math.round(v)) },
    { key: "B", label: "横画の太さ", group: "骨", min: 90, max: 176, step: 1, fmt: (v) => String(Math.round(v)) },
    { key: "WX", label: "字幅", group: "骨", min: 0.82, max: 1.24, step: 0.01, fmt: (v) => v.toFixed(2) },
    { key: "R", label: "角の半径", group: "角", min: 0, max: 280, step: 1, fmt: (v) => String(Math.round(v)) },
    { key: "K", label: "角の張り", group: "角", min: 0.50, max: 0.82, step: 0.01, fmt: (v) => v.toFixed(2) },
    { key: "SB", label: "字間", group: "字間", min: 20, max: 120, step: 1, fmt: (v) => String(Math.round(v)) },
  ];

  const KERN = [
    ["L", "T", -70], ["L", "V", -50], ["L", "Y", -60], ["L", "W", -34], ["L", "quotesingle", -70], ["L", "quotedbl", -70], ["L", "O", -16],
    ["T", "A", -24], ["T", "comma", -70], ["T", "period", -70], ["T", "J", -44], ["T", "hyphen", -40],
    ["F", "A", -24], ["F", "comma", -60], ["F", "period", -60], ["F", "J", -44],
    ["P", "A", -24], ["P", "comma", -60], ["P", "period", -60], ["P", "J", -44],
    ["V", "comma", -60], ["V", "period", -60], ["W", "comma", -50], ["W", "period", -50], ["Y", "comma", -64], ["Y", "period", -64],
    ["V", "A", -16], ["W", "A", -12], ["Y", "A", -18], ["A", "T", -24], ["A", "V", -16], ["A", "W", -12], ["A", "Y", -18],
    ["R", "T", -16], ["R", "V", -20], ["R", "W", -14], ["R", "Y", -24],
    ["K", "O", -22], ["K", "C", -22], ["K", "G", -22], ["K", "Q", -22], ["X", "O", -16],
    ["seven", "period", -60], ["seven", "comma", -60],
  ];

  // ---------- 演算の木 ----------
  const U = (...ps) => ["U", ...ps.filter(Boolean)];
  const D = (a, ...bs) => ["D", a, ...bs.filter(Boolean)];
  const I = (a, b) => ["I", a, b];
  const X = (m, a) => ["X", m, a];
  const O = (a, e) => ["O", e, a];       // 太らせる（輪郭を e だけ外へ）
  const EMPTY = ["U"];

  function rect(x0, y0, x1, y1) {
    return ["path", [["M", x0, y0], ["L", x1, y0], ["L", x1, y1], ["L", x0, y1], ["Z"]]];
  }
  function poly(pts) {
    const c = [["M", pts[0][0], pts[0][1]]];
    for (let i = 1; i < pts.length; i++) c.push(["L", pts[i][0], pts[i][1]]);
    c.push(["Z"]);
    return ["path", c];
  }
  function mirrorX(node, w) { return X([-1, 0, 0, 1, w, 0], node); }
  function mirrorY(node, h) { return X([1, 0, 0, -1, 0, h], node); }
  function scaleAt(node, s, cx, cy) { return X([s, 0, 0, s, cx - s * cx, cy - s * cy], node); }
  function move(node, dx, dy) { return X([1, 0, 0, 1, dx, dy], node); }

  function build(params) {
    const P = Object.assign({}, DEFAULTS, params || {});
    const H = P.H, V = P.V, B = P.B, R = P.R, T = P.T, K = P.K, WX = P.WX;
    const S0 = Math.round(H * P.SLIT - T / 2);   // 線の下端
    const S1 = S0 + T;                           // 線の上端
    const M1 = S0;                               // 中間画の上端＝線の下端
    const M0 = M1 - B;                           // 中間画の下端
    const SB = P.SB;
    const st = SB, rd = Math.round(SB * 0.8), dg = Math.round(SB * 0.35), tb = Math.round(SB * 0.5);
    const Rs = Math.min(170, R);                 // S・2 の背骨の角
    const ww = (w) => Math.round(w * WX);

    function rr(x0, y0, x1, y1, tl = 0, tr = 0, br = 0, bl = 0, k = K) {
      const w = x1 - x0, h = y1 - y0;
      const r2 = (r) => {
        let rx, ry;
        if (Array.isArray(r)) { rx = r[0]; ry = r[1]; } else { rx = r; ry = r; }
        rx = Math.max(0, Math.min(rx, w / 2)); ry = Math.max(0, Math.min(ry, h / 2));
        return (rx < 1 || ry < 1) ? [0, 0] : [rx, ry];
      };
      const [tlx, tly] = r2(tl), [trx, try_] = r2(tr), [brx, bry] = r2(br), [blx, bly] = r2(bl);
      const c = [["M", x0 + blx, y0], ["L", x1 - brx, y0]];
      if (brx) c.push(["C", x1 - brx + k * brx, y0, x1, y0 + bry - k * bry, x1, y0 + bry]);
      c.push(["L", x1, y1 - try_]);
      if (trx) c.push(["C", x1, y1 - try_ + k * try_, x1 - trx + k * trx, y1, x1 - trx, y1]);
      c.push(["L", x0 + tlx, y1]);
      if (tlx) c.push(["C", x0 + tlx - k * tlx, y1, x0, y1 - tly + k * tly, x0, y1 - tly]);
      c.push(["L", x0, y0 + bly]);
      if (blx) c.push(["C", x0, y0 + bly - k * bly, x0 + blx - k * blx, y0, x0 + blx, y0]);
      c.push(["Z"]);
      return ["path", c];
    }
    function ring(x0, y0, x1, y1, tl = 0, tr = 0, br = 0, bl = 0, v = V, b = B) {
      const inn = (r) => {
        let rx, ry;
        if (Array.isArray(r)) { rx = r[0]; ry = r[1]; } else { rx = r; ry = r; }
        if (rx <= 0 || ry <= 0) return 0;
        return [Math.max(rx - v, 0), Math.max(ry - b, 0)];
      };
      return D(rr(x0, y0, x1, y1, tl, tr, br, bl), rr(x0 + v, y0 + b, x1 - v, y1 - b, inn(tl), inn(tr), inn(br), inn(bl)));
    }
    function diag(xa, ya, xb, yb, t) {
      const dx = xb - xa, dy = yb - ya;
      const s = Math.abs(dy) / Math.max(Math.hypot(dx, dy), 1e-6);
      const w = t / Math.max(s, 0.2);
      return poly([[xa - w / 2, ya], [xa + w / 2, ya], [xb + w / 2, yb], [xb - w / 2, yb]]);
    }

    const G = [];            // {name, u, w, l, r, tree, abs, notch}
    const byName = {};
    function add(name, u, w, l, r, tree, opt = {}) {
      const ymin = opt.ymin ?? 0, ymax = opt.ymax ?? H;
      if (opt.clip !== false) tree = I(tree, rect(0, ymin, w, ymax));
      const g = { name, u, w, l, r, tree, abs: false, notch: opt.notch || [] };
      G.push(g); byName[name] = g; return g;
    }
    function addabs(name, u, adv, tree, opt = {}) {
      const g = { name, u, w: adv, l: 0, r: 0, tree, abs: true, notch: opt.notch || [] };
      G.push(g); byName[name] = g; return g;
    }
    const lowerNotch = (yLo, yHi) => { const mid = (yLo + yHi) / 2; return rect(-1, mid - T / 2, V + 1, mid + T / 2); };

    // ===== 英字 =====
    let W = ww(540);
    add("A", [0x41, 0x61], W, st, st, U(D(rr(0, 0, W, H, R, R), rr(V, -10, W - V, H - B, [R - V, R - B], [R - V, R - B])), rect(V - 2, M0, W - V + 2, M1)));

    W = ww(520);
    add("B", [0x42, 0x62], W, st, rd, U(ring(0, M0, W - 24, H, 0, R, R, 0), ring(0, 0, W, M1, 0, R, R, 0)), { notch: [lowerNotch(B, M0)] });

    W = ww(520);
    add("C", [0x43, 0x63], W, rd, tb, D(ring(0, 0, W, H, R, R, R, R), rect(W - V - 2, R, W + 2, H - R)));

    W = ww(540);
    add("D", [0x44, 0x64], W, st, rd, ring(0, 0, W, H, 0, R, R, 0));

    W = ww(470);
    add("E", [0x45, 0x65], W, st, tb, U(rect(0, 0, V, H), rect(0, H - B, W, H), rect(0, M0, W - 34, M1), rect(0, 0, W, B)));

    W = ww(450);
    add("F", [0x46, 0x66], W, st, tb, U(rect(0, 0, V, H), rect(0, H - B, W, H), rect(0, M0, W - 34, M1)));

    W = ww(540);
    add("G", [0x47, 0x67], W, rd, rd, U(D(ring(0, 0, W, H, R, R, R, R), rect(W - V - 2, M1, W + 2, H - R)), rect(W * 0.47, M0, W, M1)));

    W = ww(540);
    add("H", [0x48, 0x68], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), rect(V - 1, M0, W - V + 1, M1)));

    W = V;
    add("I", [0x49, 0x69], W, st, st, rect(0, 0, V, H));

    W = ww(470);
    add("J", [0x4A, 0x6A], W, tb, st, D(D(rr(0, 0, W, H, 0, 0, R, R), rr(V, B, W - V, H + 60, 0, 0, [R - V, R - B], [R - V, R - B])), rect(-1, 250, V + 1, H + 1)));

    W = ww(540);
    add("K", [0x4B, 0x6B], W, st, dg, U(rect(0, 0, V, H), diag(V - 10, 250, W - 78, H + 40, 152), diag(V + 118, 360, W - 78, -40, 168)));

    W = ww(440);
    add("L", [0x4C, 0x6C], W, st, tb, U(rect(0, 0, V, H), rect(0, 0, W, B)));

    W = ww(690);
    add("M", [0x4D, 0x6D], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), diag(V * 0.45, H + 20, W / 2, 170, 148), diag(W - V * 0.45, H + 20, W / 2, 170, 148)));

    W = ww(560);
    add("N", [0x4E, 0x6E], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), diag(V * 0.42, H + 30, W - V * 0.42, -30, 158)));

    W = ww(560);
    add("O", [0x4F, 0x6F], W, rd, rd, ring(0, 0, W, H, R, R, R, R));

    W = ww(510);
    add("P", [0x50, 0x70], W, st, rd, U(rect(0, 0, V, H), ring(0, M0, W, H, 0, R, R, 0)));

    W = ww(560);
    add("Q", [0x51, 0x71], W, rd, rd, I(U(ring(0, 0, W, H, R, R, R, R), diag(W * 0.60, 230, W + 18, -95, 150)), rect(0, -95, W + 30, H)), { clip: false });

    W = ww(530);
    add("R", [0x52, 0x72], W, st, dg, U(rect(0, 0, V, H), ring(0, M0, W - 22, H, 0, R, R, 0), diag(W * 0.50, M0 + 70, W - 84, -40, 166)));

    W = ww(510);
    {
      const up = D(ring(0, M0, W, H, R, 0, 0, Rs), rect(V, M1, W + 1, H - B), rect(W - Rs, M0 - 1, W + 1, M1));
      const lo = D(ring(0, 0, W, M1, 0, Rs, R, 0), rect(-1, B, W - V, M0), rect(-1, M0 - 1, Rs, M1 + 1));
      add("S", [0x53, 0x73], W, rd, rd, U(up, lo));
    }

    W = ww(520);
    add("T", [0x54, 0x74], W, tb, tb, U(rect(0, H - B, W, H), rect(W / 2 - V / 2, 0, W / 2 + V / 2, H)));

    W = ww(540);
    add("U", [0x55, 0x75], W, st, st, D(rr(0, 0, W, H, 0, 0, R, R), rr(V, B, W - V, H + 60, 0, 0, [R - V, R - B], [R - V, R - B])));

    W = ww(570);
    add("V", [0x56, 0x76], W, dg, dg, U(diag(V * 0.5, H + 20, W / 2 - 6, -10, 158), diag(W - V * 0.5, H + 20, W / 2 + 6, -10, 158)));

    W = ww(840);
    add("W", [0x57, 0x77], W, dg, dg, U(diag(80, H + 20, W * 0.285, -10, 150), diag(W / 2 - 4, 590, W * 0.285, -10, 142),
      diag(W / 2 + 4, 590, W * 0.715, -10, 142), diag(W - 80, H + 20, W * 0.715, -10, 150)));

    W = ww(570);
    add("X", [0x58, 0x78], W, dg, dg, U(diag(78, H + 20, W - 78, -20, 156), diag(W - 78, H + 20, 78, -20, 156)));

    W = ww(570);
    add("Y", [0x59, 0x79], W, dg, dg, U(diag(80, H + 30, W / 2, 280, 156), diag(W - 80, H + 30, W / 2, 280, 156), rect(W / 2 - V / 2, 0, W / 2 + V / 2, 330)));

    W = ww(500);
    add("Z", [0x5A, 0x7A], W, tb, tb, U(rect(0, H - B, W, H), rect(0, 0, W, B), diag(W - 92, H - B + 4, 92, B - 4, 166)));

    // ===== 数字（等幅） =====
    const WD = ww(480), DADV = ww(600), DSB = (DADV - WD) / 2;
    add("zero", [0x30], WD, DSB, DSB, ring(0, 0, WD, H, R, R, R, R));
    add("one", [0x31], WD, DSB, DSB, U(rect(WD * 0.417, 0, WD * 0.417 + V, H), diag(WD * 0.52, H, 55, H - 220, 128)));
    add("two", [0x32], WD, DSB, DSB, U(D(ring(0, M0, WD, H, R, R, Rs, 0), rect(-1, M1, WD - V, H - B)), rect(0, 0, V, M1), rect(0, 0, WD, B)));
    add("three", [0x33], WD, DSB, DSB, U(D(ring(0, 0, WD, H, 0, R, R, 0), rect(-1, B, WD - V, H - B)), rect(WD * 0.30, M0, WD - V + 1, M1)));
    add("four", [0x34], WD, DSB, DSB, U(rect(WD - V - 26, 0, WD - 26, H), rect(0, 150, WD, 150 + B), rect(0, 150, V, H)));
    add("five", [0x35], WD, DSB, DSB, U(rect(0, M0, V, H), rect(0, H - B, WD, H), D(ring(0, 0, WD, M1, 0, R, R, 0), rect(-1, B, WD - V, M0))));
    add("six", [0x36], WD, DSB, DSB, U(ring(0, 0, WD, M1, 0, R, R, R), D(rr(0, M0, WD, H, R), rr(V, M0 - 10, WD + 60, H - B, [R - V, R - B]))), { notch: [lowerNotch(B, M0)] });
    add("seven", [0x37], WD, DSB, DSB, U(rect(0, H - B, WD, H), diag(WD - 92, H - B + 6, WD * 0.30, -20, 164)));
    add("eight", [0x38], WD, DSB, DSB, U(ring(14, M0, WD - 14, H, R, R, R, R), ring(0, 0, WD, M1, R, R, R, R)), { notch: [lowerNotch(B, M0)] });
    add("nine", [0x39], WD, DSB, DSB, U(ring(0, M0, WD, H, R, R, 0, R), D(rr(0, 0, WD, M1, 0, 0, R, 0), rr(-60, B, WD - V, M1 + 60, 0, 0, [R - V, R - B], 0))));

    // ===== 記号 =====
    const DOT = 150;
    add("space", [0x20, 0xA0], 0, 130, 130, EMPTY, { clip: false });
    add("period", [0x2E], V, st, st, rect(0, 0, V, DOT));
    add("comma", [0x2C], V, st, st, I(U(rect(0, 0, V, DOT), poly([[46, 1], [V, 1], [40, -170], [-70, -170]])), rect(-70, -170, V, DOT)), { clip: false });
    add("colon", [0x3A], V, st, st, U(rect(0, 150, V, 290), rect(0, S1, V, S1 + 140)));
    add("semicolon", [0x3B], V, st, st, I(U(rect(0, S1, V, S1 + 140), rect(0, 150, V, 290), poly([[46, 151], [V, 151], [40, -60], [-70, -60]])), rect(-70, -60, V, H)), { clip: false });
    add("periodcentered", [0xB7, 0x2022, 0x2027], V, st, st, rect(0, M1 - 140, V, M1));
    add("hyphen", [0x2D, 0x2010, 0x2011], 300, dg, dg, rect(0, M0, 300, M1));
    add("endash", [0x2013], 520, dg, dg, rect(0, M0, 520, M1));
    add("emdash", [0x2014], 880, dg, dg, rect(0, M0, 880, M1));
    add("exclam", [0x21], V, st, st, U(rect(0, 230, V, H), rect(0, 0, V, DOT)));
    W = 470;
    add("question", [0x3F], W, dg, rd, U(D(ring(0, M0, W, H, R, R, R, 0), rect(-1, M0 - 1, (W - V) / 2, H - B)), rect((W - V) / 2, 230, (W + V) / 2, M0 + 2), rect((W - V) / 2, 0, (W + V) / 2, DOT)));
    add("quotesingle", [0x27, 0x2019, 0x2018], 130, st, st, rect(0, 480, 130, H));
    add("quotedbl", [0x22, 0x201C, 0x201D], 330, st, st, U(rect(0, 480, 130, H), rect(200, 480, 330, H)));
    W = 250;
    const paren = D(rr(0, -100, W, 800, [210, 220], 0, 0, [210, 220]), rr(128, 12, W + 80, 688, [82, 108], 0, 0, [82, 108]));
    add("parenleft", [0x28], W, rd, dg, paren, { ymin: -100, ymax: 800 });
    add("parenright", [0x29], W, dg, rd, mirrorX(paren, W), { ymin: -100, ymax: 800 });
    add("slash", [0x2F], 430, dg, dg, diag(70, -100, 360, 800, 140), { ymin: -100, ymax: 800 });
    add("plus", [0x2B], 480, dg, dg, U(rect(0, M0, 480, M1), rect(172, 110, 308, 580)));
    add("equal", [0x3D], 480, dg, dg, U(rect(0, 200, 480, 310), rect(0, S1, 480, S1 + 110)));
    add("multiply", [0xD7], 480, dg, dg, U(diag(70, 600, 410, 90, 128), diag(410, 600, 70, 90, 128)));
    add("numbersign", [0x23], 580, dg, dg, U(diag(150, 0, 230, H, 118), diag(350, 0, 430, H, 118), rect(0, 150, 580, 258), rect(0, S1, 580, S1 + 108)));
    W = 640;
    {
      const cy = (M0 + M1) / 2;
      const head = poly([[W, cy], [W - 300, cy + 300], [W - 512, cy + 300], [W - 212, cy], [W - 512, cy - 300], [W - 300, cy - 300]]);
      const arrowR = U(rect(0, M0, W - 150, M1), head);
      add("arrowright", [0x2192], W, dg, dg, arrowR, { ymin: -100, ymax: 800 });
      add("arrowleft", [0x2190], W, dg, dg, mirrorX(arrowR, W), { ymin: -100, ymax: 800 });
      const up = U(rect(252, -40, 388, 640), poly([[320, 740], [620, 440], [620, 250], [320, 550], [20, 250], [20, 440]]));
      add("arrowup", [0x2191], 640, dg, dg, up, { ymin: -100, ymax: 800 });
      add("arrowdown", [0x2193], 640, dg, dg, mirrorY(up, 700), { ymin: -100, ymax: 800 });
    }

    // ===== 日本語（全角 1000、字面 y -110..790） =====
    const TOP = 790, BOT = -110, HB = 118, VB = 134;
    const J = { TOP, BOT, HB, VB, S0, S1, M0, M1, T };

    // 裏（亠＋里＋𧘇。田の中画を線の真上に乗せる）
    {
      const hk = 66, vk = 90, dk = 86, c = 500, TOPK = 800, BOTK = -120;
      const ura = I(U(
        rect(c - vk / 2, 742, c + vk / 2, TOPK),
        rect(84, 676, 916, 742),
        rect(196, 572, 804, 572 + hk),
        rect(196, S1, 804, S1 + hk),
        rect(196, 318, 804, 318 + hk),
        rect(196, 318, 196 + vk, 572 + hk),
        rect(804 - vk, 318, 804, 572 + hk),
        rect(c - vk / 2, -40, c + vk / 2, 572 + hk),
        rect(262, 214, 738, 214 + hk),
        rect(96, 110, 904, 110 + hk),
        diag(410, 140, 130, BOTK, dk),
        diag(585, 150, 900, BOTK, dk),
        diag(838, 82, 712, -14, 70),
      ), rect(60, BOTK, 940, TOPK));
      addabs("uni88CF", [0x88CF], 1000, ura, { notch: [rect(190, S1 + hk, 196 + vk + 1, 572), rect(804 - vk - 1, S1 + hk, 810, 572)] });
    }

    // かな（カタカナ）— kana.js の定義を読む
    if (root.URAJI_KANA) root.URAJI_KANA(J, { add: addabs, rect, poly, rr, ring, diag, U, D, I, O, X, mirrorX, mirrorY, scaleAt, move, EMPTY });

    addabs("uni3000", [0x3000], 1000, EMPTY);

    // ===== 線を入れる（ss01 は閉じた穴にも短い切れ目） =====
    const slitRect = T > 0 ? rect(-2000, S0, 4000, S1) : null;
    const out = [];
    const ss01 = [];
    for (const g of G) {
      const empty = g.tree.length === 1 && g.tree[0] === "U";
      let tree = (slitRect && !empty) ? D(g.tree, slitRect) : g.tree;
      const adv = g.abs ? g.w : g.l + g.w + g.r;
      const place = (t) => g.abs ? t : X([1, 0, 0, 1, g.l, 0], t);
      out.push({ name: g.name, u: g.u, adv, tree: place(tree) });
      if (g.notch.length && !empty) {
        out.push({ name: g.name + ".ss01", u: [], adv, tree: place(D(g.tree, ...(slitRect ? [slitRect] : []), ...g.notch)) });
        ss01.push([g.name, g.name + ".ss01"]);
      }
    }
    return { params: P, geo: { S0, S1, M0, M1, H }, glyphs: out, kern: KERN, ss01 };
  }

  const api = { DEFAULTS, KNOBS, KERN, build };
  root.URAJI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
