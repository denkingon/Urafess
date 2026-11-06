import { describe, expect, it } from 'vitest';
import { autoPick, captureOpenAt, pickCodes, rankCandidates, relateHolds, viaOf, type OniSignal } from '../src/shared/capture';
import { CLAIM_PAIR_WINDOW_MS, HEARD_SLACK_MS, HOLD_MAX_MS, START_LEAD_MS } from '../src/shared/rules';
import { pauseTimer, startTimer } from '../src/shared/schedule';

const oni = (pid: string, num: number, holds: OniSignal['holds'], extra: Partial<OniSignal> = {}): OniSignal => ({
  pid,
  num,
  name: pid,
  holds,
  heardAt: null,
  nominatedAt: null,
  ...extra,
});

describe('長押しどうしの関係', () => {
  it('同じ時間に押していれば「同時」', () => {
    expect(relateHolds([{ start: 1000, end: 3000 }], [{ start: 2500, end: 4000 }], 9000)).toEqual({ together: true, gapMs: 0 });
  });

  it('押している途中（離していない）も、今まで押しているとみなす', () => {
    expect(relateHolds([{ start: 1000, end: null }], [{ start: 1800, end: null }], 2000).together).toBe(true);
  });

  it('重なっていなければ、一番近いところの離れ具合', () => {
    expect(relateHolds([{ start: 1000, end: 2000 }], [{ start: 5000, end: 6000 }, { start: 2600, end: 2700 }], 9000)).toEqual({
      together: false,
      gapMs: 600,
    });
  });

  it('離した知らせが来ないまま（電波切れ）でも、HOLD_MAX_MS で離したとみなす', () => {
    const r = relateHolds([{ start: 0, end: null }], [{ start: HOLD_MAX_MS + 1000, end: HOLD_MAX_MS + 2000 }], HOLD_MAX_MS * 3);
    expect(r).toEqual({ together: false, gapMs: 1000 });
  });
});

describe('逃走者に並べる候補', () => {
  const runner = [{ start: 10_000, end: 12_000 }];

  it('同時に長押しした鬼・前後に長押しした鬼が並び、関係ない鬼は出ない', () => {
    const list = rankCandidates(
      runner,
      [
        oni('far', 1, [{ start: 10_000 + CLAIM_PAIR_WINDOW_MS + 5_000, end: 10_000 + CLAIM_PAIR_WINDOW_MS + 6_000 }]),
        oni('near', 2, [{ start: 15_000, end: 16_000 }]),
        oni('with', 3, [{ start: 11_000, end: 13_000 }]),
        oni('none', 4, []),
      ],
      60_000,
    );
    expect(list.map((c) => c.pid)).toEqual(['with', 'near']);
    expect(list[0]).toMatchObject({ together: true, gapMs: 0, heard: false });
    expect(list[1]).toMatchObject({ together: false, gapMs: 3_000 });
  });

  it('音を拾った鬼が一番前。長押しが無くても、音か手動で選んだ鬼は出る', () => {
    const list = rankCandidates(
      runner,
      [
        oni('with', 1, [{ start: 11_000, end: 13_000 }]),
        oni('heard', 2, [], { heardAt: 11_500 }),
        oni('picked', 3, [], { nominatedAt: 20_000 }),
      ],
      30_000,
    );
    expect(list.map((c) => c.pid)).toEqual(['heard', 'with', 'picked']);
    expect(list.map(viaOf)).toEqual(['sound', 'together', 'nominated']);
  });

  it('同じ強さなら長押しが近い順、それも同じなら番号順', () => {
    const list = rankCandidates(
      runner,
      [oni('b', 9, [{ start: 13_000, end: 13_500 }]), oni('a', 5, [{ start: 13_000, end: 13_500 }]), oni('c', 1, [{ start: 14_000, end: 15_000 }])],
      30_000,
    );
    expect(list.map((c) => c.pid)).toEqual(['a', 'b', 'c']);
  });

  it('並べるのは6人まで', () => {
    const many = Array.from({ length: 10 }, (_, i) => oni(`o${i}`, i, [{ start: 11_000, end: 11_500 }]));
    expect(rankCandidates(runner, many, 30_000)).toHaveLength(6);
  });

  it('候補でない鬼を選んだときは「手動」', () => {
    expect(viaOf(undefined)).toBe('manual');
  });
});

describe('捕まえられる時間', () => {
  const D = [20_000, 60_000, 300_000, 120_000];
  const t = startTimer(D, 0);
  const at = (ms: number) => START_LEAD_MS + ms;

  it('「ゲーム」の段階だけ', () => {
    expect(captureOpenAt(t, at(10_000))).toBe(false);
    expect(captureOpenAt(t, at(70_000))).toBe(false);
    expect(captureOpenAt(t, at(80_000))).toBe(true);
    expect(captureOpenAt(t, at(379_000))).toBe(true);
    expect(captureOpenAt(t, at(381_000))).toBe(false);
  });

  it('一時停止中・タイマーが無いときはできない', () => {
    expect(captureOpenAt(pauseTimer(t, at(100_000)), at(100_000))).toBe(false);
    expect(captureOpenAt(null, 0)).toBe(false);
  });
});

describe('その回の3桁', () => {
  it('部屋の中で重ならない3桁', () => {
    const codes = pickCodes(300);
    expect(new Set(codes).size).toBe(300);
    expect(codes.every((c) => /^[1-9]\d\d$/.test(c))).toBe(true);
  });
});

describe('選ばなくていいとき（鬼がちょうど1人に決まる）', () => {
  const runner = [{ start: 10_000, end: 13_000 }];
  const o = (num: number, holds: { start: number; end: number | null }[], heardAt: number | null = null): OniSignal => ({
    pid: `o${num}`, num, name: `鬼${num}`, holds, heardAt, nominatedAt: null,
  });

  it('長押しが重なった鬼が1人だけなら、その鬼', () => {
    expect(autoPick(runner, [o(1, [{ start: 11_000, end: 12_000 }]), o(2, [{ start: 20_000, end: 21_000 }])], 14_000)?.pid).toBe('o1');
  });

  it('鬼は押していなくても、長押しの間に音を拾った鬼が1人だけなら、その鬼（ずっと聞いている鬼）', () => {
    expect(autoPick(runner, [o(1, [], 11_500), o(2, [])], 14_000)?.pid).toBe('o1');
    // 離したあとの知らせも、回線の遅れの分は待つ
    expect(autoPick(runner, [o(1, [], 13_000 + HEARD_SLACK_MS)], 16_000)?.pid).toBe('o1');
  });

  it('長押しの前や、ずっとあとに拾った音では決めない', () => {
    expect(autoPick(runner, [o(1, [], 9_000)], 14_000)).toBeNull();
    expect(autoPick(runner, [o(1, [], 13_000 + HEARD_SLACK_MS + 1)], 20_000)).toBeNull();
  });

  it('2人以上なら決めない（候補を並べて逃走者が選ぶ）', () => {
    expect(autoPick(runner, [o(1, [{ start: 11_000, end: 12_000 }]), o(2, [], 12_000)], 14_000)).toBeNull();
    expect(autoPick(runner, [o(1, [{ start: 11_000, end: 12_000 }]), o(2, [{ start: 12_500, end: 13_500 }])], 14_000)).toBeNull();
  });

  it('前後に押しただけ・誰もいないなら決めない', () => {
    expect(autoPick(runner, [o(1, [{ start: 15_000, end: 16_000 }])], 17_000)).toBeNull();
    expect(autoPick(runner, [], 14_000)).toBeNull();
  });
});

