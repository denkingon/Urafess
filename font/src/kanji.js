/*
 * URAJI（裏字）— 漢字
 * 祭：月（肉）＋又（手）＝供え物を線の上に、示（祭壇）を線の下に置く。
 * 新字（うらまつり）：「裏」のフタ（亠）の下に祭を置いた字。画は分け合わない（案 C、いまのフォントはこれ）。
 *   フタ（点・横画）／ 夕又（線の上の帯に収める）／ 線 ／ 示（祭のまま）。又の払いだけ線をまたいで示の肩で止まる。
 *   見比べた案：A＝衣＋祭で亠の横画と示の脚を分け合う（脚は左右対称）、B＝A の脚に衣の裾の跳ねを残す。
 *   使う案は root.URAJI_URASAI（"A" "B" "C"）で選べる。指定がなければ C。
 * 打ち方：「裏」「祭」と続けて打つと合字で一字（liga）。切り替え ss02 で「裏」が全部新字。私用領域 U+E000 にも置く。
 */
(function (root) {
  "use strict";
  root.URAJI_KANJI = function (J, k) {
    const { add, rect, diag, U, I } = k;
    const { S0, S1 } = J;
    const TOPK = 800, BOTK = -120, c = 500;
    const box = (n) => I(n, rect(40, BOTK, 960, TOPK));

    // 夕又（供え物）。上端 y1、上の横画の厚さ hb。shared のときは横画を描かず、上の横画の中から画を垂らす。
    // 下端はすべて線の上端（S1）にそろえる。又の払いは横画から離して始め、小さな閉じた穴を作らない。
    function offering(y1, hb, dk, shared) {
      const y0 = S1, yb = y1 - hb, h = y1 - y0;
      const top = shared ? y1 - hb * 0.5 : y1;
      return U(
        shared ? null : rect(222, yb, 458, y1),
        diag(262, top, 116, y0 + h * 0.36, dk - 8),   // 夕：短いノ
        diag(446, top, 214, y0, dk),                  // 夕：長い斜め画
        shared ? null : rect(546, yb, 862, y1),
        diag(850, top, 614, y0, dk),                  // 又：左下への斜め画
        diag(588, yb - 46, 894, y0, dk - 4),          // 又：右下への払い（横画から 46 離す）
      );
    }
    // 示（祭壇）：短い横画を線の真下に、長い横画、縦画、左右の脚
    function altar(yLong, hk, vk, dk, legTop, legBot, hook) {
      return U(
        rect(300, S0 - hk, 700, S0),
        rect(96, yLong, 904, yLong + hk),
        rect(c - vk / 2, hook ? -70 : legBot, c + vk / 2, yLong + hk),
        hook ? rect(374, BOTK, c + vk / 2, -66) : null,
        diag(c - 92, legTop, hook ? 150 : 128, legBot, dk),
        diag(c + 92, legTop, hook ? 850 : 902, legBot, dk),
      );
    }

    // 祭
    add("uni796D", [0x796D], 1000, box(U(
      offering(790, 78, 90, false),
      altar(196, 70, 96, 84, 150, -50, true),
    )));

    // 裏祭（衣＋祭）。上半分は共通：点・横画・夕又・祭壇（二）。脚の描き方で二案。
    // 画ごとに持ち主を記す（衣＝衣だけ／祭＝祭だけ／共有＝両方の画を兼ねる）。図解と書き出しで同じ定義を使う。
    const head = [
      ["dot", "衣", rect(c - 48, 744, c + 48, TOPK)],                             // 亠：点
      ["bar", "共有", rect(84, 676, 916, 744)],                                   // 亠の横画＝夕と又の上の画
      ["offering", "祭", offering(744, 68, 86, true)],                            // 夕又：供え物
      ["altar", "祭", U(rect(300, S0 - 66, 700, S0), rect(96, 212, 904, 278))],   // 示の二：祭壇
    ];
    const variants = {
      // A：示の小をそのまま脚に（左右対称）
      A: head.concat([
        ["stem", "祭", rect(c - 48, BOTK, c + 48, 278)],
        ["legs", "共有", U(diag(c - 92, 200, 128, BOTK, 88), diag(c + 92, 200, 902, BOTK, 88))],
      ]),
      // B：衣の裾（𧘇）。裏と同じく右の脚に短い画が交わる。縦画は裏と同じく脚より短い
      B: head.concat([
        ["stem", "祭", rect(c - 48, -40, c + 48, 278)],
        ["legs", "共有", U(diag(410, 236, 130, BOTK, 88), diag(588, 246, 902, BOTK, 88))],
        ["hook", "衣", diag(850, 150, 716, 18, 72)],
      ]),
    };
    // C：フタ（亠）＋祭。祭をそのまま亠の下に置く（画は分け合わない）。
    //   夕又は線の上の短い帯に収める。又の払いだけ線をまたいで右下へ抜ける（祭の払いが示の肩まで届くのと同じ）。
    const cTop = 648, cHb = 56;
    variants.C = [
      ["dot", "衣", rect(c - 48, 748, c + 48, TOPK)],                             // 亠：点
      ["bar", "衣", rect(84, 688, 916, 748)],                                     // 亠：横画（フタ）
      ["offering", "祭", U(
        rect(222, cTop - cHb, 458, cTop),                                         // 夕：上の画
        diag(262, cTop, 128, 538, 76),                                            // 夕：短いノ
        diag(446, cTop, 210, S1, 84),                                             // 夕：長い斜め画
        rect(546, cTop - cHb, 862, cTop),                                         // 又：上の画
        diag(850, cTop, 618, S1, 84),                                             // 又：左下への斜め画
        diag(640, cTop - cHb - 44, 890, 350, 78),                                 // 又：払い（線をまたいで、示の短い横画の右で止まる）
      )],
      ["altar", "祭", altar(196, 70, 96, 84, 150, -50, true)],                     // 示：祭の示そのまま
    ];
    root.URAJI_KANJI_VARIANTS = variants;
    const pick = variants[root.URAJI_URASAI || "C"];
    add("uni88CF_uni796D", [0xE000], 1000, box(U(...pick.map((p) => p[2]))));
  };
})(typeof window !== "undefined" ? window : globalThis);
