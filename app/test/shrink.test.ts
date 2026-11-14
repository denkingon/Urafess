import { describe, expect, it } from 'vitest';
import { AreaWatch, checkArea, isFarOutside } from '../src/shared/area';
import { startTimer, pauseTimer, resumeTimer, skipPhase } from '../src/shared/schedule';
import {
  DEFAULT_SHRINK_PLAN,
  extraStep,
  isShrinkPlan,
  makeLive,
  midOf,
  randomInside,
  scaleAt,
  timeSteps,
  ZONE_MIN_SCALE,
  ZONE_MOVE_MS,
  ZONE_STEP_AREA,
  ZONE_WARN_MS,
  zoneAt,
  type ShrinkPlan,
} from '../src/shared/shrink';

const SFC = { lat: 35.38873, lon: 139.42701 };
const at = (north: number, east: number): [number, number] => [SFC.lat + north / 111_195, SFC.lon + east / (111_195 * Math.cos((SFC.lat * Math.PI) / 180))];
const pt = (north: number, east: number) => {
  const [lat, lon] = at(north, east);
  return { lat, lon };
};
const sq = (r: number): [number, number][] => [at(r, -r), at(r, r), at(-r, r), at(-r, -r)];
/** コの字（上が開いている） */
const cShape: [number, number][] = [at(200, -200), at(200, -100), at(-100, -100), at(-100, 100), at(200, 100), at(200, 200), at(-200, 200), at(-200, -200)];
const DUR = [20_000, 60_000, 300_000, 120_000];
const GAME_START = 80_000;
const plan = (p: Partial<ShrinkPlan>): ShrinkPlan => ({ ...DEFAULT_SHRINK_PLAN, ...p });

