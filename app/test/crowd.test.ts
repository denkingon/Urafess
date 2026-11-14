import { describe, expect, it } from 'vitest';
import { CROWD_NAMES, advance, crowdName, dist, inside, newBot, offset, phaseOf, pickSpot, seeded, think, type Other, type World } from '../src/shared/crowd';
import { nameKey, normalizeName } from '../src/shared/names';
import type { GameView } from '../src/shared/protocol';
import { startTimer } from '../src/shared/schedule';

const HOME = { lat: 35.38873, lon: 139.42701 };

function world(phase: World['phase'], now = 0, anyJailed = false): World {
  return { phase, home: HOME, jail: offset(HOME, 18, -14), reach: 180, now, rng: seeded(7), anyJailed };
}

/** sec 秒ぶん、0.25秒きざみで考えて動かす */
function run(bot: ReturnType<typeof newBot>, role: 'oni' | 'runner', caught: boolean, others: () => Other[], phase: World['phase'], sec: number, anyJailed = false): void {
  const w = world(phase, 0, anyJailed);
  for (let t = 0; t < sec * 4; t++) {
    w.now = t * 250;
    think(bot, role, caught, others(), w);
    advance(bot, 0.25);
  }
}

describe('偽の群衆：座標', () => {
  it('東へ100m・北へ50mずらすと、その距離になる', () => {
    const p = offset(HOME, 100, 50);
    expect(dist(HOME, p)).toBeCloseTo(Math.hypot(100, 50), 0);
  });
});

describe('偽の群衆：段階', () => {
  const base: GameView = { gameId: 'g', round: 1, assignId: 1, stage: 'lobby', cv: 1, timer: null, counts: { oni: 3, runner: 7, total: 10, caught: 0 }, result: null, durations: [20_000, 60_000, 300_000, 120_000] };
  it('配役前は idle、配役済みは ready', () => {
    expect(phaseOf(base, 0)).toBe('idle');
    expect(phaseOf({ ...base, stage: 'assigned' }, 0)).toBe('ready');
  });
  it('タイマーの4つの段階と、終わったあと', () => {
    const timer = startTimer(base.durations, 0);
    const g: GameView = { ...base, stage: 'timer', timer };
    const t0 = timer.t0;
    expect(phaseOf(g, t0 + 1_000)).toBe('wait');
    expect(phaseOf(g, t0 + 30_000)).toBe('escape');
    expect(phaseOf(g, t0 + 100_000)).toBe('game');
    expect(phaseOf(g, t0 + 400_000)).toBe('return');
    expect(phaseOf(g, t0 + 999_000)).toBe('return');
    expect(phaseOf({ ...g, timer: { ...timer, status: 'paused', pausedElapsed: 100_000 } }, t0 + 100_000)).toBe('paused');
  });
});

