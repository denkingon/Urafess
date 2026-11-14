import { describe, expect, it } from 'vitest';
import { allocateCounts, assignRoles, assignWithWishes, type WishEntry } from '../src/shared/allocate';
import { ROLES, WISH_MISS_MAX, type RoleId } from '../src/shared/rules';

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

/** n 人ぶんの希望を作る。wishes[i] が無い人は「どちらでも」 */
function crowd(wishes: (RoleId | null)[], miss: number[] = []): WishEntry[] {
  return wishes.map((wish, i) => ({ pid: `p${i}`, wish, miss: miss[i] ?? 0 }));
}
const countOf = (roles: Map<string, RoleId>, id: RoleId) => [...roles.values()].filter((r) => r === id).length;

describe('希望を聞く配役', () => {
  it('人数はいつも割合どおり（希望がどう偏っても変わらない）', () => {
    const rand = seeded(7);
    for (const n of [1, 2, 3, 7, 10, 30, 300]) {
      for (const pick of [() => null, () => 'runner' as const, () => 'oni' as const, (i: number) => (i % 3 === 0 ? 'oni' : i % 3 === 1 ? 'runner' : null) as RoleId | null]) {
        const people = crowd(Array.from({ length: n }, (_, i) => pick(i)));
        const { roles } = assignWithWishes(people, ROLES, rand);
        expect(roles.size, `n=${n}`).toBe(n);
        expect([countOf(roles, 'oni'), countOf(roles, 'runner')], `n=${n}`).toEqual(allocateCounts(n, ROLES));
      }
    }
  });

  it('希望が枠に収まっていれば、全員が希望どおり。希望なしの人が残りを埋める', () => {
    // 10人：鬼の枠3・逃走者の枠7。鬼希望2・逃走者希望5・どちらでも3
    const people = crowd(['oni', 'oni', 'runner', 'runner', 'runner', 'runner', 'runner', null, null, null]);
    for (let seed = 1; seed <= 50; seed++) {
      const { roles, missed, miss } = assignWithWishes(people, ROLES, seeded(seed));
      for (const p of people) if (p.wish) expect(roles.get(p.pid), p.pid).toBe(p.wish);
      expect(missed).toEqual([]);
      expect([...miss.values()].every((m) => m === 0)).toBe(true);
      // どちらでもの3人のうち、1人が鬼・2人が逃走者
      expect(['p7', 'p8', 'p9'].filter((pid) => roles.get(pid) === 'oni')).toHaveLength(1);
    }
  });

  it('希望が枠より多い役は、枠の人数だけ通り、外れた人はもう一方の役になる', () => {
    // 10人全員が逃走者を希望：7人が通り、3人が鬼になる
    const people = crowd(Array.from({ length: 10 }, () => 'runner' as const));
    const { roles, missed, miss } = assignWithWishes(people, ROLES, seeded(3));
    expect(countOf(roles, 'runner')).toBe(7);
    expect(missed).toHaveLength(3);
    for (const pid of missed) {
      expect(roles.get(pid)).toBe('oni');
      expect(miss.get(pid)).toBe(1);
    }
    for (const p of people) if (!missed.includes(p.pid)) expect(miss.get(p.pid)).toBe(0);
  });

  it('外れるのは、希望した人の中からのくじ（誰もがほぼ同じ確率）', () => {
    const people = crowd(Array.from({ length: 10 }, () => 'runner' as const));
    const hits = new Map(people.map((p) => [p.pid, 0]));
    const rand = seeded(2468);
    const runs = 20_000;
    for (let r = 0; r < runs; r++) for (const pid of assignWithWishes(people, ROLES, rand).missed) hits.set(pid, hits.get(pid)! + 1);
    for (const [pid, h] of hits) expect(Math.abs(h / runs - 0.3), pid).toBeLessThan(0.015);
  });

  it('前に外れた人は先に通る（続けて外れた回数が多い人ほど先）', () => {
    // 10人全員が逃走者を希望。p0〜p2 は前回外れた（1回）、p3 は2回続けて外れた
    const people = crowd(Array.from({ length: 10 }, () => 'runner' as const), [1, 1, 1, 2]);
    for (let seed = 1; seed <= 200; seed++) {
      const { roles, miss } = assignWithWishes(people, ROLES, seeded(seed));
      for (const pid of ['p0', 'p1', 'p2', 'p3']) {
        expect(roles.get(pid), `seed=${seed} ${pid}`).toBe('runner');
        expect(miss.get(pid)).toBe(0);
      }
    }
    // 枠（7）より「前に外れた人」が多いときは、回数が多い人から。同じ回数どうしはくじ
    const many = crowd(Array.from({ length: 10 }, () => 'runner' as const), [2, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
    const out = new Map<string, number>();
    for (let seed = 1; seed <= 300; seed++) {
      const { roles, miss } = assignWithWishes(many, ROLES, seeded(seed));
      for (const pid of ['p0', 'p1', 'p2', 'p3', 'p4']) expect(roles.get(pid)).toBe('runner');
      for (const p of many) {
        if (roles.get(p.pid) === 'oni') {
          out.set(p.pid, (out.get(p.pid) ?? 0) + 1);
          expect(miss.get(p.pid)).toBe(2);
        }
      }
    }
    // 1回の5人（p5〜p9）から3人が外れる。誰か1人に偏らない
    expect([...out.keys()].sort()).toEqual(['p5', 'p6', 'p7', 'p8', 'p9']);
    for (const h of out.values()) expect(h).toBeGreaterThan(120);
  });

  it('全員が同じ役を希望し続けても、続けて2回外れる人は出ない（枠が外れた人数より多いとき）', () => {
    let people = crowd(Array.from({ length: 10 }, () => 'runner' as const));
    const rand = seeded(99);
    let prevMissed: string[] = [];
    const oniTimes = new Map(people.map((p) => [p.pid, 0]));
    for (let round = 0; round < 30; round++) {
      const { roles, missed, miss } = assignWithWishes(people, ROLES, rand);
      for (const pid of prevMissed) expect(roles.get(pid), `round=${round}`).toBe('runner');
      for (const pid of missed) oniTimes.set(pid, oniTimes.get(pid)! + 1);
      prevMissed = missed;
      people = people.map((p) => ({ ...p, miss: miss.get(p.pid)! }));
    }
    // 30ラウンド×3人＝90回の鬼を10人で分ける。誰か1人が背負わない
    for (const t of oniTimes.values()) expect(t).toBeLessThanOrEqual(15);
  });

  it('希望なしの人の回数は変わらない。希望が通れば 0 に戻る。上限で止まる', () => {
    const people: WishEntry[] = [
      { pid: 'a', wish: null, miss: 3 },
      { pid: 'b', wish: 'oni', miss: 5 },
      { pid: 'c', wish: 'runner', miss: WISH_MISS_MAX },
      { pid: 'd', wish: 'runner', miss: WISH_MISS_MAX },
    ];
    // 2人：鬼1・逃走者1 …ではなく4人：鬼1・逃走者3。b は鬼で通る。c・d は逃走者で通る。a は逃走者
    const { roles, miss } = assignWithWishes(people, ROLES, seeded(1));
    expect(roles.get('b')).toBe('oni');
    expect(miss.get('a')).toBe(3);
    expect(miss.get('b')).toBe(0);
    expect(miss.get('c')).toBe(0);
    // 全員が鬼を希望（枠1）：外れた3人は上限を超えない
    const all = people.map((p) => ({ ...p, wish: 'oni' as const, miss: WISH_MISS_MAX }));
    const r2 = assignWithWishes(all, ROLES, seeded(2));
    expect(r2.missed).toHaveLength(3);
    for (const pid of r2.missed) expect(r2.miss.get(pid)).toBe(WISH_MISS_MAX);
  });

  it('おかしな値（知らない役・負の回数・小数）は、希望なし・0回として扱う', () => {
    const people = [
      { pid: 'a', wish: 'third' as unknown as RoleId, miss: -4 },
      { pid: 'b', wish: 'runner' as const, miss: 1.5 },
      { pid: 'c', wish: 'runner' as const, miss: Number.NaN },
    ];
    const { roles, miss, missed } = assignWithWishes(people, ROLES, seeded(5));
    expect(roles.size).toBe(3);
    expect(countOf(roles, 'oni')).toBe(1);
    // a は希望なしなので、鬼の枠は a が埋める。b・c は逃走者で通る
    expect(roles.get('a')).toBe('oni');
    expect(missed).toEqual([]);
    expect(miss.get('a')).toBe(0);
  });

  it('1人だけのとき（鬼の枠0）は、鬼を希望しても逃走者', () => {
    const { roles, missed } = assignWithWishes([{ pid: 'a', wish: 'oni', miss: 0 }], ROLES, seeded(1));
    expect(roles.get('a')).toBe('runner');
    expect(missed).toEqual(['a']);
  });

  it('本番の乱数（crypto）でも動く', () => {
    const people = crowd(Array.from({ length: 300 }, (_, i) => (i % 2 ? 'runner' : 'oni') as RoleId));
    const { roles, missed } = assignWithWishes(people, ROLES);
    expect(countOf(roles, 'oni')).toBe(90);
    // 鬼希望150人のうち90人が通り、60人が逃走者へ。逃走者希望150人は全員通る
    expect(missed).toHaveLength(60);
    for (const pid of missed) expect(roles.get(pid)).toBe('runner');
  });
});
