import { describe, expect, it } from 'vitest';
import { MAGNETIC_DECLINATION_DEG, headingOf } from '../src/client/sense';
import { RUN_SEND_EVERY_MS, RUN_START_MS, RUN_STOP_MS } from '../src/shared/rules';
import {
  RunDetector,
  RunLatch,
  RunReporter,
  bearingDeg,
  compassName,
  compassNameEn,
  distanceM,
  distanceText,
  distanceTextEn,
  offsetM,
  radarRadius,
} from '../src/shared/run';

/**
 * 走ると光る：走りの判定を、作った揺れの波形と位置で確かめる。
 * 波形は重力込みの加速度の大きさ（止まっていると 9.8 m/s²）。
 * 走り：1歩ごとに着地の強い山（20〜26）と、宙に浮く間の谷（約4）。歩き：9.8 のまわりの小さな波（山 12〜15）
 */

type Wave = (t: number) => number;

const still: Wave = () => 9.8;
/** 歩き：f 歩/秒、山の高さ peak */
const walk = (f: number, peak: number): Wave => (t) => 9.8 + (peak - 9.8) * Math.sin(2 * Math.PI * f * (t / 1000));
/** 走り：f 歩/秒、着地の山 peak、宙の谷 base */
const run = (f: number, peak: number, base = 4): Wave => (t) => base + (peak - base) * Math.max(0, Math.sin(2 * Math.PI * f * (t / 1000))) ** 2;

let seed = 7;
/** センサーのざらつき（決まった並びの乱数） */
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

/** 波形を hz で流し込み、終わりの時刻を返す。向きをゆっくり変えながら3軸に分けて入れる（大きさしか見ないので向きは関係ない） */
function feed(d: RunDetector, wave: Wave, from: number, ms: number, hz = 60, noise = 0.3): number {
  const step = 1000 / hz;
  let t = from;
  for (; t < from + ms; t += step) {
    const m = wave(t - from) + rnd() * 2 * noise;
    // 向きをゆっくり変えても、大きさは同じ
    const a = (t / 3000) % (2 * Math.PI);
    d.addMotion(t, m * Math.cos(a), m * Math.sin(a) * 0.6, m * Math.sin(a) * 0.8);
  }
  return t;
}

/** 揺れを流しながら、最初に「走り」と判定された時刻（流し始めからの ms）。最後まで無ければ null */
function firstRunning(d: RunDetector, wave: Wave, ms: number, hz = 60): number | null {
  const step = 1000 / hz;
  for (let t = 0; t < ms; t += step) {
    feed(d, (x) => wave(x + t), t, step, hz);
    if (d.read(t).running) return t;
  }
  return null;
}