describe('偽の群衆：動き', () => {
  it('逃走開始までは、その場で待つ', () => {
    const b = newBot(HOME, seeded(1));
    const from = { ...b.pos };
    run(b, 'runner', false, () => [], 'wait', 10);
    expect(dist(from, b.pos)).toBeLessThan(0.1);
  });
  it('追跡開始まで：逃走者は広場から離れ、鬼は広場に残る', () => {
    const r = newBot(HOME, seeded(2));
    const o = newBot(HOME, seeded(3));
    run(r, 'runner', false, () => [], 'escape', 40);
    run(o, 'oni', false, () => [], 'escape', 40);
    expect(dist(HOME, r.pos)).toBeGreaterThan(50);
    expect(dist(HOME, o.pos)).toBeLessThan(15);
  });
  it('ゲーム：鬼は見える逃走者に向かって走り、触れる距離まで寄る', () => {
    const o = newBot(HOME, seeded(4));
    const target: Other = { pos: offset(o.pos, 40, 0), role: 'runner', caught: false, lit: false };
    run(o, 'oni', false, () => [target], 'game', 20);
    expect(o.act).toBe('chase');
    expect(dist(o.pos, target.pos)).toBeLessThan(3);
  });
  it('ゲーム：鬼は遠くても光った人に寄っていく。牢屋の人は追わない', () => {
    const o = newBot(HOME, seeded(5));
    const start = { ...o.pos };
    const lit: Other = { pos: offset(start, 150, 0), role: null, caught: false, lit: true };
    run(o, 'oni', false, () => [lit], 'game', 10);
    expect(dist(o.pos, lit.pos)).toBeLessThan(dist(start, lit.pos) - 10);
    const o2 = newBot(HOME, seeded(5));
    run(o2, 'oni', false, () => [{ pos: offset(o2.pos, 20, 0), role: 'runner', caught: true, lit: false }], 'game', 3);
    expect(o2.act).toBe('patrol');
  });
  it('ゲーム：逃走者は近づいた鬼から離れる', () => {
    const r = newBot(HOME, seeded(6));
    r.spot = { ...r.pos };
    const oni: Other = { pos: offset(r.pos, 20, 0), role: 'oni', caught: false, lit: false };
    run(r, 'runner', false, () => [oni], 'game', 1);
    expect(r.act).toBe('flee');
    expect(r.pace).toBe('run');
    run(r, 'runner', false, () => [oni], 'game', 6);
    expect(dist(r.pos, oni.pos)).toBeGreaterThan(30);
  });
  it('捕まった逃走者は牢屋へ歩いて、そこで止まる', () => {
    const r = newBot(HOME, seeded(8));
    r.pos = offset(HOME, 120, 60);
    run(r, 'runner', true, () => [], 'game', 150);
    expect(r.act).toBe('jail');
    expect(dist(r.pos, offset(HOME, 18, -14))).toBeLessThan(4);
  });
  it('牢屋に人がいると、度胸のある逃走者は牢屋へ向かう', () => {
    const r = newBot(HOME, seeded(9));
    r.nerve = 0.9;
    r.pos = offset(HOME, 80, 0);
    run(r, 'runner', false, () => [], 'game', 5, true);
    expect(r.act).toBe('rescue');
  });
  it('広場に戻る：全員が広場の近くへ', () => {
    const r = newBot(HOME, seeded(10));
    r.pos = offset(HOME, 100, -80);
    run(r, 'runner', false, () => [], 'return', 120);
    expect(dist(HOME, r.pos)).toBeLessThan(10);
  });
  it('走り続けると息が切れて歩きになる', () => {
    const o = newBot(HOME, seeded(11));
    const far: Other = { pos: offset(o.pos, 5_000, 0), role: null, caught: false, lit: true };
    const w = world('game');
    let ran = 0;
    for (let t = 0; t < 240; t++) {
      w.now = t * 250;
      far.pos = offset(o.pos, 200, 0);
      think(o, 'oni', false, [far], w);
      if (advance(o, 0.25) > 2.8) ran++;
    }
    expect(ran).toBeGreaterThan(40);
    expect(ran).toBeLessThan(220);
  });
});

describe('偽の群衆：枠', () => {
  const BOX = { north: 35.3919, west: 139.4246, south: 35.3835, east: 139.4323 };
  it('枠があれば、隠れ場所は枠の中から選ぶ。逃げる先も枠から出ない', () => {
    const w = { ...world('game'), reach: 300, bounds: BOX };
    for (let i = 0; i < 300; i++) expect(inside(pickSpot(w), BOX)).toBe(true);
    const r = newBot(HOME, seeded(12));
    r.pos = { lat: 35.3880, lon: 139.4247 };
    r.spot = { ...r.pos };
    const oni: Other = { pos: offset(r.pos, 20, 0), role: 'oni', caught: false, lit: false };
    for (let t = 0; t < 80; t++) {
      w.now = t * 250;
      think(r, 'runner', false, [oni], w);
      advance(r, 0.25);
      expect(inside(r.pos, BOX)).toBe(true);
    }
  });
});

describe('偽の群衆：名前', () => {
  it('名前は名簿の決まりで全部ちがい、そのまま入れる', () => {
    const keys = new Set(CROWD_NAMES.map(nameKey));
    expect(keys.size).toBe(CROWD_NAMES.length);
    for (const n of CROWD_NAMES) expect(normalizeName(n)).toBe(n);
  });
  it('足りなくなったら数字、ぶつかったら印がつく', () => {
    expect(crowdName(0)).toBe(CROWD_NAMES[0]);
    expect(crowdName(CROWD_NAMES.length)).toBe(`${CROWD_NAMES[0]}2`);
    expect(crowdName(0, 1)).toBe(`${CROWD_NAMES[0]}_2`);
    expect(normalizeName(crowdName(CROWD_NAMES.length * 3 + 5, 2))).not.toBeNull();
  });
});
