// 裏フェス ピクトグラムの正本（デザインシステム「裏フェス ピクトグラム」の source/picto.js、2026-11-06 の決めた形）をそのまま写したもの。
// 直すときは正本を直してから写す。読み込むと window.URAFES_PICTO に入る。
/*
 * 裏フェス ピクトグラム — 統一させる層（正本）
 *
 * 人の骨格は1つだけ。頭・胴・腕（上腕と前腕）・脚（太ももとすね）。
 * 全部の絵は、この骨格の関節の角度（ポーズ）と、少しの小道具でできている。
 * 骨格の寸法（つまみ）を変えると、全部の絵と動きが一緒に変わる。
 *
 * 線：絵の枠の、地面から URAJI と同じ高さ（字の高さ 700 の 0.618）に、厚さ T（いまは 43）の切れ目。
 *     人のへその高さに来る。人が小さくても大きくても、へそを線に合わせて置く。線そのものは動かない。
 * 拍：全部の動きは拍（BEAT 秒）の整数倍でループする。同じ画面の絵は、同じ拍で動く。
 *
 * 角度の決め方：手足は「まっすぐ下」から測り、画面の右へ振るとプラス。胴は「まっすぐ上」から測り、右へ傾くとプラス。
 * 横向き（S）の絵は右を向く。L が奥の手足、R が手前の手足。正面（F）の絵は L が見て左、R が見て右。
 */
