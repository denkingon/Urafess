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
    VL: 146,     // 小文字の縦画の太さ
    BL: 104,     // 小文字の横画の太さ
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
    { key: "VL", label: "小文字の縦画", group: "小文字", min: 100, max: 200, step: 1, fmt: (v) => String(Math.round(v)) },
    { key: "BL", label: "小文字の横画", group: "小文字", min: 70, max: 150, step: 1, fmt: (v) => String(Math.round(v)) },
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
    // 小文字
    ...["a", "c", "e", "o", "s", "g", "q", "d"].map((c) => ["T", c, -52]), ...["u", "r", "m", "n", "p", "y", "v", "w", "x", "z"].map((c) => ["T", c, -40]),
    ...["a", "c", "e", "o", "s", "g", "q", "d"].map((c) => ["V", c, -30]), ...["a", "c", "e", "o", "s", "g", "q", "d"].map((c) => ["W", c, -22]),
    ...["a", "c", "e", "o", "s", "g", "q", "d"].map((c) => ["Y", c, -40]), ["Y", "u", -28], ["Y", "n", -28],
    ...["a", "e", "o"].map((c) => ["F", c, -20]), ...["a", "e", "o"].map((c) => ["P", c, -20]),
    ["L", "y", -40], ["L", "v", -32], ["L", "w", -24],
    ["r", "comma", -54], ["r", "period", -54], ["r", "a", -12], ["r", "hyphen", -20],
    ["v", "comma", -44], ["v", "period", -44], ["w", "comma", -36], ["w", "period", -36], ["y", "comma", -44], ["y", "period", -44],
    ["f", "comma", -34], ["f", "period", -34], ["t", "comma", -10],
    ["k", "o", -16], ["k", "e", -16], ["k", "c", -16], ["k", "a", -10], ["x", "o", -10], ["x", "e", -10],
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
    add("A", [0x41], W, st, st, U(D(rr(0, 0, W, H, R, R), rr(V, -10, W - V, H - B, [R - V, R - B], [R - V, R - B])), rect(V - 2, M0, W - V + 2, M1)));

    W = ww(520);
    add("B", [0x42], W, st, rd, U(ring(0, M0, W - 24, H, 0, R, R, 0), ring(0, 0, W, M1, 0, R, R, 0)), { notch: [lowerNotch(B, M0)] });

    W = ww(520);
    add("C", [0x43], W, rd, tb, D(ring(0, 0, W, H, R, R, R, R), rect(W - V - 2, R, W + 2, H - R)));

    W = ww(540);
    add("D", [0x44], W, st, rd, ring(0, 0, W, H, 0, R, R, 0));

    W = ww(470);
    add("E", [0x45], W, st, tb, U(rect(0, 0, V, H), rect(0, H - B, W, H), rect(0, M0, W - 34, M1), rect(0, 0, W, B)));

    W = ww(450);
    add("F", [0x46], W, st, tb, U(rect(0, 0, V, H), rect(0, H - B, W, H), rect(0, M0, W - 34, M1)));

    W = ww(540);
    add("G", [0x47], W, rd, rd, U(D(ring(0, 0, W, H, R, R, R, R), rect(W - V - 2, M1, W + 2, H - R)), rect(W * 0.47, M0, W, M1)));

    W = ww(540);
    add("H", [0x48], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), rect(V - 1, M0, W - V + 1, M1)));

    W = V;
    add("I", [0x49], W, st, st, rect(0, 0, V, H));

    W = ww(470);
    add("J", [0x4A], W, tb, st, D(D(rr(0, 0, W, H, 0, 0, R, R), rr(V, B, W - V, H + 60, 0, 0, [R - V, R - B], [R - V, R - B])), rect(-1, 250, V + 1, H + 1)));

    W = ww(540);
    add("K", [0x4B], W, st, dg, U(rect(0, 0, V, H), diag(V - 10, 250, W - 78, H + 40, 152), diag(V + 118, 360, W - 78, -40, 168)));

    W = ww(440);
    add("L", [0x4C], W, st, tb, U(rect(0, 0, V, H), rect(0, 0, W, B)));

    W = ww(690);
    add("M", [0x4D], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), diag(V * 0.45, H + 20, W / 2, 170, 148), diag(W - V * 0.45, H + 20, W / 2, 170, 148)));

    W = ww(560);
    add("N", [0x4E], W, st, st, U(rect(0, 0, V, H), rect(W - V, 0, W, H), diag(V * 0.42, H + 30, W - V * 0.42, -30, 158)));

    W = ww(560);
    add("O", [0x4F], W, rd, rd, ring(0, 0, W, H, R, R, R, R));

    W = ww(510);
    add("P", [0x50], W, st, rd, U(rect(0, 0, V, H), ring(0, M0, W, H, 0, R, R, 0)));

    W = ww(560);
    add("Q", [0x51], W, rd, rd, I(U(ring(0, 0, W, H, R, R, R, R), diag(W * 0.60, 230, W + 18, -95, 150)), rect(0, -95, W + 30, H)), { clip: false });

    W = ww(530);
    add("R", [0x52], W, st, dg, U(rect(0, 0, V, H), ring(0, M0, W - 22, H, 0, R, R, 0), diag(W * 0.50, M0 + 70, W - 84, -40, 166)));

    W = ww(510);
    {
      const up = D(ring(0, M0, W, H, R, 0, 0, Rs), rect(V, M1, W + 1, H - B), rect(W - Rs, M0 - 1, W + 1, M1));
      const lo = D(ring(0, 0, W, M1, 0, Rs, R, 0), rect(-1, B, W - V, M0), rect(-1, M0 - 1, Rs, M1 + 1));
      add("S", [0x53], W, rd, rd, U(up, lo));
    }

    W = ww(520);
    add("T", [0x54], W, tb, tb, U(rect(0, H - B, W, H), rect(W / 2 - V / 2, 0, W / 2 + V / 2, H)));

    W = ww(540);
    add("U", [0x55], W, st, st, D(rr(0, 0, W, H, 0, 0, R, R), rr(V, B, W - V, H + 60, 0, 0, [R - V, R - B], [R - V, R - B])));

    W = ww(570);
    add("V", [0x56], W, dg, dg, U(diag(V * 0.5, H + 20, W / 2 - 6, -10, 158), diag(W - V * 0.5, H + 20, W / 2 + 6, -10, 158)));

    W = ww(840);
    add("W", [0x57], W, dg, dg, U(diag(80, H + 20, W * 0.285, -10, 150), diag(W / 2 - 4, 590, W * 0.285, -10, 142),
      diag(W / 2 + 4, 590, W * 0.715, -10, 142), diag(W - 80, H + 20, W * 0.715, -10, 150)));

    W = ww(570);
    add("X", [0x58], W, dg, dg, U(diag(78, H + 20, W - 78, -20, 156), diag(W - 78, H + 20, 78, -20, 156)));

    W = ww(570);
    add("Y", [0x59], W, dg, dg, U(diag(80, H + 30, W / 2, 280, 156), diag(W - 80, H + 30, W / 2, 280, 156), rect(W / 2 - V / 2, 0, W / 2 + V / 2, 330)));

    W = ww(500);
    add("Z", [0x5A], W, tb, tb, U(rect(0, H - B, W, H), rect(0, 0, W, B), diag(W - 92, H - B + 4, 92, B - 4, 166)));

    // ===== 英小文字 =====
    // 小文字は線の下（裏）にまるごと収まる：x の高さ＝線の下の縁（小さいかなと同じ決まり）。
    // 上へ伸びる画（b d f h k l t）だけが線を越えて表へ出る。f と t の横画は x の高さのすぐ下＝線の真下（大文字の中間画と同じ）。
    // 線が小文字の穴を開けないので、閉じた穴（a b d e g o p q）は型紙 ss01 で縦画に短い切れ目を入れる。
    {
      const XH = S0, VL = P.VL, BL = P.BL, BE = Math.round(P.BL * 0.88), DSC = -210;
      const Rl = Math.round(Math.min(R, XH * 0.40));
      const innL = (r) => [Math.max(r - VL, 0), Math.max(r - BL, 0)];
      const ringL = (x0, y0, x1, y1, tl, tr, br, bl) => ring(x0, y0, x1, y1, tl, tr, br, bl, VL, BL);
      const notchAt = (x0, yLo, yHi) => { const mid = (yLo + yHi) / 2; return rect(x0 - 1, mid - T / 2, x0 + VL + 1, mid + T / 2); };
      const xcut = (n, w) => I(n, rect(-1, 0, w + 1, XH));          // x の高さで切りそろえる
      const lo = { ymin: DSC };
      let w;

      // 丸（o c e）
      w = ww(470);
      add("o", [0x6F], w, rd, rd, ringL(0, 0, w, XH, Rl, Rl, Rl, Rl), { notch: [notchAt(0, BL, XH - BL)] });
      w = ww(440);
      add("c", [0x63], w, rd, rd - 20, D(ringL(0, 0, w, XH, Rl, Rl, Rl, Rl), rect(w - VL - 2, Rl * 0.82, w + 2, XH - Rl * 0.82)));
      w = ww(460);
      {
        const e0 = Math.round((XH - BE) / 2 + BE * 0.25), e1 = e0 + BE;
        add("e", [0x65], w, rd, rd - 10, U(D(ringL(0, 0, w, XH, Rl, Rl, Rl, Rl), rect(w - VL - 2, BL, w + 2, e0)), rect(VL - 1, e0, w - VL + 1, e1)), { notch: [notchAt(0, e1, XH - BL)] });
      }

      // 丸に縦画（a d q g ／ b p）
      w = ww(470);
      {
        const bowlL = ringL(0, 0, w, XH, Rl, 0, 0, Rl), bowlR = ringL(0, 0, w, XH, 0, Rl, Rl, 0);
        const nL = notchAt(0, BL, XH - BL), nR = notchAt(w - VL, BL, XH - BL);
        add("a", [0x61], w, rd, st, U(bowlL, rect(w - VL, 0, w, XH)), { notch: [nL] });
        add("d", [0x64], w, rd, st, U(bowlL, rect(w - VL, 0, w, H)), { notch: [nL] });
        add("q", [0x71], w, rd, st, U(bowlL, rect(w - VL, DSC, w, XH)), Object.assign({ notch: [nL] }, lo));
        add("b", [0x62], w, st, rd, U(bowlR, rect(0, 0, VL, H)), { notch: [nR] });
        add("p", [0x70], w, st, rd, U(bowlR, rect(0, DSC, VL, XH)), Object.assign({ notch: [nR] }, lo));
        const hook = D(D(rr(0, DSC, w, XH, 0, 0, Rl, Rl), rr(VL, DSC + BL, w - VL, XH + 60, 0, 0, innL(Rl), innL(Rl))), rect(-1, DSC + Rl * 0.9, VL + 1, XH + 1));
        add("g", [0x67], w, rd, st, U(bowlL, hook, rect(w - VL, 0, w, XH)), Object.assign({ notch: [nL] }, lo));
      }

      // 弧と縦画（n h m u r）
      w = ww(460);
      {
        const arch = (x) => move(D(rr(0, 0, w, XH, 0, Rl), rr(VL, -10, w - VL, XH - BL, 0, innL(Rl))), x, 0);
        add("n", [0x6E], w, st, st, U(rect(0, 0, VL, XH), arch(0)));
        add("h", [0x68], w, st, st, U(rect(0, 0, VL, H), arch(0)));
        add("m", [0x6D], 2 * w - VL, st, st, U(rect(0, 0, VL, XH), arch(0), arch(w - VL)));
        add("u", [0x75], w, st, st, U(D(rr(0, 0, w, XH, 0, 0, 0, Rl), rr(VL, BL, w - VL, XH + 60, 0, 0, 0, innL(Rl))), rect(w - VL, 0, w, XH)));
        const wr = ww(330);
        add("r", [0x72], wr, st, 0, U(rect(0, 0, VL, XH), D(rr(0, 0, wr, XH, 0, Rl), rr(VL, -10, wr + 10, XH - BL, 0, innL(Rl)), rect(-1, -1, wr + 1, XH - Rl * 0.82))));
      }

      // 縦画（i j l）。点は線の上に置く
      const dot0 = Math.max(XH + 60, S1 + 44), DOTH = 132;
      add("i", [0x69], VL, st, st, U(rect(0, 0, VL, XH), rect(0, dot0, VL, dot0 + DOTH)));
      add("l", [0x6C], VL, st, st, rect(0, 0, VL, H));
      w = ww(300);
      {
        const Rj = Math.round(Math.min(Rl, 150)), x0 = w - VL;
        add("j", [0x6A], w, -30, st, U(D(rr(0, DSC, w, XH, 0, 0, Rj, 0), rr(-10, DSC + BL, x0, XH + 10, 0, 0, innL(Rj), 0)), rect(x0, dot0, w, dot0 + DOTH)), lo);
      }

      // t・f（横画は線の真下）
      {
        const wt = ww(330), s0 = 64, ttop = Math.round(XH + (H - XH) * 0.62);
        add("t", [0x74], wt, 8, 0, U(D(rr(s0, 0, wt, ttop, 0, 0, 0, Rl), rr(s0 + VL, BL, wt + 10, ttop + 10, 0, 0, 0, innL(Rl))), rect(0, XH - BL, wt - 20, XH)));
        const wf = ww(320), f0 = 50;
        add("f", [0x66], wf, 8, -10, U(D(rr(f0, 0, wf, H, Rl, 0, 0, 0), rr(f0 + VL, -10, wf + 10, H - BL, innL(Rl), 0, 0, 0)), rect(0, XH - BL, wf - 30, XH)));
      }

      // 斜め（k v w x y z）と s
      w = ww(470);
      add("k", [0x6B], w, st, dg, U(rect(0, 0, VL, H), xcut(diag(VL - 10, XH * 0.30, w - 70, XH + 30, 136), w), diag(VL + 92, XH * 0.52, w - 70, -30, 150)));
      w = ww(480);
      add("v", [0x76], w, dg, dg, xcut(U(diag(VL * 0.5, XH + 20, w / 2 - 6, -10, 150), diag(w - VL * 0.5, XH + 20, w / 2 + 6, -10, 150)), w));
      w = ww(700);
      add("w", [0x77], w, dg, dg, xcut(U(diag(70, XH + 20, w * 0.29, -10, 140), diag(w / 2 - 4, XH * 0.86, w * 0.29, -10, 132), diag(w / 2 + 4, XH * 0.86, w * 0.71, -10, 132), diag(w - 70, XH + 20, w * 0.71, -10, 140)), w));
      w = ww(480);
      add("x", [0x78], w, dg, dg, xcut(U(diag(70, XH + 20, w - 70, -20, 148), diag(w - 70, XH + 20, 70, -20, 148)), w));
      w = ww(490);
      add("y", [0x79], w, dg, dg, I(U(diag(72, XH + 20, w * 0.5, -6, 148), diag(w - 72, XH + 20, w * 0.22, DSC - 10, 150)), rect(-1, DSC, w + 1, XH)), lo);
      w = ww(430);
      add("z", [0x7A], w, tb, tb, U(rect(0, XH - BL, w, XH), rect(0, 0, w, BL), diag(w - 84, XH - BL + 4, 84, BL - 4, 152)));
      w = ww(430);
      {
        const Rs2 = Math.round(Math.min(Rl, 150));
        const m1 = Math.round(XH / 2 + BL / 2), m0 = m1 - BL;
        const up = D(ringL(0, m0, w, XH, Rl, 0, 0, Rs2), rect(VL, m1, w + 1, XH - BL), rect(w - Rs2, m0 - 1, w + 1, m1));
        const dn = D(ringL(0, 0, w, m1, 0, Rs2, Rl, 0), rect(-1, BL, w - VL, m0), rect(-1, m0 - 1, Rs2, m1 + 1));
        add("s", [0x73], w, rd, rd, U(up, dn));
      }
    }

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

    // 漢字（祭・裏祭）— kanji.js の定義を読む
    if (root.URAJI_KANJI) root.URAJI_KANJI(J, { add: addabs, rect, poly, rr, ring, diag, U, D, I, O, X, mirrorX, mirrorY, scaleAt, move, EMPTY });

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
    // 新字（裏祭）：「裏」「祭」と続けて打つと一字（liga）。ss02 を入れると「裏」が全部新字になる。
    // 置き換えは liga → ss02 → ss01 の順に効く（build.py が書く順）。ss01 の切れ目つきの裏も新字に替える。
    const hasNew = !!byName["uni88CF_uni796D"];
    const liga = hasNew ? [[["uni88CF", "uni796D"], "uni88CF_uni796D"]] : [];
    const ss02 = hasNew ? [["[uni88CF uni88CF.ss01]", "uni88CF_uni796D"]] : [];
    return { params: P, geo: { S0, S1, M0, M1, H }, glyphs: out, kern: KERN, ss01, ss02, liga };
  }

  const api = { DEFAULTS, KNOBS, KERN, build };
  root.URAJI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
