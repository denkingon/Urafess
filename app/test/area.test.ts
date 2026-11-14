import { describe, expect, it } from 'vitest';
import { AREA_DQ_MS, AREA_OUT_CONFIRM_MS, AreaWatch, checkArea, isFarOutside, isValidAreaPts } from '../src/shared/area';
import { CAMPUS_CENTER } from '../src/shared/rules';

// キャンパスの真ん中を中心に、東西 400m × 南北 400m の四角
const C = CAMPUS_CENTER;
const at = (n: number, e: number) => ({ lat: C.lat + n / 111195, lon: C.lon + e / (111195 * Math.cos((C.lat * Math.PI) / 180)) });
const sq: [number, number][] = [at(200, -200), at(200, 200), at(-200, 200), at(-200, -200)].map((p) => [p.lat, p.lon]);

describe('遊ぶ範囲', () => {
  it('中と外、線までの距離', () => {
    expect(checkArea(sq, at(0, 0)).inside).toBe(true);
    expect(checkArea(sq, at(0, 0)).edgeM).toBeCloseTo(200, 0);
    const o = checkArea(sq, at(0, 250));
    expect(o.inside).toBe(false);
    expect(o.edgeM).toBeCloseTo(50, 0);
    // 戻る先は東の線の上
    expect(o.nearest.lon).toBeCloseTo(at(0, 200).lon, 6);
    expect(isFarOutside(sq, at(0, 210))).toBe(false); // 10m 外はぶれのうち
    expect(isFarOutside(sq, at(0, 220))).toBe(true);
  });

  it('へこんだ形でも中と外を見分ける', () => {
    // コの字（北の真ん中がへこむ）
    const u: [number, number][] = [at(200, -200), at(200, -50), at(0, -50), at(0, 50), at(200, 50), at(200, 200), at(-200, 200), at(-200, -200)].map((p) => [p.lat, p.lon]);
    expect(checkArea(u, at(100, 0)).inside).toBe(false);
    expect(checkArea(u, at(100, -100)).inside).toBe(true);
  });

  it('形の受け付け', () => {
    expect(isValidAreaPts(sq, C)).toBe(true);
    expect(isValidAreaPts(sq.slice(0, 2), C)).toBe(false);
    expect(isValidAreaPts([...sq, [35, 135]], C)).toBe(false); // 遠すぎる点
    expect(isValidAreaPts([[1, 2, 3], ...sq] as never, C)).toBe(false);
    expect(isValidAreaPts('x', C)).toBe(false);
  });

  it('外が3秒続いたら外、内側へ入ったら中（境目でばたばたしない）', () => {
    const w = new AreaWatch();
    let t = 0;
    expect(w.feed(sq, at(0, 230), t)).toBe(false);
    t += AREA_OUT_CONFIRM_MS - 1;
    expect(w.feed(sq, at(0, 230), t)).toBe(false);
    t += 1;
    expect(w.feed(sq, at(0, 230), t)).toBe(true);
    // 線の少し外・線の上では外のまま
    expect(w.feed(sq, at(0, 205), (t += 1000))).toBe(true);
    expect(w.feed(sq, at(0, 199), (t += 1000))).toBe(true);
    // 内側へ 3m 以上入ったら中
    expect(w.feed(sq, at(0, 190), (t += 1000))).toBe(false);
    // 一瞬だけ外へ飛んだ位置では外にならない
    w.feed(sq, at(0, 260), (t += 1000));
    expect(w.feed(sq, at(0, 100), (t += 1000))).toBe(false);
    expect(w.feed(sq, at(0, 260), (t += 2500))).toBe(false);
    // 範囲が無くなれば中
    expect(w.feed(null, at(0, 500), (t += 5000))).toBe(false);
  });
  it('外が20秒続いたら失格（「戻れ」が出た時点から数える）', () => {
    const w = new AreaWatch();
    let t = 0;
    w.feed(sq, at(0, 230), t);
    expect(w.dqLeftMs(t)).toBeNull(); // まだ外と決まっていない
    t += AREA_OUT_CONFIRM_MS;
    expect(w.feed(sq, at(0, 230), t)).toBe(true);
    expect(w.dqLeftMs(t)).toBe(AREA_DQ_MS); // 「戻れ」が出た瞬間から20秒
    expect(w.feed(sq, at(0, 230), (t += 5000))).toBe(true);
    expect(w.dqLeftMs(t)).toBe(AREA_DQ_MS - 5000);
    expect(w.feed(sq, at(0, 230), (t += AREA_DQ_MS - 5000 - 1))).toBe(true);
    expect(w.disqualified).toBe(false);
    w.feed(sq, at(0, 230), (t += 1));
    expect(w.disqualified).toBe(true);
    expect(w.dqLeftMs(t)).toBe(0);
  });

  it('20秒の途中で中に戻れば数え直し。線の少し外（15m以内）に戻っても外のまま数え続ける', () => {
    const w = new AreaWatch();
    let t = 0;
    w.feed(sq, at(0, 230), t);
    w.feed(sq, at(0, 230), (t += AREA_OUT_CONFIRM_MS));
    // 線の少し外に戻っても「外」は続く（内側 3m に入るまで）
    w.feed(sq, at(0, 205), (t += 10_000));
    expect(w.out).toBe(true);
    expect(w.dqLeftMs(t)).toBe(AREA_DQ_MS - 10_000);
    // 内側へ入れば数え直し
    w.feed(sq, at(0, 190), (t += 5_000));
    expect(w.out).toBe(false);
    expect(w.dqLeftMs(t)).toBeNull();
    // また外へ出ても、最初から（3秒＋20秒）
    w.feed(sq, at(0, 230), (t += 1_000));
    w.feed(sq, at(0, 230), (t += AREA_OUT_CONFIRM_MS));
    expect(w.dqLeftMs(t)).toBe(AREA_DQ_MS);
    w.feed(sq, at(0, 230), (t += AREA_DQ_MS - 1));
    expect(w.disqualified).toBe(false);
  });

  it('失格は reset（一時停止・位置が取れない）では消えず、clearDq（新しいラウンド）で消える', () => {
    const w = new AreaWatch();
    let t = 0;
    w.feed(sq, at(0, 230), t);
    w.feed(sq, at(0, 230), (t += AREA_OUT_CONFIRM_MS));
    w.feed(sq, at(0, 230), (t += AREA_DQ_MS));
    expect(w.disqualified).toBe(true);
    w.reset();
    expect(w.out).toBe(false);
    expect(w.disqualified).toBe(true);
    // 中にいる位置が来ても失格は残る
    w.feed(sq, at(0, 0), (t += 1000));
    expect(w.disqualified).toBe(true);
    w.clearDq();
    expect(w.disqualified).toBe(false);
  });

  it('一時停止で見張りが止まったら、20秒は数え直し（止まっている間は数えない）', () => {
    const w = new AreaWatch();
    let t = 0;
    w.feed(sq, at(0, 230), t);
    w.feed(sq, at(0, 230), (t += AREA_OUT_CONFIRM_MS));
    w.feed(sq, at(0, 230), (t += 15_000));
    w.reset(); // 一時停止
    w.feed(sq, at(0, 230), (t += 60_000));
    expect(w.disqualified).toBe(false);
    expect(w.dqLeftMs(t)).toBeNull();
  });
});
