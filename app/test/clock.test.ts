import { describe, expect, it } from 'vitest';
import { ClockEstimator } from '../src/shared/clock';

/**
 * スマホの時計がサーバーより skew だけずれていて、行き・帰りの遅れがばらばらな状況を作り、
 * ずれの見積もりがどれだけ正確かを確かめる。
 */
function simulate(opts: { skew: number; samples: number; up: () => number; down: () => number }) {
  const est = new ClockEstimator();
  let server = 1_000_000;
  for (let i = 0; i < opts.samples; i++) {
    server += 100;
    const up = opts.up();
    const down = opts.down();
    const a = server - opts.skew; // スマホの時計で送った時刻
    const s = server + up; // サーバーが受け取って返した時刻
    const b = s + down - opts.skew; // スマホの時計で受け取った時刻
    est.add(a, s, b);
  }
  // サーバー時刻 ≒ スマホの時計 + offset なので、正しい offset は skew
  return { error: Math.abs(est.offset()! - opts.skew), bound: est.errorBound()! };
}

function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

describe('時計合わせ', () => {
  it('行きと帰りが同じなら、ずれはぴったり出る', () => {
    const r = simulate({ skew: 123_456, samples: 5, up: () => 40, down: () => 40 });
    expect(r.error).toBeLessThan(1e-9);
  });

  it('遅れがばらばらでも、往復が一番短い回を使えば誤差は小さい', () => {
    const rand = rng(7);
    // 20〜300ms の遅れに、時々 0.8〜2秒の詰まりが混ざる
    const lag = () => (rand() < 0.1 ? 800 + rand() * 1200 : 20 + rand() * 280);
    const r = simulate({ skew: -300_000, samples: 8, up: lag, down: lag });
    expect(r.error).toBeLessThanOrEqual(r.bound);
    expect(r.error).toBeLessThan(100);
  });

  it('誤差は必ず「往復の半分」以内に収まる', () => {
    const rand = rng(99);
    for (let k = 0; k < 200; k++) {
      const r = simulate({ skew: (rand() - 0.5) * 600_000, samples: 6, up: () => 10 + rand() * 500, down: () => 10 + rand() * 500 });
      expect(r.error).toBeLessThanOrEqual(r.bound + 1e-6);
    }
  });

  it('おかしな測定（負の往復・長すぎる往復）は捨てる', () => {
    const est = new ClockEstimator({ maxRttMs: 5_000 });
    expect(est.add(100, 50, 90)).toBeNull();
    expect(est.add(0, 50, 6_000)).toBeNull();
    expect(est.offset()).toBeNull();
  });
});