(function (root) {
  "use strict";

  // つまみ（人が動かす値）。骨の長さはここから計算する（derive）。
  // いまの値は 2026-11-04 につまみの道具で決めた値。
  const DEFAULTS = {
    G: 850,            // 地面（枠の上から）。線と URAJI の字の高さはこれを基準にする
    H: 700,            // URAJI の字の高さ（線の位置を決める）
    SLIT: 0.618,       // 線の高さ（地面から、H に対する割合）。人のへそも身長のこの割合
    T: 43,             // 線の厚さ
    HGT: 829,          // 身長（足の裏から頭のてっぺん）
    HR: 76,            // 頭の半径
    HSQ: 1,            // 頭の形（0 四角・1 丸）
    HG: 11,            // 頭と胴のすき間
    LEGR: 0.5,      // 脚の長さ（脚＋胴に対する脚の割合）
    ARMR: 0.63,      // 腕の長さ（脚に対する割合）
    TWF: 178,          // 胴の幅（正面）。横向きの胴はこの 0.71 倍
    TR: 24,            // 胴の角の丸み
    LIMB: 80,         // 手足の太さ
    CAP: 1,            // 手足の端（0 角・1 丸）
    AG: 6, LG: 14,    // 正面の腕と胴のすき間、脚と脚のすき間
    OG: 16,            // 横向きで手前の手足が重なるところのすき間（地の色で切る）
    BEAT: 0.5,         // 拍（秒）
    // 走り（スローモーション）
    RLEAN: 43,         // 体の傾き（度）。後ろ脚はいつも胴とまっすぐにつながる
    RSTEP: 2,          // 1歩にかける拍の数（いまは2拍＝1秒）
    RKNEE: 93,         // 前の膝の高さ（太ももの角度）
    RARM: 1.45,           // 腕の振りの大きさ
    RFLY: 0,          // すれ違うときの浮き
    // 第三勢力の身なり（マントと帽子）。頭の半径・太ももの長さに対する倍率
    TBRIM: 3.2,        // 帽子のつばの幅（頭の半径の何倍）
    TCROWN: 1.2,       // 帽子の高さ（頭の半径の何倍）
    THEM: 1.3,         // マントの丈（腰から、太ももの何倍下まで）
    TFLARE: 1.32,      // マントの裾の広がり（肩の幅の何倍）
    TCOLLAR: 1,        // 立て襟（0 なし・1 あり）
    TFACE: 1,          // 顔（0 隠す・1 見せる）
    THAT: 0,           // 帽子の形（0 中折れ帽・1 フード・2 尖り帽子・3 笠・4 天蓋）
    THEMS: 0,          // マントの裾（0 まっすぐ・1 ぎざぎざ・2 地面まで）
    TDETAIL: 0,        // かざり（0 帽子と体だけ・1 帽子の帯とスーツの襟・2 さらに帽子のへこみ・ネクタイ・サングラス）
    TCLOAK: 0,         // マント（0 なし・1 あり）
    TPOSE: 1,          // 立ち方（0 戸口にもたれて手はポケット・1 もたれて腕組み・2 もたれて腕組み、脚も組む・3 腕組みで立つ・4 腕を下ろして立つ）
    // 追跡者（鬼）の角
    CHORN: 1,          // 角（0 なし・1 あり）
    CHL: 84,           // 角の長さ
  };

  const KNOBS = [
    { key: "HGT", label: "身長", group: "からだ", min: 520, max: 900, step: 1 },
    { key: "HR", label: "頭の大きさ", group: "からだ", min: 36, max: 100, step: 1 },
    { key: "LEGR", label: "脚の長さ（胴に対して）", group: "からだ", min: 0.42, max: 0.78, step: 0.005 },
    { key: "ARMR", label: "腕の長さ（脚に対して）", group: "からだ", min: 0.6, max: 1.1, step: 0.005 },
    { key: "TWF", label: "胴の幅", group: "からだ", min: 120, max: 280, step: 1 },
    { key: "LIMB", label: "手足の太さ", group: "太さと形", min: 44, max: 140, step: 1 },
    { key: "HG", label: "頭と胴のすき間", group: "太さと形", min: 0, max: 60, step: 1 },
    { key: "AG", label: "腕と胴のすき間（正面）", group: "太さと形", min: 0, max: 50, step: 1 },
    { key: "TR", label: "胴の角の丸み", group: "太さと形", min: 0, max: 100, step: 1 },
    { key: "OG", label: "重なりのすき間（横向き）", group: "太さと形", min: 0, max: 40, step: 1 },
    { key: "CAP", label: "手足の端（0 角・1 丸）", group: "太さと形", min: 0, max: 1, step: 1 },
    { key: "HSQ", label: "頭の形（0 四角・1 丸）", group: "太さと形", min: 0, max: 1, step: 0.05 },
    { key: "T", label: "線の厚さ", group: "線と拍", min: 0, max: 70, step: 1 },
    { key: "BEAT", label: "拍（秒）", group: "線と拍", min: 0.3, max: 1.0, step: 0.05 },
    { key: "RLEAN", label: "体の傾き", group: "走り", min: 8, max: 52, step: 1 },
    { key: "RSTEP", label: "1歩の長さ（拍）", group: "走り", min: 1, max: 8, step: 1 },
    { key: "RKNEE", label: "前の膝の高さ", group: "走り", min: 30, max: 100, step: 1 },
    { key: "RARM", label: "腕の振り", group: "走り", min: 0.3, max: 1.8, step: 0.05 },
    { key: "RFLY", label: "すれ違うときの浮き", group: "走り", min: 0, max: 110, step: 1 },
    { key: "TBRIM", label: "帽子のつば", group: "第三勢力", min: 2.2, max: 4.4, step: 0.05 },
    { key: "TCROWN", label: "帽子の高さ", group: "第三勢力", min: 0.6, max: 2.0, step: 0.05 },
    { key: "THEM", label: "マントの丈", group: "第三勢力", min: 0.6, max: 1.8, step: 0.02 },
    { key: "TFLARE", label: "マントの裾の広がり", group: "第三勢力", min: 1.0, max: 1.7, step: 0.02 },
    { key: "TCOLLAR", label: "立て襟（0 なし・1 あり）", group: "第三勢力", min: 0, max: 1, step: 1 },
    { key: "TFACE", label: "顔（0 隠す・1 見せる）", group: "第三勢力", min: 0, max: 1, step: 1 },
    { key: "THAT", label: "帽子の形", group: "第三勢力", min: 0, max: 4, step: 1 },
    { key: "THEMS", label: "マントの裾", group: "第三勢力", min: 0, max: 2, step: 1 },
    { key: "TDETAIL", label: "かざり", group: "第三勢力", min: 0, max: 2, step: 1 },
    { key: "TCLOAK", label: "マント", group: "第三勢力", min: 0, max: 1, step: 1 },
    { key: "TPOSE", label: "立ち方", group: "第三勢力", min: 0, max: 4, step: 1 },
    { key: "CHORN", label: "角", group: "追跡者", min: 0, max: 1, step: 1 },
    { key: "CHL", label: "角の長さ", group: "追跡者", min: 20, max: 140, step: 1 },
  ];

  // 骨の長さを身長・脚の割合・腕の割合から出す
  function derive(P0) {
    const K = Object.assign({}, DEFAULTS, P0 || {});
    const avail = Math.max(140, K.HGT - K.LIMB / 2 - K.HG - 2 * K.HR);
    const legs = avail * K.LEGR, TL = avail - legs;
    const TH = legs * 160 / 315, SH = legs - TH;
    const arms = legs * K.ARMR, UA = arms * 135 / 260, FA = arms - UA;
    return Object.assign(K, { TL, TH, SH, UA, FA, TWS: K.TWF * 150 / 210 });
  }

  const COLORS = {
    tsuki: ["--tsuki", "#f1ede4"],
    muted: ["--tsuki-muted", "#a29d93"],
    oni: ["--shu", "#ff6a3d"],
    beacon: ["--chikko", "#b8ff5a"],
    third: ["--ayame", "#c45cff"],   // 第三勢力（菖蒲）
  };
  const col = (c) => `var(${COLORS[c][0]},${COLORS[c][1]})`;
  const r1 = (v) => Math.round(v * 10) / 10;
  const rad = (d) => (d * Math.PI) / 180;
  const sin = (d) => Math.sin(rad(d)), cos = (d) => Math.cos(rad(d));

  // ---- ポーズの道具 ----
  function swap(p) { return Object.assign({}, p, { aL: p.aR, aR: p.aL, lL: p.lR, lR: p.lL }); }
  function mirror(p) {   // 正面の左右反転
    const m = (a) => [-a[0], -a[1]];
    return Object.assign({}, p, { lean: -(p.lean || 0), aL: m(p.aR), aR: m(p.aL), lL: m(p.lR), lR: m(p.lL) });
  }
  function mix(a, b, k) {  // 2つのポーズの間
    const l = (x, y) => x + (y - x) * k, l2 = (x, y) => [l(x[0], y[0]), l(x[1], y[1])];
    return { v: a.v, lean: l(a.lean || 0, b.lean || 0), lift: l(a.lift || 0, b.lift || 0), aL: l2(a.aL, b.aL), aR: l2(a.aR, b.aR), lL: l2(a.lL, b.lL), lR: l2(a.lR, b.lR) };
  }

  // ---- 基本のポーズ（角度だけ） ----
  const P = {};
  P.stand = { v: "F", lean: 0, aL: [-10, -10], aR: [10, 10], lL: [-7, -7], lR: [7, 7] };
  P.oni = { v: "F", lean: 0, aL: [-105, -160], aR: [105, 160], lL: [-16, -6], lR: [16, 6] };
  P.oni2 = { v: "F", lean: 0, aL: [-95, -145], aR: [95, 145], lL: [-16, -6], lR: [16, 6] };
  P.wave1 = { v: "F", lean: 0, aL: [-10, -10], aR: [140, 160], lL: [-7, -7], lR: [7, 7] };
  P.wave2 = { v: "F", lean: 0, aL: [-10, -10], aR: [140, 205], lL: [-7, -7], lR: [7, 7] };
  P.win1 = { v: "F", lean: 0, aL: [-150, -165], aR: [150, 165], lL: [-10, -4], lR: [10, 4] };
  P.win2 = { v: "F", lean: 0, aL: [-140, -150], aR: [140, 150], lL: [-14, 4], lR: [14, -4], lift: 70 };
  P.grip = { v: "F", lean: 0, aL: [-140, -178], aR: [140, 178], lL: [-8, -8], lR: [8, 8] };
  P.grip2 = { v: "F", lean: 0, aL: [-136, -172], aR: [144, 182], lL: [-8, -8], lR: [8, 8] };
  // 走る（横向き）：A＝手前の脚が前、B＝すれ違い
  P.runA = { v: "S", lean: 20, aL: [46, 128], aR: [-56, 28], lL: [-30, -84], lR: [58, -8] };
  P.runB = { v: "S", lean: 20, aL: [12, 62], aR: [-16, 18], lL: [28, -78], lR: [4, -8], lift: 14 };
  // 歩く
  P.walkA = { v: "S", lean: 5, aL: [36, 62], aR: [-36, -18], lL: [-26, -40], lR: [26, 14] };
  P.walkB = { v: "S", lean: 5, aL: [6, 22], aR: [-8, 4], lL: [16, -32], lR: [0, -2], lift: 6 };
  // 構え（よーい）
  P.ready = { v: "S", lean: 30, aL: [-48, -12], aR: [34, 104], lL: [-26, -44], lR: [44, -2] };
  P.ready2 = { v: "S", lean: 34, aL: [-52, -16], aR: [38, 110], lL: [-28, -48], lR: [48, -4], lift: -8 };
  // しゃがむ（隠れる）
  P.crouch = { v: "S", lean: 34, aL: [30, 120], aR: [44, 128], lL: [96, -10], lR: [88, -14] };
  P.peek = { v: "S", lean: 4, aL: [100, 160], aR: [112, 168], lL: [44, -6], lR: [40, -10] };
  // タッチ（手を前へ伸ばす）
  P.reach = { v: "S", lean: 22, aL: [-48, 8], aR: [92, 96], lL: [-34, -56], lR: [58, 10] };
  P.reach0 = { v: "S", lean: 18, aL: [-50, 16], aR: [38, 122], lL: [-34, -56], lR: [58, 10] };
  // 静かに（手前の手を口へ）
  P.toeA = { v: "S", lean: 8, aL: [26, 140], aR: [62, 187], lL: [-14, -34], lR: [52, -22], lift: 22 };
  P.toeB = { v: "S", lean: 8, aL: [30, 146], aR: [60, 184], lL: [44, -28], lR: [-10, -30], lift: 22 };
  // スローモーションで走る。体全体を斜め 38° の一本の線にする（後ろ脚は胴とまっすぐ、前の膝は高く）
  P.slowA = { v: "S", lean: 36, aL: [50, 135], aR: [-85, -40], lL: [-36, -40], lR: [66, -8] };
  P.slowP = { v: "S", lean: 34, aL: [18, 98], aR: [-46, -14], lL: [36, -50], lR: [-14, -30], lift: 46 };
  // 忍び足（抜き足差し足）。Key：手前の膝を高く上げてつま先立ち（決めポーズ）、A・B：踏み出したところ
  P.sneakKey = { v: "S", lean: 14, aL: [24, 98], aR: [44, 104], lL: [4, -14], lR: [88, -12], lift: 26 };
  P.sneakKeyL = { v: "S", lean: 14, aL: [28, 102], aR: [40, 100], lL: [88, -12], lR: [4, -14], lift: 26 };
  P.sneakA = { v: "S", lean: 16, aL: [26, 100], aR: [40, 100], lL: [-22, -56], lR: [40, 6] };
  P.sneakB = { v: "S", lean: 16, aL: [26, 100], aR: [40, 100], lL: [40, 6], lR: [-22, -56] };
  // 探す（懐中電灯で前を照らして歩く）
  P.searchA = { v: "S", lean: 6, aL: [-24, -12], aR: [62, 86], lL: [-20, -32], lR: [22, 10] };
  P.searchB = { v: "S", lean: 6, aL: [-8, 0], aR: [58, 74], lL: [22, 10], lR: [-20, -32], lift: 4 };
  // 戸口に立ちはだかる（追跡者）
  P.block = { v: "F", lean: 0, aL: [-125, -120], aR: [125, 120], lL: [-20, -12], lR: [20, 12] };
  P.block2 = { v: "F", lean: 0, aL: [-120, -112], aR: [120, 112], lL: [-22, -14], lR: [22, 14], lift: -8 };
  // 隠れる
  P.ball = { v: "S", lean: 60, aL: [58, 140], aR: [70, 150], lL: [100, -12], lR: [94, -14] };
  P.hug = { v: "S", lean: 38, aL: [50, 122], aR: [36, 106], lL: [142, 12], lR: [134, 6] };
  P.hug2 = { v: "S", lean: 34, aL: [50, 122], aR: [36, 106], lL: [142, 12], lR: [134, 6], lift: 4 };
  P.hush = { v: "S", lean: 20, aL: [28, 170], aR: [40, 177], lL: [142, 12], lR: [134, 6] };
  P.hush2 = { v: "S", lean: 16, aL: [28, 170], aR: [40, 177], lL: [142, 12], lR: [134, 6], lift: 5 };
  P.peekW = { v: "S", lean: 6, aL: [108, 155], aR: [118, 165], lL: [62, -18], lR: [56, -22] };
  P.hideIn = { v: "S", lean: 0, aL: [-4, 0], aR: [24, 70], lL: [-6, -6], lR: [6, 6] };
  P.leanOut = { v: "S", lean: 40, aL: [-10, -6], aR: [72, 128], lL: [-6, -6], lR: [12, 4] };
  P.prone = { v: "S", lean: 86, aL: [72, 140], aR: [80, 150], lL: [-88, -92], lR: [-84, -90] };
  P.prone2 = { v: "S", lean: 86, aL: [80, 150], aR: [72, 140], lL: [-88, -92], lR: [-84, -90] };
  P.breath = { v: "S", lean: 56, aL: [54, 172], aR: [62, 178], lL: [100, -12], lR: [94, -14] };
  P.breath2 = { v: "S", lean: 52, aL: [54, 172], aR: [62, 178], lL: [100, -12], lR: [94, -14], lift: 6 };
  P.shhS = { v: "S", lean: 8, aL: [100, 150], aR: [60, 186], lL: [62, -18], lR: [56, -22] };
  // 止まる（捕まった瞬間）
  P.freeze = { v: "S", lean: -8, aL: [-160, -176], aR: [152, 170], lL: [-10, -16], lR: [12, 4] };
  // 第三勢力：マントの中で腕を下ろして立つ。わずかに左右へゆらぐ
  P.cloak = { v: "F", lean: -2, aL: [-8, -6], aR: [8, 6], lL: [-11, -7], lR: [11, 7] };
  P.cloak2 = { v: "F", lean: 2, aL: [-8, -6], aR: [8, 6], lL: [-11, -7], lR: [11, 7] };
  // 第三勢力（マフィア）：手を腰に当てて、ひじを張って立つ。帽子のつばに手をかける
  P.boss = { v: "F", lean: 0, aL: [-40, 50], aR: [40, -50], lL: [-13, -8], lR: [13, 8] };
  P.boss2 = { v: "F", lean: 0, aL: [-40, 50], aR: [150, 196], lL: [-13, -8], lR: [13, 8] };
  P.pocket = { v: "F", lean: -8, aL: [-7, 5], aR: [9, -3], lL: [6, 6], lR: [13, 11] };        // 戸口にもたれて、手はポケット
  P.pocket2 = { v: "F", lean: -10, aL: [-7, 5], aR: [9, -3], lL: [6, 6], lR: [13, 11] };
  P.lounge = { v: "F", lean: -7, aL: [10, 94], aR: [-8, -86], lL: [6, 6], lR: [13, 11] };      // 戸口にもたれて腕組み（脚はまっすぐ）
  P.lounge2 = { v: "F", lean: -10, aL: [10, 94], aR: [-8, -86], lL: [6, 6], lR: [13, 11] };
  P.loungeX = { v: "F", lean: -7, aL: [10, 94], aR: [-8, -86], lL: [6, 2], lR: [-22, 4] };     // 戸口にもたれて腕組み、脚を組む
  P.loungeX2 = { v: "F", lean: -10, aL: [10, 94], aR: [-8, -86], lL: [6, 2], lR: [-22, 4] };
  P.fold = { v: "F", lean: 0, aL: [12, 96], aR: [-12, -84], lL: [-16, -9], lR: [16, 9] };     // 腕組みで立つ
  P.fold2 = { v: "F", lean: 2, aL: [12, 96], aR: [-12, -84], lL: [-16, -9], lR: [16, 9] };

  // ---- 骨格の計算 ----
  function geo(K) {
    const S0 = Math.round(K.H * K.SLIT - K.T / 2), S1 = S0 + K.T;
    const lineY = K.G - (S0 + S1) / 2;        // 線の中心（枠の上から）
    const navel = K.SLIT * (K.HGT || K.H);    // 人のへそ（足の裏から）＝身長の 0.618
    return { S0, S1, lineY, band: [K.G - S1, K.T], navel };
  }
  // 大きさ s の人の地面（へそが線に来る高さ）
  function ground(K, s = 1) { const g = geo(K); return g.lineY + g.navel * s; }
  function hipH(K, p) {
    const leg = (l) => K.TH * cos(l[0]) + K.SH * cos(l[1]);
    return Math.max(leg(p.lL), leg(p.lR)) + K.LIMB / 2 + (p.lift || 0);
  }
  function shoulders(K, v) {
    const y = -K.TL + K.LIMB / 2;
    if (v === "F") { const x = K.TWF / 2 + K.AG + K.LIMB / 2; return [[-x, y], [x, y]]; }
    return [[0, y], [0, y]];
  }
  function hips(K, v) {
    if (v === "F") { const x = K.LG / 2 + K.LIMB / 2; return [[-x, 0], [x, 0]]; }
    return [[0, 0], [0, 0]];
  }
  // 各関節の回転（SVG の rotate、入れ子の相対角）
  function rel(K, p) {
    const lean = p.lean || 0;
    return {
      hip: hipH(K, p), tor: lean,
      aLu: -p.aL[0] - lean, aLf: p.aL[0] - p.aL[1],
      aRu: -p.aR[0] - lean, aRf: p.aR[0] - p.aR[1],
      lLt: -p.lL[0], lLs: p.lL[0] - p.lL[1],
      lRt: -p.lR[0], lRs: p.lR[0] - p.lR[1],
    };
  }
  // 手・足などの位置（人の足もと原点、SVG 座標）
  function fk(K, p) {
    const h = hipH(K, p), lean = p.lean || 0;
    const rot = (pt) => [pt[0] * cos(lean) - pt[1] * sin(lean), pt[0] * sin(lean) + pt[1] * cos(lean)];
    const sh = shoulders(K, p.v).map((s) => { const q = rot(s); return [q[0], q[1] - h]; });
    const limb = (o, a, l1, l2) => { const e = [o[0] + l1 * sin(a[0]), o[1] + l1 * cos(a[0])]; return [e, [e[0] + l2 * sin(a[1]), e[1] + l2 * cos(a[1])]]; };
    const hp = hips(K, p.v).map((q) => [q[0], q[1] - h]);
    const head = rot([0, -(K.TL + K.HG + K.HR)]);
    return { hip: [0, -h], head: [head[0], head[1] - h], shL: sh[0], shR: sh[1],
      handL: limb(sh[0], p.aL, K.UA, K.FA)[1], handR: limb(sh[1], p.aR, K.UA, K.FA)[1],
      footL: limb(hp[0], p.lL, K.TH, K.SH)[1], footR: limb(hp[1], p.lR, K.TH, K.SH)[1] };
  }

  // ---- 身なり（第三勢力）：帽子とマント。寸法はすべて頭の半径・胴・手足の太さから決める ----
  const HATS = ["fedora", "hood", "witch", "kasa", "tengai"];   // 中折れ帽・フード・尖り帽子・笠・天蓋（虚無僧の深編笠）
  const HEMS = ["straight", "zigzag", "floor"];                   // 裾：まっすぐ・ぎざぎざ・地面まで
  // 第三勢力の身なりを、つまみの値から組み立てる
  function thirdWear(K) {
    const d = Math.round(K.TDETAIL), face = K.TFACE >= 0.5, shades = face && d >= 2, tp = Math.round(K.TPOSE);
    return { hat: HATS[Math.round(K.THAT)] || "fedora", band: d >= 1, pinch: d >= 2, suit: d >= 1, tie: d >= 2, shades, cloak: K.TCLOAK >= 0.5,
      armGap: tp >= 1 && tp <= 3, legGap: tp === 2,
      hemStyle: HEMS[Math.round(K.THEMS)] || "straight", collar: K.TCOLLAR >= 0.5, face, brim: K.TBRIM, crown: K.TCROWN, hem: K.THEM, flare: K.TFLARE,
      brimY: shades ? 0.55 : face ? 0.18 : 0.05 };
  }
  const ptsPath = (pts) => "M" + pts.map((q) => `${r1(q[0])},${r1(q[1])}`).join(" L") + " Z";
  // 帽子。頭に重なるところは、まわりを地の色で切って分ける
  function hatSVG(K, hy, GND, W) {
    const R = K.HR, gap = Math.max(K.HG, 8), type = W.hat === true ? "fedora" : W.hat;
    const cut = (d) => `<path d="${d}" fill="${GND}" stroke="${GND}" stroke-width="${2 * gap}" stroke-linejoin="round"/>`;
    const fill = (d, round = 0) => `<path d="${d}" fill="currentColor"${round ? ` stroke="currentColor" stroke-width="${r1(round)}" stroke-linejoin="round"` : ""}/>`;
    const crownK = W.crown || 1.25, brimK = W.brim || 3.2;
    if (type === "hood") {
      // フード：頭をすっぽり包み、上は少しとがる。顔のところは闇
      const sw = K.TWF / 2 + K.AG + K.LIMB * 1.05, yt = -K.TL - 6, s = crownK / 1.25;
      const d = `M${r1(-sw * 0.62)},${r1(yt + 30)} Q${r1(-R * 1.55)},${r1(yt - 10)} ${r1(-R * 1.45)},${r1(hy + R * 0.1)} ` +
        `Q${r1(-R * 1.35)},${r1(hy - R * 1.2 * s)} 0,${r1(hy - R * 1.62 * s)} Q${r1(R * 1.35)},${r1(hy - R * 1.2 * s)} ${r1(R * 1.45)},${r1(hy + R * 0.1)} ` +
        `Q${r1(R * 1.55)},${r1(yt - 10)} ${r1(sw * 0.62)},${r1(yt + 30)} Z`;
      let open = `<ellipse cx="0" cy="${r1(hy + R * 0.14)}" rx="${r1(R * 0.74)}" ry="${r1(R * 0.9)}" fill="${GND}"/>`;
      if (W.face) open += `<circle cx="0" cy="${r1(hy + R * 0.22)}" r="${r1(R * 0.56)}" fill="currentColor"/>`;
      return fill(d) + open;
    }
    if (type === "witch") {
      // 尖り帽子：細いつばと、高い円すい
      const bw = R * brimK * 1.06, bh = Math.max(14, R * 0.34), by = hy - R * 0.2, h = R * crownK * 2.1, yb = by - bh / 2 + 2;
      const cone = ptsPath([[-R * 0.95, yb], [R * 0.95, yb], [R * 0.38, yb - h]]);
      const brim = ptsPath([[-bw / 2, by - bh / 2], [bw / 2, by - bh / 2], [bw / 2, by + bh / 2], [-bw / 2, by + bh / 2]]);
      return cut(cone) + cut(brim) + fill(cone, R * 0.18) + fill(brim, bh * 0.6);
    }
    if (type === "kasa") {
      // 笠：浅く広い円すいで、目のあたりまで隠す
      const w = R * brimK * 0.68, yb = hy + R * 0.3, h = R * crownK * 1.15;
      const d = `M${r1(-w)},${r1(yb)} L0,${r1(yb - h)} L${r1(w)},${r1(yb)} Q0,${r1(yb + R * 0.24)} ${r1(-w)},${r1(yb)} Z`;
      return cut(d) + fill(d, R * 0.14);
    }
    if (type === "tengai") {
      // 天蓋（虚無僧の深編笠）：頭をまるごと覆う、すぼまった籠。編み目を地の色の横線で入れる
      const yb = -K.TL - 6 - gap, yt = hy - R * 1.25 * crownK / 1.25, wt = R * 0.8, wb = R * 1.1, rr = R * 0.62;
      const d = `M${r1(-wb)},${r1(yb)} L${r1(-wt)},${r1(yt + rr)} Q${r1(-wt)},${r1(yt)} ${r1(-wt + rr)},${r1(yt)} L${r1(wt - rr)},${r1(yt)} Q${r1(wt)},${r1(yt)} ${r1(wt)},${r1(yt + rr)} L${r1(wb)},${r1(yb)} Z`;
      const lw = Math.max(5, K.OG * 0.55);
      let weave = "";
      for (let i = 1; i <= 3; i++) { const y = yt + (yb - yt) * i / 4; weave += `<rect x="${r1(-wb - 4)}" y="${r1(y - lw / 2)}" width="${r1(2 * wb + 8)}" height="${r1(lw)}" fill="${GND}"/>`; }
      return cut(d) + fill(d) + weave;
    }
    // 中折れ帽：広いつばが顔の上を横切る。帯（地の色の細い帯）と、てっぺんのへこみは W.band・W.pinch
    const bw = R * brimK, bh = Math.max(18, R * 0.44), by = hy - R * (W.brimY != null ? W.brimY : 0.05);
    const wb = R * (W.crownW || 2.0), wt = wb * 0.84, ch = R * crownK, yb = by - bh / 2 + 2, yt = yb - ch, cr = R * 0.3;
    const crown = `M${r1(-wb / 2)},${r1(yb)} L${r1(-wt / 2)},${r1(yt + cr)} Q${r1(-wt / 2)},${r1(yt)} ${r1(-wt / 2 + cr)},${r1(yt)} L${r1(wt / 2 - cr)},${r1(yt)} Q${r1(wt / 2)},${r1(yt)} ${r1(wt / 2)},${r1(yt + cr)} L${r1(wb / 2)},${r1(yb)} Z`;
    const brim = (c, extra = "") => `<rect x="${r1(-bw / 2)}" y="${r1(by - bh / 2)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(bh / 2)}" fill="${c}"${extra}/>`;
    let crownD = crown;
    if (W.pinch) {   // てっぺんの真ん中を少しへこませる（中折れ）
      const dip = R * 0.2;
      crownD = `M${r1(-wb / 2)},${r1(yb)} L${r1(-wt / 2)},${r1(yt + cr)} Q${r1(-wt / 2)},${r1(yt)} ${r1(-wt / 2 + cr)},${r1(yt)} Q${r1(-wt * 0.12)},${r1(yt)} 0,${r1(yt + dip)} Q${r1(wt * 0.12)},${r1(yt)} ${r1(wt / 2 - cr)},${r1(yt)} Q${r1(wt / 2)},${r1(yt)} ${r1(wt / 2)},${r1(yt + cr)} L${r1(wb / 2)},${r1(yb)} Z`;
    }
    const bandH = Math.max(6, R * 0.2), band = W.band ? `<rect x="${r1(-wb / 2 - 4)}" y="${r1(yb - bandH - R * 0.12)}" width="${r1(wb + 8)}" height="${r1(bandH)}" fill="${GND}"/>` : "";
    return `<path d="${crownD}" fill="${GND}" stroke="${GND}" stroke-width="${2 * gap}" stroke-linejoin="round"/>` + brim(GND, ` stroke="${GND}" stroke-width="${2 * gap}"`) +
      `<path d="${crownD}" fill="currentColor"/>` + band + brim("currentColor");
  }
  // スーツ（正面）：胴に、開いた襟（地の色の V）と、ネクタイ
  function suitFront(K, GND, W) {
    const tw = K.TWF, top = -K.TL, vy = -K.TL * 0.42, vx = tw * 0.3, tw2 = Math.max(10, tw * 0.07);
    const v = `M${r1(-vx)},${r1(top - 2)} L${r1(vx)},${r1(top - 2)} L0,${r1(vy)} Z`;
    const tie = `M${r1(-tw2)},${r1(top + 4)} L${r1(tw2)},${r1(top + 4)} L${r1(tw2 * 1.5)},${r1(vy - 6)} L0,${r1(vy + tw2 * 1.6)} L${r1(-tw2 * 1.5)},${r1(vy - 6)} Z`;
    let out = `<path d="${v}" fill="${GND}"/>` + (W.tie === false ? "" : `<path d="${tie}" fill="currentColor"/>`);
    if (W.stripes) {   // 細い縦じま（大きく見せるとき用）
      const lw = Math.max(3, K.OG * 0.3);
      for (const f of [-0.36, -0.2, 0.2, 0.36]) out += `<rect x="${r1(tw * f - lw / 2)}" y="${r1(vy)}" width="${r1(lw)}" height="${r1(-vy - K.LIMB * 0.2)}" fill="${GND}"/>`;
    }
    return out;
  }
  // サングラス：顔を横切る地の色の帯（丸い眼鏡にはしない）
  function shadesSVG(K, hy, GND, W) {
    const R = K.HR, h = Math.max(10, R * 0.3), y = hy + R * 0.22;
    return `<rect x="${r1(-R - 6)}" y="${r1(y - h / 2)}" width="${r1(2 * R + 12)}" height="${r1(h)}" rx="${r1(h * 0.3)}" fill="${GND}"/>`;
  }
  // 裾の線（右端 → 左端）。ぎざぎざは4つの先がとがる
  function hemEdge(hw, yh, style, depth) {
    if (style !== "zigzag") return null;
    const pts = [], n = 4;
    for (let i = 0; i <= 2 * n; i++) pts.push([hw - (2 * hw) * i / (2 * n), i % 2 === 0 ? yh : yh - depth]);
    return pts;
  }
  // マント（正面）：肩から下へ広がる。前の合わせ目を地の色で細く切る。襟は顔の両わきに立つ
  function cloakFront(K, hy, GND, W, ground) {
    const style = W.hemStyle || "straight";
    const sw = K.TWF / 2 + K.AG + K.LIMB * 1.05, yt = -K.TL - 6, cr = K.LIMB * (W.round || 1.1);
    const yh = style === "floor" ? ground + 4 : K.TH * (W.hem != null ? W.hem : 1.3);
    const hw = sw * (W.flare || 1.32) * (style === "floor" ? 1.12 : 1);
    const ym = (yt + cr + yh) / 2, bc = Math.min(K.LIMB * 0.5, (yh - yt) * 0.1);
    const top = `M${r1(-sw)},${r1(yt + cr)} Q${r1(-sw)},${r1(yt)} ${r1(-sw + cr)},${r1(yt)} L${r1(sw - cr)},${r1(yt)} Q${r1(sw)},${r1(yt)} ${r1(sw)},${r1(yt + cr)} `;
    const zig = hemEdge(hw, yh, style, K.TH * 0.34);
    const body = zig
      ? top + `Q${r1(sw * 1.04)},${r1(ym)} ${r1(hw)},${r1(yh)} ` + zig.slice(1).map((q) => `L${r1(q[0])},${r1(q[1])}`).join(" ") + ` Q${r1(-sw * 1.04)},${r1(ym)} ${r1(-sw)},${r1(yt + cr)} Z`
      : top + `Q${r1(sw * 1.04)},${r1(ym)} ${r1(hw)},${r1(yh - bc)} Q${r1(hw)},${r1(yh)} ${r1(hw - bc)},${r1(yh)} L${r1(-hw + bc)},${r1(yh)} Q${r1(-hw)},${r1(yh)} ${r1(-hw)},${r1(yh - bc)} Q${r1(-sw * 1.04)},${r1(ym)} ${r1(-sw)},${r1(yt + cr)} Z`;
    const slitW = Math.max(6, K.OG * 0.8), slitTop = -K.TL * (W.slit != null ? W.slit : 0.4);
    let out = `<path d="${body}" fill="currentColor"/>` + `<rect x="${r1(-slitW / 2)}" y="${r1(slitTop)}" width="${r1(slitW)}" height="${r1(yh - slitTop + 2)}" fill="${GND}"/>`;
    if (W.collar && W.hat !== "hood" && W.hat !== "tengai") {
      const R = K.HR, gap = Math.max(K.HG, 8);
      const c = (sgn) => `M${r1(sgn * K.TWF * 0.16)},${r1(yt + 2)} L${r1(sgn * K.TWF * 0.62)},${r1(yt + 2)} L${r1(sgn * (R + gap + K.LIMB * 0.35))},${r1(hy + R * 0.05)} Z`;
      out += `<path d="${c(-1)}" fill="currentColor"/><path d="${c(1)}" fill="currentColor"/>`;
    }
    return out;
  }
  // マント（横向き）：肩から背中側へ流れて、膝の下で広がる
  function capeSide(K, W, ground) {
    const style = W.hemStyle || "straight";
    const yt = -K.TL - 6, yh = style === "floor" ? ground : K.TH * (W.hem != null ? W.hem : 1.3) * 0.85, back = K.TWS / 2;
    const x0 = -back - K.LIMB * (W.flow || 2.2), x1 = -K.TWS * 0.1;
    let d = `M${r1(K.TWS * 0.2)},${r1(yt)} L${r1(-back - 10)},${r1(yt)} L${r1(x0)},${r1(yh)} `;
    if (style === "zigzag") { const n = 3, dep = K.TH * 0.3; for (let i = 1; i <= 2 * n; i++) d += `L${r1(x0 + (x1 - x0) * i / (2 * n))},${r1(i % 2 ? yh - dep : yh)} `; }
    else d += `L${r1(x1)},${r1(yh)} `;
    return `<path d="${d}Z" fill="currentColor"/>`;
  }

  // ---- 人を描く ----
  // a: { id, pose, frames: [[t(0..1), pose], ...], beats, delay(0..1), x, s, facing, color, horns, half }
  function actorSVG(K, pid, n, a, css) {
    const key = a.pose || a.frames[0][1];
    const R = rel(K, key);
    const cls = (part) => `${pid}-${n}-${part}`;
    const animated = !!a.frames;
    const ty = (part, v) => (part === "hip" ? `translate(0,${r1(-v)})` : `rotate(${r1(v)})`);            // 属性（単位なし）
    const tc = (part, v) => (part === "hip" ? `translate(0px,${r1(-v)}px)` : `rotate(${r1(v)}deg)`);     // CSS（単位あり）
    const g = (part, inner, pre = "") => {
      const tr = ty(part, R[part]);
      return `${pre ? `<g transform="${pre}">` : ""}<g class="${cls(part)}" transform="${tr}">${inner}</g>${pre ? "</g>" : ""}`;
    };
    const cap = K.CAP ? "round" : "square";
    let pass = "fill";   // "gap"：手前の手足のまわりを地の色で太めに描いて、重なりを切る
    const L = (len) => pass === "gap"
      ? `<line x1="0" y1="0" x2="0" y2="${r1(len)}" stroke="var(--picto-ground,#0b0c10)" stroke-width="${K.LIMB + 2 * K.OG}" stroke-linecap="${cap}"/>`
      : `<line x1="0" y1="0" x2="0" y2="${r1(len)}" stroke="currentColor" stroke-width="${K.LIMB}" stroke-linecap="${cap}"/>`;
    const sh = shoulders(K, key.v), hp = hips(K, key.v);
    const torch = (side) => {
      if (!a.torch || side !== "R" || pass === "gap") return "";
      const w = K.LIMB * 0.36, y0 = K.FA, y1 = K.FA + K.LIMB * 0.9;
      return `<polygon points="${r1(-w * 0.6)},${r1(y1)} ${r1(w * 0.6)},${r1(y1)} ${r1(K.LIMB * 2.1)},${r1(y1 + K.HGT * 0.62)} ${r1(-K.LIMB * 2.1)},${r1(y1 + K.HGT * 0.62)}" fill="${col("beacon")}"/>` +
        `<rect x="${r1(-w)}" y="${r1(y0 - 10)}" width="${r1(2 * w)}" height="${r1(y1 - y0 + 10)}" fill="currentColor"/>`;
    };
    const arm = (side) => g(`a${side}u`, L(K.UA) + g(`a${side}f`, L(K.FA) + torch(side), `translate(0,${r1(K.UA)})`), `translate(${r1(sh[side === "L" ? 0 : 1][0])},${r1(sh[side === "L" ? 0 : 1][1])})`);
    const leg = (side) => g(`l${side}t`, L(K.TH) + g(`l${side}s`, L(K.SH), `translate(0,${r1(K.TH)})`), `translate(${r1(hp[side === "L" ? 0 : 1][0])},${r1(hp[side === "L" ? 0 : 1][1])})`);
    const tw = key.v === "F" ? K.TWF : K.TWS;
    const hy = -(K.TL + K.HG + K.HR);
    let head = K.HSQ >= 0.999 ? `<circle cx="0" cy="${r1(hy)}" r="${K.HR}" fill="currentColor"/>`
      : `<rect x="${-K.HR}" y="${r1(hy - K.HR)}" width="${2 * K.HR}" height="${2 * K.HR}" rx="${r1(K.HR * K.HSQ)}" fill="currentColor"/>`;
    // 追跡者（鬼）の角は2本。追跡者の色の人には、どの絵でも生える（つまみ CHORN）
    if (a.horns || (a.color === "oni" && K.CHORN >= 0.5)) {
      const L = K.CHL != null ? K.CHL : 84;
      const horn = (mid, half, tipAng) => {
        const p0 = [K.HR * sin(mid - half), hy - K.HR * cos(mid - half)], p1 = [K.HR * sin(mid + half), hy - K.HR * cos(mid + half)];
        const tip = [(K.HR + L) * sin(tipAng), hy - (K.HR + L) * cos(tipAng)];
        const inner = [K.HR * 0.55 * sin(mid), hy - K.HR * 0.55 * cos(mid)];
        return `<polygon points="${[p0, tip, p1, inner].map((q) => q.map(r1).join(",")).join(" ")}" fill="currentColor" stroke="currentColor" stroke-width="${r1(K.LIMB * 0.12)}" stroke-linejoin="round"/>`;
      };
      // 正面は左右に開く。横向きは2本とも頭の上で少し後ろへ反る（奥の角は少し前に見える）
      head += key.v === "S" ? horn(-22, 11, -46) + horn(10, 11, -12) : horn(-30, 12, -44) + horn(30, 12, 44);
    }
    const torso = `<rect x="${r1(-tw / 2)}" y="${r1(-K.TL)}" width="${r1(tw)}" height="${r1(K.TL)}" rx="${Math.min(K.TR, tw / 2, K.TL / 2)}" fill="currentColor"/>`;
    const withGap = (fn) => { if (key.v !== "S" || !(K.OG > 0)) return fn(); pass = "gap"; const gp = fn(); pass = "fill"; return gp + fn(); };
    const gapAlways = (fn) => { if (!(K.OG > 0)) return fn(); pass = "gap"; const gp = fn(); pass = "fill"; return gp + fn(); };
    let torsoG, body;
    // 身なり（第三勢力のマントと帽子）。正体を隠す印で、どの姿勢でも残る。"third" はつまみの値から作る
    const W = a.wear === "third" ? thirdWear(K) : a.wear;
    if (!W) {
      torsoG = g("tor", (key.v === "S" ? arm("L") : "") + torso + head + (key.v === "F" ? arm("L") + arm("R") : withGap(() => arm("R"))));
      body = g("hip", leg("L") + torsoG + withGap(() => leg("R")));
    } else {
      const GND = "var(--picto-ground,#0b0c10)";
      const hat = W.hat ? hatSVG(K, hy, GND, W) : "";
      const face = W.hat && W.face === false ? "" : head;
      if (key.v === "F") {
        // 正面：マントは脚の上の方と腕を覆う。脚 → 胴 → 腕 → マント → 顔 → 帽子の順に描く
        const arms = W.armGap ? gapAlways(() => arm("L") + arm("R")) : arm("L") + arm("R");
        torsoG = g("tor", torso + (W.suit ? suitFront(K, GND, W) : "") + arms + (W.cloak ? cloakFront(K, hy, GND, W, R.hip) : "") + face + (W.shades && face ? shadesSVG(K, hy, GND, W) : "") + hat);
        body = g("hip", leg("L") + (W.legGap ? gapAlways(() => leg("R")) : leg("R")) + torsoG);
      } else {
        // 横向き：マントは背中から後ろへ流れる。体のいちばん奥に描く（胴と同じ回転）
        const cape = W.cloak ? g("tor", capeSide(K, W, R.hip)) : "";
        torsoG = g("tor", arm("L") + torso + face + hat + withGap(() => arm("R")));
        body = g("hip", cape + leg("L") + torsoG + withGap(() => leg("R")));
      }
    }
    // 動き
    if (animated) {
      const parts = ["hip", "tor", "aLu", "aLf", "aRu", "aRf", "lLt", "lLs", "lRt", "lRs"];
      const dur = r1((a.beats || 1) * K.BEAT * 1000) / 1000;
      const delay = a.delay ? `-${r1(a.delay * dur * 1000) / 1000}s` : "0s";
      const rels = a.frames.map(([t, p, e]) => [t, rel(K, p), e]);
      for (const part of parts) {
        const vals = rels.map(([, r]) => r[part]);
        if (vals.every((v) => Math.abs(v - vals[0]) < 0.05) && Math.abs(vals[0] - R[part]) < 0.05) continue;
        const name = cls(part);
        css.push(`.${name}{animation:${name} ${dur}s ${a.ease || "ease-in-out"} ${delay} infinite}`);
        css.push(`@keyframes ${name}{${rels.map(([t, r, e]) => `${r1(t * 100)}%{transform:${tc(part, r[part])}${e ? `;animation-timing-function:${e}` : ""}}`).join("")}}`);
      }
    }
    const s = a.s || 1;
    // へそを線に合わせる。align: "navel" は、傾いた体のへそ（胴の上の点）を線に合わせる
    let gy = a.gy != null ? a.gy : ground(K, s);
    if (a.gy == null && a.align === "navel") {
      const dN = geo(K).navel - (K.TH + K.SH + K.LIMB / 2);
      gy = geo(K).lineY + (hipH(K, key) + dN * cos(key.lean || 0)) * s;
    }
    const flip = a.facing === -1 ? " scale(-1,1)" : "";
    const color = col(a.color || "tsuki");
    let inner = body;
    if (a.move) {
      const name = cls("mv");
      const dur = r1((a.move.beats || a.beats || 1) * K.BEAT * 1000) / 1000;
      const delay = a.move.delay ? `-${r1(a.move.delay * dur * 1000) / 1000}s` : "0s";
      const st = a.move.static || {};
      const attrs = `${st.opacity != null ? ` opacity="${st.opacity}"` : ""}${st.dx || st.dy ? ` transform="translate(${st.dx || 0},${st.dy || 0})"` : ""}`;
      css.push(`.${name}{animation:${name} ${dur}s ${a.move.ease || "linear"} ${delay} infinite}`);
      css.push(`@keyframes ${name}{${a.move.keys.map((k) => `${r1(k.t * 100)}%{${k.dx != null || k.dy != null ? `transform:translate(${k.dx || 0}px,${k.dy || 0}px);` : ""}${k.o != null ? `opacity:${k.o};` : ""}${k.c ? `color:${col(k.c)};` : ""}}`).join("")}}`);
      inner = `<g class="${name}"${attrs}>${body}</g>`;
    }
    return `<g transform="translate(${r1(a.x)},${r1(gy)}) scale(${s})${flip}" style="color:${color}">${inner}</g>`;
  }

  // ---- 1枚の絵 ----
  function picto(K, def) {
    const pid = def.id, css = [];
    const gm = geo(K);
    const parts = [];
    (def.actors || []).forEach((a, i) => parts.push(actorSVG(K, pid, i, a, css)));
    let props = "", over = "";
    if (def.props) { const pr = def.props(K, gm, pid, css, col); props = pr.under || ""; over = pr.over || ""; }
    const holes = def.holes ? def.holes(K, gm) : "";
    const band = gm.band;
    const mask = `<mask id="${pid}-line" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000"><rect width="1000" height="1000" fill="#fff"/>${K.T > 0 && !def.noLine ? `<rect x="0" y="${band[0]}" width="1000" height="${band[1]}" fill="#000"/>` : ""}${holes}</mask>`;
    const body = `<g mask="url(#${pid}-line)">${props}${parts.join("")}${over}</g>`;
    const style = css.length ? `<style>${css.join("")}@media (prefers-reduced-motion:reduce){#up-${pid} *{animation:none!important}}</style>` : "";
    const title = `<title>${def.name}</title>`;
    const open = `<svg xmlns="http://www.w3.org/2000/svg" id="up-${pid}" viewBox="0 0 1000 1000" role="img" aria-label="${def.name}">`;
    return {
      id: pid, name: def.name, group: def.group, note: def.note || "", beats: def.beats || 0,
      svg: `${open}${title}${style}<defs>${mask}</defs>${body}</svg>`,
      svgStatic: `${open}${title}<defs>${mask}</defs>${body}</svg>`,
    };
  }

  // ---- 小道具 ----
  const rect = (x, y, w, h, c, extra = "") => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${c}"${extra}/>`;

  // ---- 絵の一覧 ----
  function defs(K) {
    const gm = geo(K);
    const D = [];
    const run4 = [[0, P.runA], [0.25, P.runB], [0.5, swap(P.runA)], [0.75, swap(P.runB)], [1, P.runA]];
    const walk4 = [[0, P.walkA], [0.25, P.walkB], [0.5, swap(P.walkA)], [0.75, swap(P.walkB)], [1, P.walkA]];
    // 決めポーズの近くでゆっくり、すれ違うところは速く（ease-in で離れ、ease-out で着く）
    // 走りはつまみから作る。後ろ脚はいつも胴とまっすぐ（傾きと同じ角度）
    const runA = { v: "S", lean: K.RLEAN, aL: [50 * K.RARM, 50 * K.RARM + 85], aR: [-85 * K.RARM, -85 * K.RARM + 45],
      lL: [-K.RLEAN, -K.RLEAN - 4], lR: [K.RKNEE, K.RKNEE - 74] };
    const runP = { v: "S", lean: K.RLEAN - 2, aL: [18 * K.RARM, 18 * K.RARM + 80], aR: [-46 * K.RARM, -46 * K.RARM + 32],
      lL: [K.RKNEE * 0.55, K.RKNEE * 0.55 - 86], lR: [-K.RLEAN * 0.4, -K.RLEAN * 0.4 - 16], lift: K.RFLY };
    const RB = 2 * K.RSTEP;   // 2歩の拍
    const grabA = Object.assign({}, runA, { aL: [88, 96] }), grabP = Object.assign({}, runP, { aL: [80, 92] });
    // 止めた姿（決めポーズ）は、手前の腕が前に来る瞬間。奥の腕が前に来る瞬間は、手が頭に重なって読みにくい
    const runK = swap(runA), grabK = Object.assign(swap(runA), { aR: [88, 96] });
    const grab8 = [[0, grabA, "ease-in"], [0.25, grabP, "ease-out"], [0.5, grabK, "ease-in"], [0.75, Object.assign(swap(runP), { aR: [80, 92] }), "ease-out"], [1, grabA]];
    const slow8 = [[0, runA, "ease-in"], [0.25, runP, "ease-out"], [0.5, swap(runA), "ease-in"], [0.75, swap(runP), "ease-out"], [1, runA]];
    const sneak4 = [[0, P.sneakKey], [0.25, P.sneakA], [0.5, P.sneakKeyL], [0.75, P.sneakB], [1, P.sneakKey]];
    const search4 = [[0, P.searchA], [0.5, P.searchB], [1, P.searchA]];

    // 役：非常口の考え方（人が戸口を抜ける）を骨格で描き直したもの。戸口は追跡者の手が届く幅
    const sc = 0.88, fb = fk(K, P.block);
    const doorHalf = (Math.abs(fb.handL[0]) + K.LIMB * 0.2) * sc, doorW = K.LIMB * 0.5 * sc;
    const doorway = (cx, half, s) => {
      const gr = ground(K, s), top = gr - (K.HGT + 70) * s;
      return `<g style="color:${col("muted")}">` +
        rect(cx - half - doorW / 2, top, doorW, gr - top, "currentColor") + rect(cx + half - doorW / 2, top, doorW, gr - top, "currentColor") +
        rect(cx - half - doorW / 2, top, 2 * half + doorW, doorW, "currentColor") + `</g>`;
    };
    D.push({ id: "chaser", group: "役", name: "追跡者", note: "警察・鬼。戸口に立ちはだかって、出口をふさぐ。朱", beats: 2,
      actors: [{ x: 500, s: sc, color: "oni", pose: P.block, beats: 2, frames: [[0, P.block], [0.5, P.block2], [1, P.block]] }],
      props: () => ({ under: doorway(500, doorHalf, sc) }) });
    D.push({ id: "runner", group: "役", name: "逃走者", note: `泥棒・逃走者。斜めの体でスローモーションのまま戸口を抜けていく。月白。${RB}拍で2歩`, beats: RB,
      actors: [{ x: 330 + (K.TWF * 0.6 + K.LIMB) * sc + 10, s: sc, align: "navel", pose: runK, beats: RB, frames: slow8 }],
      props: () => ({ under: doorway(300, (K.TWF * 0.6 + K.LIMB) * sc, sc) }) });
    {
      // 第三勢力（マフィア）：中折れ帽・スーツ・サングラス。逃走者が出ていく戸口の外で待つ。菖蒲
      const half = (K.TWF * 0.6 + K.LIMB) * sc, tp = Math.round(K.TPOSE);
      const post = 300 + half + doorW / 2;
      const set = [
        { x: post + 112, pose: P.pocket, frames: [[0, P.pocket], [0.5, P.pocket2], [1, P.pocket]], note: "戸口の外で、柱にもたれて手をポケットに入れて待つ。4拍で帽子ごと少しうつむく" },
        { x: post + 150, pose: P.lounge, frames: [[0, P.lounge], [0.5, P.lounge2], [1, P.lounge]], note: "戸口の外で、柱にもたれて腕を組んで待つ。4拍で帽子ごと少しうつむく" },
        { x: post + 150, pose: P.loungeX, frames: [[0, P.loungeX], [0.5, P.loungeX2], [1, P.loungeX]], note: "戸口の外で、柱にもたれて腕と脚を組んで待つ。4拍で帽子ごと少しうつむく" },
        { x: 700, pose: P.fold, frames: [[0, P.fold], [0.5, P.fold2], [1, P.fold]], note: "戸口の外で、腕を組んで立ちはだかる。4拍で少しゆれる" },
        { x: 700, pose: P.cloak, frames: [[0, P.cloak], [0.5, P.cloak2], [1, P.cloak]], note: "戸口の外に立って待つ。4拍でゆれる" },
      ][Math.max(0, Math.min(4, tp))];
      D.push({ id: "third", group: "役", name: "第三勢力", note: `正体を隠した者（マフィア）。${set.note}。菖蒲`, beats: 4,
        actors: [{ x: set.x, s: sc, color: "third", wear: "third", pose: set.pose, beats: 4, frames: set.frames }],
        props: () => ({ under: doorway(300, half, sc) }) });
    }
    // 衛生兵は2つの層にいる。線があればゲームの役、線がなければ現実の救護（ゲームの外）
    const crossHoles = (K2, g2) => { const top = ground(K2, 1) - hipH(K2, P.wave1) - K2.TL, cx = 500, cy = (top + g2.band[0]) / 2, a = 22, b = 62; return rect(cx - a / 2, cy - b / 2, a, b, "#000") + rect(cx - b / 2, cy - a / 2, b, a, "#000"); };
    D.push({ id: "medic", group: "役", name: "衛生兵", note: "ゲームの中の衛生兵。胸に十字の抜き。手を振って居場所を知らせる。何ができる役かは未定", beats: 2,
      actors: [{ x: 500, pose: P.wave1, beats: 2, frames: [[0, P.wave1], [0.5, P.wave2], [1, P.wave1]] }],
      holes: crossHoles });
    D.push({ id: "aid", group: "ゲームの外", name: "救護", noLine: true, note: "現実の救護（ゲームの外の衛生兵）。けがや気分が悪いときはこの人へ。線を通さない", beats: 2,
      actors: [{ x: 500, pose: P.wave1, beats: 2, frames: [[0, P.wave1], [0.5, P.wave2], [1, P.wave1]] }],
      holes: crossHoles });

    // 動き
    D.push({ id: "run", group: "動き", name: "逃げる", note: `スローモーション。体は斜め ${K.RLEAN}° の一本の線。${RB}拍（${r1(RB * K.BEAT)}秒）で2歩`, beats: RB,
      actors: [{ x: 440, align: "navel", pose: runK, beats: RB, frames: slow8 }] });
    D.push({ id: "sneak", group: "動き", name: "忍び足", note: "逃げる側の歩き方。抜き足差し足で、手は胸の前。4拍で2歩", beats: 4,
      actors: [{ x: 470, pose: P.sneakKey, beats: 4, frames: sneak4 }] });
    D.push({ id: "search", group: "動き", name: "探す", note: "追う側の歩き方。懐中電灯で前を照らして歩く。2拍で2歩", beats: 2,
      actors: [{ x: 330, color: "oni", torch: true, pose: P.searchA, beats: 2, frames: search4 }] });
    D.push({ id: "chase", group: "動き", name: "追う", note: `スローモーションの追いかけ。追跡者が後ろで手を伸ばし、逃走者が前。半周ずらして走る。${RB}拍で2歩`, beats: RB,
      actors: [{ x: 235, s: 0.66, align: "navel", color: "oni", pose: grabK, beats: RB, frames: grab8, delay: 0.5 },
               { x: 700, s: 0.66, align: "navel", pose: runK, beats: RB, frames: slow8 }] });
    {
      // タッチ：鬼の手が逃走者の背中に届く。届いた瞬間に逃走者が止まって両手を上げ、色が抜ける
      const s = 0.74, oniX = 270;
      const f = fk(K, P.reach);
      const hand = [oniX + (f.handR[0] + K.LIMB * 0.45) * s, f.handR[1] * s];
      // 逃走者（止まった姿）の背中：胴の後ろの縁、肩より少し下
      const fz = P.freeze, hz = hipH(K, fz), lz = fz.lean || 0;
      const bp = [-K.TWS / 2, -K.TL * 0.7];
      const back = [bp[0] * cos(lz) - bp[1] * sin(lz), bp[0] * sin(lz) + bp[1] * cos(lz) - hz];
      const runX = hand[0] - back[0] * s;
      const run8 = [[0, P.sneakKey], [0.25, P.sneakA], [0.5, P.sneakKeyL], [0.56, P.freeze], [0.9, P.freeze], [1, P.sneakKey]];
      D.push({ id: "touch", group: "動き", name: "タッチ", note: "4拍：歩いて近づく→手を伸ばす→背中に触れる→止まって両手を上げる", beats: 4,
        actors: [
          { x: oniX, s, color: "oni", pose: P.reach, beats: 4, frames: [[0, P.searchA], [0.25, P.searchB], [0.5, P.reach], [0.9, P.reach], [1, P.searchA]],
            move: { beats: 4, keys: [{ t: 0, dx: -90 }, { t: 0.5, dx: 0 }, { t: 0.9, dx: 0 }, { t: 1, dx: -90 }] } },
          { x: runX, s, pose: P.freeze, beats: 4, frames: run8,
            move: { beats: 4, keys: [{ t: 0, c: "tsuki" }, { t: 0.52, c: "tsuki" }, { t: 0.58, c: "muted" }, { t: 0.92, c: "muted" }, { t: 1, c: "tsuki" }], static: {} } },
        ],
        props: (K2, g2, pid, css) => {
          // 触れたところの火花（3本）。手の先から外へ
          const gy = g2.lineY + g2.navel * s;
          const px = hand[0], py = gy + hand[1];
          const rays = [-58, -18, 22].map((ang) => `<g transform="translate(${r1(px)},${r1(py)}) rotate(${ang})"><rect x="78" y="-15" width="92" height="30" rx="15" fill="currentColor"/></g>`).join("");
          css.push(`.${pid}-spark{animation:${pid}-spark ${4 * K2.BEAT}s linear infinite;transform-origin:${r1(px)}px ${r1(py)}px}@keyframes ${pid}-spark{0%,50%{opacity:0;transform:scale(.5)}55%{opacity:1;transform:scale(1)}72%{opacity:0;transform:scale(1.2)}100%{opacity:0}}`);
          return { over: `<g class="${pid}-spark" style="color:${col("beacon")}">${rays}</g>` };
        } });
    }
    // 隠れる：隠れている人は線より下（裏）にいる。頭を線より上（表）に出すと、のぞいている
    {
      const top = gm.band[0] + gm.band[1];            // 壁の上端＝線の下の縁
      const wall = (x0, x1, s = 1) => rect(x0, top, x1 - x0, ground(K, s) - top + 1, col("muted"), ` rx="8"`);
      const below = (pose, sMax) => {           // 頭のてっぺんが線の下の縁より 20 下に来る大きさ
        const f = fk(K, pose), headTop = -(f.head[1] - K.HR);   // 地面からの高さ
        const floor = Math.min(ground(K, sMax), 960);
        return { s: Math.min(sMax, (floor - (top + 20)) / headTop), gy: floor };
      };
      const cr = below(P.hug, 1.25), br = below(P.hush, 1.25);
      D.push({ id: "crouch", group: "隠れる", name: "膝を抱える", note: "座って膝を抱え、線の下に沈む。4拍でゆっくり息をする", beats: 4,
        actors: [{ x: 400, s: cr.s, gy: cr.gy, pose: P.hug, beats: 4, frames: [[0, P.hug], [0.5, P.hug2], [1, P.hug]] }] });
      D.push({ id: "wall", group: "隠れる", name: "壁の陰", note: "壁の上端が線。4拍に1回、頭を線の上に出してのぞく", beats: 4,
        actors: [{ x: 520, pose: P.peekW, beats: 4, frames: [[0, P.ball], [0.4, P.ball], [0.55, P.peekW], [0.85, P.peekW], [1, P.ball]] }],
        props: () => ({ over: wall(180, 820) }) });
      D.push({ id: "corner", group: "隠れる", name: "角からのぞく", note: "壁の角から頭と手だけ出す。4拍でのぞいて戻る", beats: 4,
        actors: [{ x: 600, facing: -1, pose: P.leanOut, beats: 4, frames: [[0, P.hideIn], [0.35, P.hideIn], [0.55, P.leanOut], [0.85, P.leanOut], [1, P.hideIn]] }],
        props: () => ({ over: rect(440, 60, 420, ground(K, 1) - 60 + 1, col("muted"), ` rx="8"`) }) });
      D.push({ id: "prone", group: "隠れる", name: "伏せる", note: "地面に伏せて肘で進む。4拍で左右", beats: 4,
        actors: [{ x: 500 + ((K.TH + K.SH + K.LIMB / 2) - (K.TL + K.HG + 2 * K.HR)) / 2, gy: Math.min(ground(K, 1), 960), pose: P.prone, beats: 4, frames: [[0, P.prone], [0.5, P.prone2], [1, P.prone]],
          move: { beats: 4, ease: "ease-in-out", keys: [{ t: 0, dx: -40 }, { t: 0.5, dx: 20 }, { t: 1, dx: -40 }] } }] });
      D.push({ id: "breath", group: "隠れる", name: "息をひそめる", note: "両手で口をふさいで線の下で止まる。4拍で息をする", beats: 4,
        actors: [{ x: 420, s: br.s, gy: br.gy, pose: P.hush, beats: 4, frames: [[0, P.hush], [0.5, P.hush2], [1, P.hush]] }] });
      D.push({ id: "together", group: "隠れる", name: "2人で隠れる", note: "壁の陰で向き合う。片方が「静かに」。4拍で交互にのぞく", beats: 4,
        actors: [{ x: 320, s: 0.9, pose: P.peekW, beats: 4, frames: [[0, P.peekW], [0.4, P.peekW], [0.55, P.ball], [0.85, P.ball], [1, P.peekW]] },
                 { x: 690, s: 0.9, facing: -1, pose: P.shhS, beats: 4, frames: [[0, P.ball], [0.4, P.ball], [0.55, P.shhS], [0.85, P.shhS], [1, P.ball]] }],
        props: () => ({ over: wall(100, 900, 0.9) }) });
    }
    D.push({ id: "home", group: "動き", name: "帰る", note: "イータへ帰る。2拍で左右1歩ずつ", beats: 2,
      actors: [{ x: 330, s: 0.82, pose: P.walkA, beats: 2, frames: walk4 }],
      props: (K2, g2) => {
        const w = 300, x0 = 600, base = K2.G - (K2.G - g2.lineY - g2.navel * 0.82), top = base - 360;
        const th = 56;
        const pts = [[x0, base], [x0, top + 130], [x0 + w / 2, top], [x0 + w, top + 130], [x0 + w, base]];
        const outer = `<polygon points="${pts.map((p) => p.map(r1).join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="${th}" stroke-linejoin="miter"/>`;
        const door = rect(x0 + w / 2 - 50, base - 150, 100, 150, "currentColor");
        return { under: `<g style="color:${col("tsuki")}">${outer}${door}</g>` };
      } });

    // 状態・場所
    D.push({ id: "jail", group: "状態", name: "牢屋", note: "捕まった人は色が抜ける。格子をつかんで揺らす", beats: 2,
      actors: [{ x: 500, color: "muted", pose: P.grip, beats: 2, frames: [[0, P.grip], [0.25, P.grip2], [0.5, P.grip], [0.75, mirror(P.grip2)], [1, P.grip]] }],
      props: (K2) => {
        const bw = 44, xs = [250, 375, 625, 750], bot = ground(K2, 1), top = Math.max(20, bot - K2.HGT - 80);
        const bars = xs.map((x) => rect(x - bw / 2, top, bw, bot - top, "currentColor")).join("");
        return { over: `<g style="color:${col("tsuki")}">${bars}${rect(200, top, 600, bw, "currentColor")}${rect(200, bot - bw, 600, bw, "currentColor")}</g>` };
      } });
    D.push({ id: "release", group: "状態", name: "解放", note: "4拍：格子が上がる→忍び足で出る→色が戻る", beats: 4,
      actors: [{ x: 300, s: 0.74, color: "muted", pose: P.sneakKey, beats: 2, frames: sneak4,
        move: { beats: 4, keys: [{ t: 0, dx: 0, o: 1, c: "muted" }, { t: 0.3, dx: 0, o: 1, c: "muted" }, { t: 0.55, dx: 260, o: 1, c: "tsuki" }, { t: 0.85, dx: 480, o: 0, c: "tsuki" }, { t: 0.86, dx: 0, o: 0, c: "muted" }, { t: 1, dx: 0, o: 1, c: "muted" }], static: {} } }],
      props: (K2, g2, pid, css) => {
        const bw = 40, xs = [140, 240, 340, 440], bot = ground(K2, 0.74), top = Math.max(20, bot - K2.HGT * 0.74 - 60);
        const door = xs.map((x) => rect(x - bw / 2, top, bw, bot - top, "currentColor")).join("");
        css.push(`.${pid}-door{animation:${pid}-door ${4 * K2.BEAT}s ease-in-out infinite;transform-origin:0 ${top}px}@keyframes ${pid}-door{0%,10%{transform:scaleY(1)}28%,85%{transform:scaleY(.06)}100%{transform:scaleY(1)}}`);
        const arrow = `<g style="color:${col("beacon")}"><rect x="640" y="${r1(g2.lineY - 30)}" width="200" height="60" fill="currentColor"/><polygon points="820,${r1(g2.lineY - 95)} 935,${r1(g2.lineY)} 820,${r1(g2.lineY + 95)}" fill="currentColor"/></g>`;
        return { under: arrow, over: `<g style="color:${col("tsuki")}">${rect(90, top, 400, bw, "currentColor")}<g class="${pid}-door">${door}</g>${rect(90, bot - bw, 400, bw, "currentColor")}</g>` };
      } });
    {
      const s = 0.6, beats = 4;
      const mk = (x, facing) => ({ x, s, facing, pose: P.walkA, beats: 2, frames: walk4,
        move: { beats, keys: [{ t: 0, dx: 0, o: 0 }, { t: 0.12, dx: 30, o: 1 }, { t: 0.72, dx: 190, o: 1 }, { t: 0.88, dx: 215, o: 0 }, { t: 1, dx: 215, o: 0 }], static: { dx: 120 } } });
      D.push({ id: "gather", group: "状態", name: "集合", note: "左右から光る点へ集まる。4拍でくり返す", beats: 4,
        actors: [mk(150, 1), mk(850, -1)],
        props: (K2, g2, pid, css) => {
          const y = g2.lineY + g2.navel * s - 60;
          css.push(`.${pid}-pt{animation:${pid}-pt ${2 * K2.BEAT}s ease-in-out infinite;transform-origin:500px ${r1(y)}px}@keyframes ${pid}-pt{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}`);
          return { under: `<g style="color:${col("beacon")}"><circle class="${pid}-pt" cx="500" cy="${r1(y)}" r="64" fill="currentColor"/></g>` };
        } });
    }

    // 時
    D.push({ id: "assign", group: "時", name: "配役", note: "追跡者か逃走者か。4拍でめくれる。止めたときは半分ずつ（右半分は腕を上げた追跡者）", beats: 4,
      actors: [
        { x: 500, pose: P.stand, beats: 4, frames: [[0, P.stand], [1, P.stand]],
          move: { beats: 4, ease: "ease-in-out", keys: [{ t: 0, o: 1 }, { t: 0.4, o: 1 }, { t: 0.45, o: 0 }, { t: 0.95, o: 0 }, { t: 1, o: 1 }], static: { opacity: 0 } } },
        { x: 500, color: "oni", pose: P.block, beats: 4, frames: [[0, P.block], [1, P.block]],
          move: { beats: 4, ease: "ease-in-out", keys: [{ t: 0, o: 0 }, { t: 0.45, o: 0 }, { t: 0.5, o: 1 }, { t: 0.9, o: 1 }, { t: 0.95, o: 0 }, { t: 1, o: 0 }], static: { opacity: 0 } } },
      ],
      props: (K2, g2, pid, css) => {
        // めくれ：枠ごと横に縮んで戻る
        css.push(`#up-${pid} .${pid}-flip{animation:${pid}-flip ${4 * K2.BEAT}s ease-in-out infinite;transform-origin:500px 500px}@keyframes ${pid}-flip{0%,35%{transform:scaleX(1)}45%{transform:scaleX(0.04)}55%{transform:scaleX(1)}85%{transform:scaleX(1)}95%{transform:scaleX(0.04)}100%{transform:scaleX(1)}}`);
        // 止めたとき用：左半分が逃走者、右半分が鬼
        const half = `<g class="${pid}-half"><clipPath id="${pid}-cl"><rect x="0" y="0" width="500" height="1000"/></clipPath><clipPath id="${pid}-cr"><rect x="500" y="0" width="500" height="1000"/></clipPath>` +
          `<g clip-path="url(#${pid}-cl)">${actorSVG(K2, pid, "h1", { x: 500, pose: P.stand }, [])}</g>` +
          `<g clip-path="url(#${pid}-cr)">${actorSVG(K2, pid, "h2", { x: 500, color: "oni", pose: P.block }, [])}</g></g>`;
        css.push(`.${pid}-half{animation:${pid}-hide 1s infinite}@keyframes ${pid}-hide{0%,100%{opacity:0}}`);
        return { under: half };
      },
      wrap: "flip" });
    {
      const s = 0.7, beats = 8;
      D.push({ id: "ready", group: "時", name: "構え", note: "開始までの残り。輪が8拍で減る。数字と並べて使う", beats,
        actors: [{ x: 520, s, pose: P.ready, beats: 2, frames: [[0, P.ready], [0.5, P.ready2], [1, P.ready]] }],
        props: (K2, g2, pid, css) => {
          const cx = 500, cy = g2.lineY + 10, r = 400, w = 40, C = 2 * Math.PI * r;
          css.push(`.${pid}-ring{animation:${pid}-ring ${beats * K2.BEAT}s linear infinite}@keyframes ${pid}-ring{0%{stroke-dashoffset:0}100%{stroke-dashoffset:${r1(C)}}}`);
          return { under: `<circle cx="${cx}" cy="${r1(cy)}" r="${r}" fill="none" stroke="${col("muted")}" stroke-opacity=".35" stroke-width="${w}"/>` +
            `<circle class="${pid}-ring" cx="${cx}" cy="${r1(cy)}" r="${r}" fill="none" stroke="${col("tsuki")}" stroke-width="${w}" stroke-dasharray="${r1(C)}" stroke-dashoffset="${r1(C * 0.3)}" transform="rotate(-90 ${cx} ${r1(cy)})"/>` };
        } });
    }
    D.push({ id: "result", group: "時", name: "結果", note: "両手を上げて跳ぶ。2拍でくり返す", beats: 2,
      actors: [{ x: 500, pose: P.win1, beats: 2, frames: [[0, P.win1], [0.3, P.win2], [0.6, P.win1], [1, P.win1]] }] });

    // 決まり
    D.push({ id: "quiet", group: "決まり", name: "静かに", note: "抜き足差し足。夜のキャンパスでは音を立てない。4拍で1歩", beats: 4,
      actors: [{ x: 500, s: 0.95, pose: P.toeA, beats: 4, frames: [[0, P.toeA], [0.5, P.toeB], [1, P.toeA]] }] });
    return D;
  }

  function build(params) {
    const K = derive(params);
    const list = defs(K).map((d) => {
      const out = picto(K, d);
      if (d.wrap === "flip") {
        // 配役：中身をめくり用の g に包む（線の切れ目はめくらない）
        out.svg = out.svg.replace(`<g mask="url(#${d.id}-line)">`, `<g mask="url(#${d.id}-line)"><g class="${d.id}-flip">`).replace(/<\/g><\/svg>$/, "</g></g></svg>");
        out.svgStatic = out.svgStatic.replace(`<g mask="url(#${d.id}-line)">`, `<g mask="url(#${d.id}-line)"><g class="${d.id}-flip">`).replace(/<\/g><\/svg>$/, "</g></g></svg>");
      }
      return out;
    });
    return { params: K, geo: geo(K), pictos: list };
  }

  // 1人だけ描く（見比べ用）。a は actorSVG と同じ指定。
  function actor(a, params, pid) { return actorSVG(derive(params), pid || "x", 0, a, []); }
  const api = { DEFAULTS, KNOBS, COLORS, POSES: P, build, derive, fk, geo, ground, actor, hipH: (p, params) => hipH(derive(params), p) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.URAFES_PICTO = api;
})(typeof window !== "undefined" ? window : globalThis);