describe('範囲の縮小', () => {
  it('時間の段：ゲームの段階を等分した区切りで予告が始まり、最後の広さで止まる', () => {
    const steps = timeSteps(plan({ times: 3, finalArea: 0.25 }), DUR);
    expect(steps.map((s) => s.at)).toEqual([GAME_START + 75_000 - ZONE_WARN_MS, GAME_START + 150_000 - ZONE_WARN_MS, GAME_START + 225_000 - ZONE_WARN_MS]);
    // 最後の段が縮み終わるのは、ゲームの終わりより前
    const last = steps[2];
    expect(last.at + last.warn + last.move).toBeLessThanOrEqual(GAME_START + 300_000);
    const end = scaleAt(steps, GAME_START + 300_000);
    expect(end.scale ** 2).toBeCloseTo(0.25, 6);
    expect(timeSteps(plan({ times: 0 }), DUR)).toEqual([]);
  });

  it('短いゲーム（プレ）では予告と縮むも短くなり、ゲームの中に収まる', () => {
    const short = [5_000, 10_000, 60_000, 10_000];
    const steps = timeSteps(plan({ times: 4, finalArea: 0.1 }), short);
    for (const s of steps) {
      expect(s.warn).toBeLessThanOrEqual(6_000);
      expect(s.at + s.warn + s.move).toBeLessThanOrEqual(15_000 + 60_000);
    }
  });

  it('予告 → 縮む → 止まる。予告の間は大きさが変わらず、行き先だけが出る', () => {
    const steps = [extraStep(100_000, 'host')];
    const before = scaleAt(steps, 99_000);
    expect(before.scale).toBe(1);
    expect(before.status).toEqual({ kind: 'idle', nextInMs: 1_000 });
    const warn = scaleAt(steps, 110_000);
    expect(warn.scale).toBe(1);
    expect(warn.target ** 2).toBeCloseTo(ZONE_STEP_AREA, 6);
    expect(warn.status).toMatchObject({ kind: 'warn', leftMs: ZONE_WARN_MS - 10_000, why: 'host' });
    const mid = scaleAt(steps, 100_000 + ZONE_WARN_MS + ZONE_MOVE_MS / 2);
    expect(mid.scale).toBeLessThan(1);
    expect(mid.scale).toBeGreaterThan(Math.sqrt(ZONE_STEP_AREA));
    expect(mid.status.kind).toBe('move');
    const done = scaleAt(steps, 100_000 + ZONE_WARN_MS + ZONE_MOVE_MS);
    expect(done.scale ** 2).toBeCloseTo(ZONE_STEP_AREA, 6);
    expect(done.status).toEqual({ kind: 'idle', nextInMs: null });
  });

  it('段が重なっても掛け算。小さくなりすぎない', () => {
    const steps = Array.from({ length: 20 }, (_, i) => extraStep(i * 1000, 'mission'));
    const r = scaleAt(steps, 1_000_000);
    expect(r.scale).toBe(ZONE_MIN_SCALE);
    const two = scaleAt([extraStep(0, 'mission'), extraStep(5_000, 'host')], 1_000_000);
    expect(two.scale ** 2).toBeCloseTo(ZONE_STEP_AREA ** 2, 6);
  });

  it('タイマーを止めれば縮小も止まる。次に進むで先に進む', () => {
    const live = makeLive(plan({ times: 2 }), sq(200), DUR, () => 0.5)!;
    let timer = startTimer(DUR, 0);
    const t0 = timer.t0;
    const a = zoneAt({ pts: sq(200) }, live, timer, t0 + GAME_START + 150_000);
    timer = pauseTimer(timer, t0 + GAME_START + 150_000);
    const b = zoneAt({ pts: sq(200) }, live, timer, t0 + GAME_START + 900_000);
    expect(b!.scale).toBe(a!.scale);
    timer = resumeTimer(timer, t0 + GAME_START + 900_000);
    expect(zoneAt({ pts: sq(200) }, live, timer, t0 + GAME_START + 900_000)!.scale).toBe(a!.scale);
    // 次に進む（追跡開始までを飛ばす）と、時間の段もその分早く来る
    let t2 = startTimer(DUR, 0);
    t2 = skipPhase(t2, t2.t0 + 25_000);
    const z = zoneAt({ pts: sq(200) }, live, t2, t2.t0 + GAME_START + 300_000);
    expect(z!.scale ** 2).toBeCloseTo(0.25, 6);
  });

  it('縮んだ範囲の中と外：縮む先へ向けて形のまま小さくなる', () => {
    const live = { center: at(0, 0), steps: [extraStep(0, 'host')], byPhoto: [] };
    let timer = startTimer(DUR, 0);
    timer = { ...timer, t0: 0, floorElapsed: 0 };
    const z = zoneAt({ pts: sq(200) }, live, timer, ZONE_WARN_MS + ZONE_MOVE_MS)!;
    const half = 200 * Math.sqrt(ZONE_STEP_AREA); // 約167m
    expect(z.inner).not.toBeNull();
    expect(z.next).toBeNull();
    expect(isFarOutside(z, pt(0, 0))).toBe(false);
    expect(isFarOutside(z, pt(half - 5, 0))).toBe(false);
    expect(isFarOutside(z, pt(half + 20, 0))).toBe(true);
    // 元の範囲では中
    expect(isFarOutside(sq(200), pt(half + 20, 0))).toBe(false);
    // 見張り：縮んで取り残されると、3秒で外。戻る先は縮んだ線の上
    const w = new AreaWatch();
    w.feed(z, pt(half + 30, 0), 0);
    w.feed(z, pt(half + 30, 0), 3_000);
    expect(w.out).toBe(true);
    expect(checkArea(z.inner!, w.last!.nearest).edgeM).toBeLessThan(1);
  });

  it('へこんだ形でも、元の範囲の外は「外」のまま（縮めた形と元の範囲の重なり）', () => {
    // 真ん中（へこみの中＝元の範囲の外）を縮む先にしても、へこみは外
    const live = { center: at(0, 0), steps: [extraStep(0, 'host')], byPhoto: [] };
    const timer = { ...startTimer(DUR, 0), t0: 0, floorElapsed: 0 };
    const z = zoneAt({ pts: cShape }, live, timer, 1_000_000)!;
    expect(checkArea(cShape, pt(50, 0)).inside).toBe(false);
    expect(isFarOutside(z, pt(150, 0))).toBe(true);
  });

  it('縮む先：真ん中は中にある点。へこんだ形でも中。ランダムも中で、線のすぐそばは避ける', () => {
    const m = midOf(sq(200));
    expect(Math.abs(m[0] - SFC.lat)).toBeLessThan(1e-5);
    expect(Math.abs(m[1] - SFC.lon)).toBeLessThan(1e-5);
    const cm = midOf(cShape);
    expect(checkArea(cShape, { lat: cm[0], lon: cm[1] }).inside).toBe(true);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 30; i++) {
      const r = randomInside(cShape, rnd);
      const c = checkArea(cShape, { lat: r[0], lon: r[1] });
      expect(c.inside).toBe(true);
      expect(c.edgeM).toBeGreaterThan(10);
    }
    // 地図で選んだ点が範囲の外なら、真ん中にする
    const live = makeLive(plan({ to: 'pick', pick: at(900, 900) }), sq(200), DUR, rnd)!;
    expect(live.center).toEqual(midOf(sq(200)));
    const live2 = makeLive(plan({ to: 'pick', pick: at(100, 50) }), sq(200), DUR, rnd)!;
    expect(live2.center).toEqual(at(100, 50));
  });

  it('縮み方の形を確かめる', () => {
    expect(isShrinkPlan(DEFAULT_SHRINK_PLAN)).toBe(true);
    expect(isShrinkPlan({ ...DEFAULT_SHRINK_PLAN, times: 9 })).toBe(false);
    expect(isShrinkPlan({ ...DEFAULT_SHRINK_PLAN, finalArea: 0 })).toBe(false);
    expect(isShrinkPlan({ ...DEFAULT_SHRINK_PLAN, to: 'x' })).toBe(false);
    expect(isShrinkPlan({ ...DEFAULT_SHRINK_PLAN, pick: [1] })).toBe(false);
    expect(isShrinkPlan(null)).toBe(false);
    // 範囲が無ければ縮小も無い
    expect(makeLive(plan({ times: 2 }), null, DUR, Math.random)).toBeNull();
    expect(zoneAt(null, null, null, 0)).toBeNull();
  });
});
