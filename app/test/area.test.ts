import { describe, expect, it } from 'vitest';
import { AREA_OUT_CONFIRM_MS, AreaWatch, checkArea, isFarOutside, isValidAreaPts } from '../src/shared/area';
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
});