describe('走ると光る：揺れで決める', () => {
  it('止まっている・歩き（ポケット・手に持って大きく振る）は走りにならない', () => {
    for (const [name, wave] of [
      ['止まっている', still],
      ['ふつうの歩き', walk(1.8, 13)],
      ['速歩き（手で大きく振る）', walk(2.0, 15.3)],
      ['速歩き（ポケット）', walk(2.1, 14.5)],
    ] as const) {
      const d = new RunDetector();
      const end = feed(d, wave, 0, 6_000);
      const r = d.read(end);
      expect(r.running, name).toBe(false);
      expect(r.motion).toBe(true);
    }
  });

  it('走り（小走り〜全力）は 1.5 秒以内に走りになる', () => {
    for (const [name, wave] of [
      ['小走り', run(2.4, 19)],
      ['走り', run(2.8, 23)],
      ['全力', run(3.2, 28)],
    ] as const) {
      const d = new RunDetector();
      const at = firstRunning(d, wave, 4_000);
      expect(at, name).not.toBeNull();
      expect(at!, name).toBeLessThan(1_500);
      const r = d.read(at!);
      expect(r.by).toBe('motion');
      expect(r.cadence).toBeGreaterThan(2.2);
      expect(r.peak).toBeGreaterThan(16);
    }
  });

  it('揺れを 30 回/秒しか出さないスマホでも、走りは走り', () => {
    const d = new RunDetector();
    const at = firstRunning(d, run(2.8, 23), 4_000, 30);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(2_000);
  });

  it('止まると、1秒以内に走りでなくなる', () => {
    const d = new RunDetector();
    let t = feed(d, run(2.8, 23), 0, 4_000);
    expect(d.read(t).running).toBe(true);
    const stopAt = t;
    let off: number | null = null;
    for (; t < stopAt + 3_000; t += 1000 / 60) {
      d.addMotion(t, 9.8, 0, 0);
      if (off === null && !d.read(t).running) off = t - stopAt;
    }
    expect(off).not.toBeNull();
    expect(off!).toBeLessThan(1_000);
  });

  it('3回跳んだだけ・1回ぶつけただけでは走りにならない', () => {
    const d = new RunDetector();
    let t = feed(d, still, 0, 1_000);
    t = feed(d, run(2.5, 24), t, 1_150); // 3回の山
    t = feed(d, still, t, 1_500);
    let any = false;
    const d2 = new RunDetector();
    let t2 = feed(d2, still, 0, 1_000);
    d2.addMotion(t2, 40, 0, 0); // ぶつけた
    t2 = feed(d2, still, t2 + 16, 2_000);
    for (const [det, end] of [
      [d, t],
      [d2, t2],
    ] as const) {
      for (let x = 0; x <= end; x += 100) any ||= det.read(x).running;
    }
    expect(any).toBe(false);
  });

  it('動きのセンサーの値が止まったら（画面を消した等）、走りでない', () => {
    const d = new RunDetector();
    const t = feed(d, run(2.8, 23), 0, 3_000);
    expect(d.read(t).running).toBe(true);
    expect(d.read(t + 1_500).running).toBe(false);
    expect(d.read(t + 1_500).motion).toBe(false);
  });

  it('値の欠けた揺れ（null・NaN）は読み飛ばす', () => {
    const d = new RunDetector();
    d.addMotion(0, null, 1, 2);
    d.addMotion(10, Number.NaN, 1, 2);
    expect(d.read(10).motion).toBe(false);
  });
});

describe('走ると光る：動きのセンサーが無いスマホは、スマホが出す速さで決める', () => {
  const origin = { lat: 35.3881, lon: 139.4272 };
  /** 北へ v m/s で、1秒ごとの位置（誤差 acc。speed はスマホが出す速さ、null なら出さない） */
  function fixes(d: RunDetector, v: number, n: number, opts: { acc?: number; speed?: number | null; from?: number } = {}): number {
    const from = opts.from ?? 0;
    for (let i = 0; i < n; i++) {
      const north = v * i;
      d.addFix({ t: from + i * 1000, lat: origin.lat + north / 111_195, lon: origin.lon, acc: opts.acc ?? 8, speed: opts.speed === undefined ? v : opts.speed });
    }
    return from + (n - 1) * 1000;
  }

  it('時速13km で走ると走り。歩き（時速5km）は走りでない', () => {
    const d = new RunDetector();
    const end = fixes(d, 3.6, 8);
    expect(d.read(end).running).toBe(true);
    expect(d.read(end).by).toBe('gps');
    const w = new RunDetector();
    const end2 = fixes(w, 1.4, 8);
    expect(w.read(end2).running).toBe(false);
  });

  it('2回続けて速ければ走り（1回だけでは走りでない）', () => {
    const d = new RunDetector();
    d.addFix({ t: 0, lat: origin.lat, lon: origin.lon, acc: 6, speed: 3.4 });
    expect(d.read(0).running).toBe(false);
    d.addFix({ t: 1000, lat: origin.lat, lon: origin.lon, acc: 6, speed: 3.5 });
    expect(d.read(1000).running).toBe(true);
    d.addFix({ t: 2000, lat: origin.lat, lon: origin.lon, acc: 6, speed: 0.5 });
    expect(d.read(2000).running).toBe(false);
  });

  it('位置の誤差が大きいとき・位置が古いときは使わない', () => {
    const d = new RunDetector();
    const end = fixes(d, 4, 8, { acc: 40 });
    expect(d.read(end).running).toBe(false);
    const d2 = new RunDetector();
    const end2 = fixes(d2, 4, 8);
    expect(d2.read(end2 + 4_000).running).toBe(false);
  });

  it('速さを出さないスマホは、位置が動いて見えても走りにしない（止まったまま位置が 9m 飛んで戻らない・1回だけ 30m 飛ぶ）', () => {
    for (const jump of [(i: number) => (i >= 6 ? 9 : 0), (i: number) => (i === 6 ? 30 : 0)]) {
      const d = new RunDetector();
      let any = false;
      for (let i = 0; i < 14; i++) {
        d.addFix({ t: i * 1000, lat: origin.lat + jump(i) / 111_195, lon: origin.lon, acc: 8, speed: null });
        any ||= d.read(i * 1000).running;
      }
      expect(any).toBe(false);
    }
    // 本当に走っていても、速さが出なければ光らない（取り逃がしのほうを選ぶ。隠れている人を光らせないため）
    const d = new RunDetector();
    const end = fixes(d, 4, 8, { speed: null });
    expect(d.read(end).running).toBe(false);
  });

  it('動きのセンサーが届いている間は、位置の速さでは決めない', () => {
    const d = new RunDetector();
    fixes(d, 5, 6, { speed: 5 });
    feed(d, still, 0, 5_100);
    const r = d.read(5_000);
    expect(r.by).toBe('motion');
    expect(r.running).toBe(false);
  });
});

