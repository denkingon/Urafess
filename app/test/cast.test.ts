import { describe, expect, it } from 'vitest';
import { castStatsAll, castStatText, cleanTag, sortCast, type CastEvent } from '../src/shared/cast';

let at = 0;
const ev = (kind: string, o: Partial<CastEvent> & { d?: unknown } = {}): CastEvent => ({
  at: (at += 1000),
  assign_id: o.assign_id ?? 1,
  kind,
  pid: o.pid ?? null,
  other_pid: o.other_pid ?? null,
  elapsed: o.elapsed ?? null,
  data: o.d === undefined ? null : JSON.stringify(o.d),
});
/** 逃走開始まで20秒・追跡開始まで60秒・ゲーム300秒 */
const START = { d: { durations: [20_000, 60_000, 300_000, 120_000] } };
const role = (pid: string, r: string, assign_id = 1) => ev('role', { pid, assign_id, d: { role: r } });

describe('配役のための数字', () => {
  it('捕まるまでの時間は、追跡開始から最初に捕まるまで。逃げ切りはゲームの長さ', () => {
    const s = castStatsAll([
      role('a', 'runner'), role('b', 'runner'), role('o', 'oni'),
      ev('start', START),
      ev('capture', { pid: 'o', other_pid: 'a', elapsed: 80_000 + 90_000 }),
    ]);
    expect(s.get('a')).toMatchObject({ runs: 1, caught: 1, holdMs: 90_000 });
    expect(s.get('b')).toMatchObject({ runs: 1, caught: 0, holdMs: 300_000 });
    expect(s.get('o')).toMatchObject({ oni: 1, catches: 1, runs: 0, holdMs: null });
  });

  it('助けられてまた捕まっても、最初の1回で数える。取り消した捕獲は数えない', () => {
    const s = castStatsAll([
      role('a', 'runner'), role('b', 'runner'), role('o', 'oni'),
      ev('start', START),
      ev('capture', { pid: 'o', other_pid: 'a', elapsed: 80_000 + 30_000 }),
      ev('capture', { pid: 'o', other_pid: 'a', elapsed: 80_000 + 200_000 }),
      ev('capture', { pid: 'o', other_pid: 'b', elapsed: 80_000 + 10_000 }),
      ev('release', { pid: 'o', other_pid: 'b' }),
    ]);
    expect(s.get('a')).toMatchObject({ caught: 1, holdMs: 30_000 });
    expect(s.get('b')).toMatchObject({ caught: 0, holdMs: 300_000 });
    expect(s.get('o')!.catches).toBe(2);
  });

  it('何ラウンドかの平均。始まらなかった配役・やり直したラウンドは数えない。新しい夜で番号が戻っても別のラウンド', () => {
    const s = castStatsAll([
      role('a', 'runner', 1), ev('start', { ...START, assign_id: 1 }),
      ev('capture', { other_pid: 'a', elapsed: 80_000 + 60_000, assign_id: 1 }),
      role('a', 'runner', 2), // 引き直して始めなかった
      role('a', 'runner', 3), ev('start', { ...START, assign_id: 3 }),
      ev('capture', { other_pid: 'a', elapsed: 80_000 + 5_000, assign_id: 3 }), ev('reset', { assign_id: 3 }),
      ev('clear'),
      role('a', 'runner', 1), ev('start', { ...START, assign_id: 1 }),
    ]);
    // 60秒で捕まった回と、逃げ切った（300秒）回
    expect(s.get('a')).toMatchObject({ runs: 2, caught: 1, holdMs: 180_000 });
  });

  it('主催者が動かした役（recast）で数える。「次に進む」でゲームを縮めたら、そこまでが長さ', () => {
    const s = castStatsAll([
      role('a', 'oni'), ev('recast', { pid: 'a', d: { role: 'runner', from: 'oni' } }),
      ev('start', START),
      ev('skip', { elapsed: 80_000 + 100_000, d: { from: 2 } }),
    ]);
    expect(s.get('a')).toMatchObject({ runs: 1, oni: 0, caught: 0, holdMs: 102_000 });
  });

  it('速さは「走ると光る」の距離÷時間。短い走り・位置の飛びは捨てる', () => {
    const s = castStatsAll([
      ev('run-end', { pid: 'a', d: { ms: 10_000, m: 40 } }),
      ev('run-end', { pid: 'a', d: { ms: 10_000, m: 60 } }),
      ev('run-end', { pid: 'a', d: { ms: 2_000, m: 15 } }), // 短い
      ev('run-end', { pid: 'a', d: { ms: 5_000, m: 400 } }), // 飛び
      ev('run-end', { pid: 'b', d: { ms: 8_000, m: 4 } }), // 近い
    ]);
    expect(s.get('a')!.speed).toBe(5);
    expect(s.get('b')).toBeUndefined();
  });

  it('1行にする', () => {
    expect(castStatText(undefined)).toBe('');
    expect(castStatText({ runs: 3, caught: 2, holdMs: 130_000, oni: 1, catches: 4, speed: 4.25 })).toBe(
      '捕まるまで 2:10（3回中2回捕まった）・秒速 4.3m・鬼1回で4人捕まえた',
    );
  });
});

describe('並べ方と印', () => {
  const st = (holdMs: number | null, speed: number | null) => ({ runs: 1, caught: 0, holdMs, oni: 0, catches: 0, speed });
  const list = [
    { num: 1, wish: null, tags: ['女'], stat: st(100, 3) },
    { num: 2, wish: 'runner', tags: ['男'], stat: st(300, null) },
    { num: 3, wish: 'oni' },
    { num: 4, wish: null, tags: ['女', '速い'], stat: st(200, 6) },
    { num: 5, wish: 'oni', tags: ['女'] },
  ];
  const nums = (by: Parameters<typeof sortCast>[1]) => sortCast(list, by).map((x) => x.num);
  it('数字の無い人は下。同じなら入った順', () => {
    expect(nums('num')).toEqual([1, 2, 3, 4, 5]);
    expect(nums('hold')).toEqual([2, 4, 1, 3, 5]);
    expect(nums('speed')).toEqual([4, 1, 2, 3, 5]);
    expect(nums('wish')).toEqual([3, 5, 2, 1, 4]);
  });
  it('印は同じ印の人がまとまる。印の無い人は下', () => {
    const out = nums('tag');
    expect(out.slice(-1)).toEqual([3]);
    expect(Math.abs(out.indexOf(1) - out.indexOf(5))).toBe(1);
  });
  it('印をきれいにする', () => {
    expect(cleanTag(' 男 ')).toBe('男');
    expect(cleanTag('ＡＢ')).toBe('AB');
    expect(cleanTag('')).toBeNull();
    expect(cleanTag('1234567')).toBeNull();
    expect(cleanTag(3)).toBeNull();
  });
});
