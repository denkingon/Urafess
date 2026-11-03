/*
 * URAJI（裏字）— カタカナ
 * 全角 1000、字面 y -110..790。横画・縦画・斜め画と、右上の折れ（丸い角）だけで組む。
 * ・線（切れ目）の近くの横画は「線の真下」(上端 = S0) か「線の真上」(下端 = S1) に置き、線を跨がせない。
 * ・小さいかなは、線から下（裏）にちょうど収まる大きさにする。
 */
(function (root) {
  "use strict";
  root.URAJI_KANA = function (J, k) {
    const { add, rect, poly, rr, ring, diag, U, D, I, O, X, scaleAt } = k;
    const { TOP, BOT, HB, VB, S0, S1 } = J;
    const DT = 128;                                   // 斜め画の太さ
    const above = (h = HB) => [S1, S1 + h];           // 線の真上に乗る横画
    const under = (h = HB) => [S0 - h, S0];           // 線の真下に下がる横画
    const hbar = (x0, x1, y0, y1 = y0 + HB) => rect(x0, y0, x1, y1);
    const vbar = (x0, y0, y1, w = VB) => rect(x0, y0, x0 + w, y1);
    const roundTR = (node, x1, y1, r = 160) => I(node, U(rr(-3000, -3000, x1, y1, 0, [r, r], 0, 0), rect(x1 - 1, -3000, 3000, y1 - r)));
    const roundBL = (node, x0, y0, r = 150) => I(node, U(rr(x0, y0, 3000, 3000, 0, 0, 0, [r, r]), rect(-3000, y0 + r, x0 + 1, 3000), rect(x0 + r, -3000, 3000, y0 + 1)));
    const hslab = (x0, y0, x1, y1, th) => poly([[x0, y0 - th / 2], [x1, y1 - th / 2], [x1, y1 + th / 2], [x0, y0 + th / 2]]);
    const squeeze = (node, s) => X([s, 0, 0, 1, 60 * (1 - s), 0], node);
    const box = (n) => I(n, rect(30, BOT - 20, 975, TOP));

    // 縦画が yBend で折れて (xe, ye) へ払う一筆（継ぎ目は留め）
    function bend(x0, w, yTop, yBend, xe, ye) {
      const xc = x0 + w / 2, dx = xe - xc, dy = ye - yBend, L = Math.hypot(dx, dy);
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, h = w / 2;
      const A = [xc + h * nx, yBend + h * ny], Bp = [xc - h * nx, yBend - h * ny];
      const xAt = (P, Y) => P[0] + (Y - P[1]) / uy * ux;
      const [Lf, Rt] = xAt(A, yBend) < xAt(Bp, yBend) ? [A, Bp] : [Bp, A];
      const atX = (P, Xv) => [Xv, P[1] + (Xv - P[0]) / ux * uy];
      const atY = (P, Y) => [xAt(P, Y), Y];
      return poly([[x0, yTop], [x0 + w, yTop], atX(Rt, x0 + w), atY(Rt, ye), atY(Lf, ye), atX(Lf, x0)]);
    }
    // 縦画が下で跳ねて右上 (xe, ye) へ上がる一筆（レ・ル）
    function flick(x0, w, yTop, yBot, xe, ye, t) {
      const dx = xe - x0, dy = ye - yBot, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const Q = [x0 + t * nx, yBot + t * ny];
      const s = (x0 + w - Q[0]) / ux;
      const Jp = [x0 + w, Q[1] + s * uy];
      return poly([[x0, yTop], [x0 + w, yTop], Jp, [Q[0] + L * ux, Q[1] + L * uy], [xe, ye], [x0, yBot]]);
    }
    // フ型：上の横画が右で折れて左下へ流れる
    const fuShape = (x0, xr, yTop, xEnd, r = 170) =>
      roundTR(U(hbar(x0, xr, yTop - HB, yTop), diag(xr + 20, yTop, xEnd, BOT, VB)), xr, yTop, r);

    const full = {};
    const def = (name, cp, tree, opt) => { full[name] = tree; add(name, [cp], 1000, box(tree), opt); };

    // ---- ア行 ----
    def("uni30A2", 0x30A2, U(roundTR(U(hbar(110, 870, TOP - HB, TOP), diag(880, TOP, 690, S1 + 60, DT)), 870, TOP, 160),   // ア
      diag(560, TOP - HB + 6, 190, BOT, VB)));
    def("uni30A4", 0x30A4, U(diag(880, TOP, 110, 250, VB), vbar(520, BOT, 560)));                        // イ
    def("uni30A6", 0x30A6, U(vbar(433, TOP - HB, TOP), vbar(130, 300, S1 + HB),                          // ウ
      roundTR(U(hbar(130, 860, ...above()), diag(880, S1 + HB, 360, BOT, VB)), 860, S1 + HB, 150)));
    def("uni30A8", 0x30A8, U(hbar(190, 810, TOP - HB, TOP), vbar(433, 0, TOP), hbar(100, 900, BOT, BOT + HB)));   // エ
    def("uni30AA", 0x30AA, U(hbar(90, 910, S1 + 70, S1 + 70 + HB), vbar(560, -40, TOP), hbar(400, 694, BOT, BOT + HB),   // オ
      diag(570, S1 + 110, 140, 0, DT)));

    // ---- カ行 ----
    def("uni30AB", 0x30AB, U(roundTR(U(hbar(110, 870, S1 + 80, S1 + 80 + HB), vbar(736, 10, S1 + 80 + HB)), 870, S1 + 80 + HB, 150),   // カ
      hbar(630, 870, BOT, BOT + HB), vbar(736, BOT, 40), diag(450, TOP, 130, BOT, VB)));
    def("uni30AD", 0x30AD, U(hbar(160, 840, S1 + 110, S1 + 110 + HB), hbar(90, 910, ...under()), diag(420, TOP, 570, BOT, VB)));   // キ
    def("uni30AF", 0x30AF, U(diag(410, TOP, 140, S1, DT), fuShape(330, 860, TOP, 300)));                 // ク
    def("uni30B1", 0x30B1, U(diag(360, TOP, 90, 200, DT), hbar(250, 910, ...above()), diag(690, S1 + HB, 350, BOT, VB)));   // ケ
    def("uni30B3", 0x30B3, I(U(hbar(150, 850, TOP - 70 - HB, TOP - 70), vbar(716, -30, TOP - 70), hbar(150, 850, -30, -30 + HB)),   // コ
      rr(-3000, -30, 850, TOP - 70, 0, [150, 150], [150, 150], 0)));

    // ---- サ行 ----
    def("uni30B5", 0x30B5, U(hbar(70, 930, S1 + 50, S1 + 50 + HB), vbar(240, 250, TOP), bend(616, VB, TOP, 330, 330, BOT)));   // サ
    def("uni30B7", 0x30B7, U(hslab(150, 740, 400, 660, 112), hslab(110, 560, 360, 500, 112), diag(150, BOT, 900, 640, 142)));   // シ
    def("uni30B9", 0x30B9, I(U(hbar(150, 800, TOP - HB, TOP), diag(830, TOP, 150, BOT, VB), diag(470, 330, 900, BOT, VB)),   // ス
      U(rr(60, BOT, 800, TOP, 0, [170, 170], 0, 0), rect(60, BOT, 940, TOP - 200))));
    def("uni30BB", 0x30BB, U(roundTR(U(hbar(70, 880, S1 + 90, S1 + 90 + HB), diag(880, S1 + 90 + HB, 730, S1 + 30, DT)), 880, S1 + 90 + HB, 140),   // セ
      roundBL(U(vbar(250, BOT, TOP), hbar(250, 890, BOT, BOT + HB)), 250, BOT, 150)));
    def("uni30BD", 0x30BD, U(diag(170, 720, 330, S1 + 20, DT), diag(870, TOP, 310, BOT, VB)));             // ソ

    // ---- タ行 ----
    def("uni30BF", 0x30BF, U(diag(410, TOP, 140, S1, DT), fuShape(330, 860, TOP, 300), diag(455, 560, 700, 310, DT)));   // タ
    def("uni30C1", 0x30C1, U(hslab(220, 700, 820, 770, 112), hbar(70, 930, ...above()), bend(433, VB, 740, 330, 200, BOT)));   // チ
    def("uni30C4", 0x30C4, U(diag(150, 730, 280, S1 + 50, DT), diag(400, 770, 530, S1 + 90, DT), diag(880, TOP, 330, BOT, VB)));   // ツ
    def("uni30C6", 0x30C6, U(hbar(210, 790, TOP - HB, TOP), hbar(70, 930, ...above()), bend(433, VB, S1 + 2, 300, 210, BOT)));   // テ
    def("uni30C8", 0x30C8, I(U(rect(300, BOT, 300 + VB, TOP), diag(300 + VB - 20, S0 - 2, 800, 150, 118)),   // ト
      U(rect(300, BOT, 300 + VB, TOP), rect(300, BOT, 900, S0))));

    // ---- ナ行 ----
    def("uni30CA", 0x30CA, U(hbar(70, 930, S1 + 50, S1 + 50 + HB), bend(520, VB, TOP, 330, 230, BOT)));   // ナ
    def("uni30CB", 0x30CB, U(hbar(200, 800, S1 + 120, S1 + 120 + HB), hbar(80, 920, 20, 20 + HB)));        // ニ
    def("uni30CC", 0x30CC, U(fuShape(130, 860, TOP, 330), diag(300, S0 - 40, 800, 10, DT)));              // ヌ
    def("uni30CD", 0x30CD, U(vbar(433, TOP - HB, TOP),                                                    // ネ
      roundTR(U(hbar(150, 840, S1 + 50, S1 + 50 + HB), diag(850, S1 + 50 + HB, 150, 40, DT)), 840, S1 + 50 + HB, 140),
      vbar(433, BOT, 240), diag(640, 250, 880, 60, 112)));
    def("uni30CE", 0x30CE, diag(830, TOP, 200, BOT, 142));                                                // ノ

    // ---- ハ行 ----
    def("uni30CF", 0x30CF, U(diag(400, 640, 90, -40, VB), diag(600, 640, 910, -40, VB)));                  // ハ
    def("uni30D2", 0x30D2, U(roundBL(U(vbar(170, BOT, TOP), hbar(170, 880, BOT, BOT + HB)), 170, BOT, 150), hbar(250, 820, ...above())));   // ヒ
    def("uni30D5", 0x30D5, I(U(rect(130, TOP - HB, 860, TOP), diag(880, TOP, 330, BOT, VB)), rr(60, BOT, 860, TOP, 0, [170, 170], 0, 0)));   // フ
    def("uni30D8", 0x30D8, U(diag(70, 200, 330, 620, VB), diag(280, 640, 930, 20, VB)));                  // ヘ
    def("uni30DB", 0x30DB, U(hbar(70, 930, S1 + 70, S1 + 70 + HB), vbar(433, -20, TOP), hbar(300, 567, BOT, BOT + HB),   // ホ
      diag(300, 330, 100, -60, DT), diag(700, 330, 900, -60, DT)));

    // ---- マ行 ----
    def("uni30DE", 0x30DE, U(roundTR(U(hbar(100, 870, TOP - HB, TOP), diag(880, TOP, 495, 300, VB)), 870, TOP, 160), diag(495, 300, 760, -80, VB)));   // マ
    def("uni30DF", 0x30DF, U(hslab(250, 740, 700, 680, 100), hslab(230, 352, 720, 300, 96), hslab(190, -10, 800, -70, 106)));   // ミ
    def("uni30E0", 0x30E0, U(diag(520, TOP, 160, -10, VB), hbar(110, 840, BOT, BOT + HB), diag(620, 330, 870, 70, DT)));   // ム
    def("uni30E1", 0x30E1, U(diag(840, TOP, 170, BOT, 142), diag(290, S0 - 10, 830, 10, DT)));           // メ
    def("uni30E2", 0x30E2, U(hbar(200, 800, TOP - HB, TOP), hbar(70, 930, ...above()), roundBL(U(vbar(380, BOT, TOP), hbar(380, 880, BOT, BOT + HB)), 380, BOT, 150)));   // モ

    // ---- ヤ行 ----
    def("uni30E4", 0x30E4, U(roundTR(U(hbar(70, 870, S1 + 60, S1 + 60 + HB), diag(880, S1 + 60 + HB, 730, S1 + 10, DT)), 870, S1 + 60 + HB, 140),   // ヤ
      diag(330, TOP, 510, BOT, VB)));
    def("uni30E6", 0x30E6, U(roundTR(U(hbar(150, 760, S1 + 110, S1 + 110 + HB), vbar(626, 40, S1 + 110 + HB)), 760, S1 + 110 + HB, 130), hbar(70, 930, -40, -40 + HB)));   // ユ
    def("uni30E8", 0x30E8, I(U(hbar(150, 850, TOP - HB, TOP), hbar(190, 850, ...under()), hbar(150, 850, BOT, BOT + HB), vbar(716, BOT, TOP)),   // ヨ
      rr(-3000, BOT, 850, TOP, 0, [150, 150], [150, 150], 0)));

    // ---- ラ行 ----
    def("uni30E9", 0x30E9, U(hbar(220, 780, TOP - HB, TOP), fuShape(130, 860, S1 + HB, 330, 150)));        // ラ
    def("uni30EA", 0x30EA, U(vbar(200, 200, 760), bend(640, VB, TOP, 330, 380, BOT)));                    // リ
    def("uni30EB", 0x30EB, U(bend(240, VB, TOP, 330, 70, BOT), flick(560, VB, TOP, BOT, 940, 260, 118)));  // ル
    def("uni30EC", 0x30EC, flick(200, VB, TOP, BOT, 910, S1 + 130, 128));                                 // レ
    def("uni30ED", 0x30ED, ring(150, -60, 850, 730, 120, 120, 120, 120, VB, HB));                         // ロ

    // ---- ワ行・ン ----
    def("uni30EF", 0x30EF, U(vbar(140, S1 + 40, TOP), fuShape(140, 860, TOP, 330)));                      // ワ
    def("uni30F2", 0x30F2, U(fuShape(120, 850, TOP, 330), hbar(160, 700, ...above())));                  // ヲ
    def("uni30F3", 0x30F3, I(U(diag(180, 690, 420, 545, 118), diag(170, BOT + 10, 870, TOP - 70, 142)), rect(100, BOT, 900, TOP)));   // ン

    // ---- 古いかな・踊り字 ----
    def("uni30F0", 0x30F0, U(hbar(110, 890, S1 + 100, S1 + 100 + HB), hbar(70, 930, ...under()),        // ヰ
      vbar(290, S0 - HB, 760), vbar(576, BOT, 760)));
    def("uni30F1", 0x30F1, U(roundTR(U(hbar(140, 830, TOP - HB, TOP), diag(850, TOP, 520, S1 + 100, DT)), 830, TOP, 160),   // ヱ
      vbar(433, BOT, S1 + 100), hbar(90, 910, BOT, BOT + HB)));
    def("uni30FD", 0x30FD, diag(380, S0 - 30, 620, 60, DT));                                             // ヽ

    // ---- 小さいかな：線から下（裏）にちょうど収まる大きさ。細る分は太らせて戻す ----
    const SK = (S0 - BOT) / (TOP - BOT);
    const small = (n) => O(scaleAt(full[n], SK, 500, BOT), 11);
    [["uni30A1", "uni30A2"], ["uni30A3", "uni30A4"], ["uni30A5", "uni30A6"], ["uni30A7", "uni30A8"], ["uni30A9", "uni30AA"],
     ["uni30C3", "uni30C4"], ["uni30E3", "uni30E4"], ["uni30E5", "uni30E6"], ["uni30E7", "uni30E8"], ["uni30EE", "uni30EF"],
     ["uni30F5", "uni30AB"], ["uni30F6", "uni30B1"]].forEach(([s, b]) => def(s, parseInt(s.slice(3), 16), small(b)));

    // ---- 濁点・半濁点（右上の決まった場所。ぶつかる字は字を少し細めて場所をあける） ----
    const dakuten = U(diag(815, TOP, 845, 690, 58), diag(905, TOP, 935, 690, 58));
    const handakuten = ring(810, 650, 950, TOP, 70, 70, 70, 70, 40, 40);
    const handNotch = rect(800, 705, 852, 737);
    const base = {
      uni30AF: squeeze(full.uni30AF, 0.88), uni30B3: squeeze(full.uni30B3, 0.88), uni30BF: squeeze(full.uni30BF, 0.88),
      uni30D5: squeeze(full.uni30D5, 0.88), uni30AD: squeeze(full.uni30AD, 0.88), uni30BB: squeeze(full.uni30BB, 0.88),
      uni30C6: squeeze(full.uni30C6, 0.94), uni30C1: squeeze(full.uni30C1, 0.88),
      uni30EF: squeeze(full.uni30EF, 0.88), uni30F1: squeeze(full.uni30F1, 0.88), uni30F2: squeeze(full.uni30F2, 0.88),
      uni30BD: U(diag(170, 720, 330, S1 + 20, DT), diag(690, 700, 250, BOT, VB)),
      uni30C4: U(diag(150, 730, 280, S1 + 50, DT), diag(400, 770, 530, S1 + 90, DT), diag(690, 700, 280, BOT, VB)),
    };
    const pick = (b) => base[b] || full[b];
    const DAKU = [["uni30AB", 0x30AC], ["uni30AD", 0x30AE], ["uni30AF", 0x30B0], ["uni30B1", 0x30B2], ["uni30B3", 0x30B4],
      ["uni30B5", 0x30B6], ["uni30B7", 0x30B8], ["uni30B9", 0x30BA], ["uni30BB", 0x30BC], ["uni30BD", 0x30BE],
      ["uni30BF", 0x30C0], ["uni30C1", 0x30C2], ["uni30C4", 0x30C5], ["uni30C6", 0x30C7], ["uni30C8", 0x30C9],
      ["uni30CF", 0x30D0], ["uni30D2", 0x30D3], ["uni30D5", 0x30D6], ["uni30D8", 0x30D9], ["uni30DB", 0x30DC], ["uni30A6", 0x30F4],
      ["uni30EF", 0x30F7], ["uni30F0", 0x30F8], ["uni30F1", 0x30F9], ["uni30F2", 0x30FA], ["uni30FD", 0x30FE]];
    const HANDAKU = [["uni30CF", 0x30D1], ["uni30D2", 0x30D4], ["uni30D5", 0x30D7], ["uni30D8", 0x30DA], ["uni30DB", 0x30DD]];
    const hb = { uni30DB: squeeze(full.uni30DB, 0.86), uni30D5: squeeze(full.uni30D5, 0.88) };
    const hx = (n) => n.toString(16).toUpperCase();
    for (const [b, cp] of DAKU) def("uni" + hx(cp), cp, U(pick(b), dakuten));
    for (const [b, cp] of HANDAKU) def("uni" + hx(cp), cp, U(hb[b] || full[b], handakuten), { notch: [handNotch] });

    // ---- 記号 ----
    def("uni30FC", 0x30FC, rect(80, 290, 920, 290 + HB));                                                 // ー
    def("uni30FB", 0x30FB, rect(430, 272, 570, 410));                                                     // ・
    def("uni300C", 0x300C, U(rect(540, 250, 652, TOP), rect(540, TOP - 108, 860, TOP)));                  // 「
    def("uni300D", 0x300D, U(rect(348, BOT, 460, 400), rect(140, BOT, 460, BOT + 108)));                  // 」
    def("uni3001", 0x3001, diag(150, 120, 300, -60, 110));                                               // 、
    def("uni3002", 0x3002, ring(110, -100, 330, 120, 110, 110, 110, 110, 62, 62), { notch: [rect(100, -6, 176, 26)] });   // 。
  };
})(typeof window !== "undefined" ? window : globalThis);