describe('走ると光る：光る・消えるは少し待ってから', () => {
  it(`走りが ${RUN_START_MS}ms 続いたら光り、走りでなくなって ${RUN_STOP_MS}ms で消える。間の一瞬の止まりでは消えない`, () => {
    const l = new RunLatch();
    expect(l.update(0, true)).toBe(false);
    expect(l.update(RUN_START_MS - 50, true)).toBe(false);
    expect(l.update(RUN_START_MS, true)).toBe(true);
    // 一瞬の止まり
    expect(l.update(RUN_START_MS + 500, false)).toBe(true);
    expect(l.update(RUN_START_MS + 900, true)).toBe(true);
    // 本当に止まる
    const stop = RUN_START_MS + 1_000;
    expect(l.update(stop, false)).toBe(true);
    expect(l.update(stop + RUN_STOP_MS - 950, false)).toBe(true);
    expect(l.update(stop + RUN_STOP_MS, false)).toBe(false);
  });

  it('光る前に途切れたら、数え直し', () => {
    const l = new RunLatch();
    l.update(0, true);
    l.update(400, false);
    expect(l.update(RUN_START_MS + 100, true)).toBe(false);
    expect(l.update(RUN_START_MS + 100 + RUN_START_MS, true)).toBe(true);
  });
});

describe('走ると光る：送り方', () => {
  const pos = { lat: 35.388, lon: 139.427, acc: 8 };

  it('光っている間は1秒ごと、止まったら1回だけ「止まった」', () => {
    const r = new RunReporter();
    expect(r.next(0, false, true, pos)).toBeNull();
    expect(r.next(100, true, true, pos)).toEqual({ on: true, pos });
    expect(r.next(600, true, true, pos)).toBeNull();
    expect(r.next(100 + RUN_SEND_EVERY_MS, true, true, null)).toEqual({ on: true, pos: null });
    expect(r.next(1_500, false, true, pos)).toEqual({ on: false });
    expect(r.next(1_600, false, true, pos)).toBeNull();
  });

  it('光ってよい段階が終わった・捕まった・切れた（open=false）ら、光っていても「止まった」を1回', () => {
    const r = new RunReporter();
    r.next(0, true, true, pos);
    expect(r.next(300, true, false, pos)).toEqual({ on: false });
    expect(r.next(2_000, true, false, pos)).toBeNull();
    // 戻ったら、待たずに送り直す
    expect(r.next(2_100, true, true, pos)).toEqual({ on: true, pos });
  });
});

