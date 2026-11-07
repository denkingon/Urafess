import { describe, expect, it } from 'vitest';
import { allocateCounts, assignRoles, manualRoles } from '../src/shared/allocate';
import { ROLES } from '../src/shared/rules';

/** 計画書の規則を素直に書いたもの：人数×0.3に一番近い整数、ちょうど半分なら鬼を少なく、2人以上なら両方1人以上 */
function expectedOni(n: number): number {
  let oni = (3 * n) % 10 === 5 ? Math.floor((3 * n) / 10) : Math.round((3 * n) / 10);
  if (n >= 2) oni = Math.min(Math.max(oni, 1), n - 1);
  return oni;
}

describe('配役の人数（鬼3：逃走者7）', () => {
  it('1〜300人の全部で規則どおり', () => {
    for (let n = 1; n <= 300; n++) {
      const [oni, runner] = allocateCounts(n, ROLES);
      expect(oni + runner, `n=${n}`).toBe(n);
      expect(oni, `n=${n}`).toBe(expectedOni(n));
      if (n >= 2) {
        expect(oni).toBeGreaterThanOrEqual(1);
        expect(runner).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('計画書の表と一致する', () => {
    const table: [number, number, number][] = [
      [1, 0, 1], [2, 1, 1], [3, 1, 2], [4, 1, 3], [5, 1, 4], [10, 3, 7],
      [15, 4, 11], [30, 9, 21], [35, 10, 25], [100, 30, 70], [150, 45, 105], [300, 90, 210],
    ];
    for (const [n, oni, runner] of table) expect(allocateCounts(n, ROLES), `n=${n}`).toEqual([oni, runner]);
  });

  it('0人なら0人ずつ', () => {
    expect(allocateCounts(0, ROLES)).toEqual([0, 0]);
  });
});

/** 種つき乱数（テストを毎回同じ結果にする） */
function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return (max: number) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x % max;
  };
}

describe('くじ', () => {
  it('全員にちょうど1つずつ役が付き、人数は表どおり', () => {
    for (const n of [1, 2, 7, 30, 300]) {
      const pids = Array.from({ length: n }, (_, i) => `p${i}`);
      const roles = assignRoles(pids, ROLES, seeded(n));
      expect(roles.size).toBe(n);
      const oni = [...roles.values()].filter((r) => r === 'oni').length;
      expect(oni).toBe(allocateCounts(n, ROLES)[0]);
    }
  });

  it('偏りがない（10人で2万回、誰もがほぼ3割の確率で鬼になる）', () => {
    const pids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const hits = new Map(pids.map((p) => [p, 0]));
    const rand = seeded(12345);
    const runs = 20_000;
    for (let r = 0; r < runs; r++) {
      for (const [pid, role] of assignRoles(pids, ROLES, rand)) if (role === 'oni') hits.set(pid, hits.get(pid)! + 1);
    }
    for (const [pid, h] of hits) expect(Math.abs(h / runs - 0.3), pid).toBeLessThan(0.015);
  });

  it('本番の乱数（crypto）でも動く', () => {
    const pids = Array.from({ length: 300 }, (_, i) => `p${i}`);
    const roles = assignRoles(pids, ROLES);
    expect([...roles.values()].filter((r) => r === 'oni').length).toBe(90);
  });
});

describe('親が選ぶ配役', () => {
  const people = ['a', 'b', 'c'];
  const chosen = [{ pid: 'c', role: 'oni' }, { pid: 'a', role: 'runner' }, { pid: 'b', role: 'runner' }];
  it('人数比と並び順に左右されず、指定した本人に指定した役を割り当てる', () => {
    expect(manualRoles(people, chosen)).toEqual(new Map([['c', 'oni'], ['a', 'runner'], ['b', 'runner']]));
  });
  it.each([
    undefined, null, {}, [], chosen.slice(0, 2), [...chosen, chosen[0]],
    [chosen[0], chosen[1], chosen[1]],
    [chosen[0], chosen[1], { pid: 'unknown', role: 'runner' }],
    [chosen[0], chosen[1], { pid: 'b', role: 'host' }],
    [null, chosen[1], chosen[2]],
    people.map((pid) => ({ pid, role: 'runner' })),
    people.map((pid) => ({ pid, role: 'oni' })),
  ].map((input) => ({ input })))('不足・重複・知らない人・不正な役・片方だけの配役を拒否する: $input', ({ input }) => {
    expect(manualRoles(people, input)).toBeNull();
  });
  it('参加者0人は不可、1人なら片方だけで試せる', () => {
    expect(manualRoles([], [])).toBeNull();
    expect(manualRoles(['a'], [{ pid: 'a', role: 'oni' }])?.get('a')).toBe('oni');
  });
  it('300人にも指定通りに割り当てる', () => {
    const pids = Array.from({ length: 300 }, (_, i) => `p${i}`);
    const roles = manualRoles(pids, pids.map((pid, i) => ({ pid, role: i < 42 ? 'oni' : 'runner' })));
    expect(roles?.size).toBe(300);
    expect([...roles!.values()].filter((r) => r === 'oni')).toHaveLength(42);
  });
});