describe('走ると光る：位置の計算', () => {
  const sfc = { lat: 35.38873, lon: 139.42701 };

  it('距離と方角（キャンパスの中の距離なら 1% 以内）', () => {
    const north = { lat: sfc.lat + 300 / 111_195, lon: sfc.lon };
    expect(distanceM(sfc, north)).toBeGreaterThan(297);
    expect(distanceM(sfc, north)).toBeLessThan(303);
    expect(Math.round(bearingDeg(sfc, north))).toBe(0);
    const east = { lat: sfc.lat, lon: sfc.lon + 0.002 };
    const o = offsetM(sfc, east);
    // 経度 0.002° は、この緯度で約 181.5m
    expect(o.east).toBeGreaterThan(179);
    expect(o.east).toBeLessThan(184);
    expect(Math.round(bearingDeg(sfc, east))).toBe(90);
    expect(Math.round(bearingDeg(sfc, { lat: sfc.lat - 0.001, lon: sfc.lon - 0.001 }))).toBeGreaterThan(200);
  });

  it('8方位と距離の言葉', () => {
    expect(compassName(0)).toBe('北');
    expect(compassName(44)).toBe('北東');
    expect(compassName(-90)).toBe('西');
    expect(compassName(359)).toBe('北');
    expect(distanceText(8)).toBe('すぐ近く');
    expect(distanceText(84)).toBe('80m');
    expect(distanceText(1234)).toBe('1.2km');
    // 英語：8方位の略と、近いときの言葉（数字は同じ）
    expect(compassNameEn(0)).toBe('N');
    expect(compassNameEn(44)).toBe('NE');
    expect(compassNameEn(-90)).toBe('W');
    expect(distanceTextEn(8)).toBe('CLOSE');
    expect(distanceTextEn(84)).toBe('80m');
  });

  it('地図の縮尺：近いほど広い。0m は真ん中、400m より遠い人は縁', () => {
    expect(radarRadius(0)).toBe(0);
    expect(radarRadius(400)).toBeCloseTo(1, 6);
    expect(radarRadius(900)).toBe(1);
    expect(radarRadius(50)).toBeGreaterThan(0.35);
    let last = -1;
    for (let d = 0; d <= 400; d += 10) {
      expect(radarRadius(d)).toBeGreaterThan(last);
      last = radarRadius(d);
    }
  });
});

describe('走ると光る：方角', () => {
  const abs = (alpha: number, beta: number, gamma: number) => ({ alpha, beta, gamma, absolute: true });
  /** 磁北から測った値を、真北にそろえたもの */
  const trueOf = (magnetic: number) => (((magnetic + MAGNETIC_DECLINATION_DEG) % 360) + 360) % 360;
  const near = (got: number | null, want: number, tol = 0.6) => {
    expect(got).not.toBeNull();
    const d = ((got! - want + 540) % 360) - 180;
    expect(Math.abs(d)).toBeLessThan(tol);
  };

  it('iPhone は webkitCompassHeading（磁北から）を真北にそろえる', () => {
    near(headingOf({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 123 }), trueOf(123));
    expect(MAGNETIC_DECLINATION_DEG).toBeLessThan(0);
  });

  it('Android：寝かせても立てても、持っている人の前の方角', () => {
    // 寝かせて、画面の上が北
    near(headingOf(abs(0, 0, 0)), trueOf(0));
    // 寝かせて、左へ90°回す（画面の上が西）
    near(headingOf(abs(90, 0, 0)), trueOf(270));
    // 45°起こして持つ（ふつうに見る持ち方）
    near(headingOf(abs(0, 45, 0)), trueOf(0));
    near(headingOf(abs(270, 45, 0)), trueOf(90));
    // 立てて持つ（背中のカメラの向き）
    near(headingOf(abs(0, 90, 0)), trueOf(0));
    near(headingOf(abs(180, 90, 0)), trueOf(180));
    // 起こしていく途中（60°〜85°）も向きは変わらない
    for (const beta of [55, 65, 75, 85]) near(headingOf(abs(90, beta, 0)), trueOf(270));
  });

  it('寝かせたまま左右に傾けても、方角はずれない（45°までの持ち方）', () => {
    for (const beta of [0, 20, 45]) {
      for (const gamma of [-20, -10, 10, 20]) near(headingOf(abs(30, beta, gamma)), trueOf(330));
    }
  });

  it('北を基準にしていない向き（absolute でない）は使わない', () => {
    expect(headingOf({ alpha: 0, beta: 0, gamma: 0, absolute: false })).toBeNull();
    expect(headingOf({ alpha: null, beta: null, gamma: null, absolute: true })).toBeNull();
  });
});
