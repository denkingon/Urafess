import { WISH_MISS_MAX, type RoleId, type RoleRule } from './rules';

/**
 * 人数 n を比率どおりに役へ分ける（最大剰余法）。
 * 小数は使わず整数で計算する。35人なら 35×3÷10＝10余り5 で、余り5＝ちょうど半分を確実に見分けられる。
 * ちょうど半分のときは tiePriority の小さい役が端数をもらう。
 */
export function allocateCounts(n: number, roles: readonly RoleRule[]): number[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad n: ${n}`);
  const totalWeight = roles.reduce((s, r) => s + r.weight, 0);
  const counts = roles.map((r) => Math.floor((n * r.weight) / totalWeight));
  const remainders = roles.map((r) => (n * r.weight) % totalWeight);
  let left = n - counts.reduce((a, b) => a + b, 0);
  const order = roles
    .map((_, i) => i)
    .sort((i, j) => remainders[j] - remainders[i] || roles[i].tiePriority - roles[j].tiePriority);
  for (const i of order) {
    if (left === 0) break;
    counts[i] += 1;
    left -= 1;
  }
  // 2人以上（役の数以上）なら、どの役も最低人数を満たす。足りない分は一番多い役から回す
  if (n >= roles.length) {
    for (let i = 0; i < roles.length; i++) {
      while (counts[i] < roles[i].min) {
        let donor = 0;
        for (let j = 1; j < counts.length; j++) if (counts[j] > counts[donor]) donor = j;
        if (donor === i || counts[donor] <= roles[donor].min) break;
        counts[donor] -= 1;
        counts[i] += 1;
      }
    }
  }
  return counts;
}

/** 0 以上 max 未満の偏りのない整数。crypto.getRandomValues を使い、余りの偏りは棄却で消す */
export function cryptoRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new Error(`bad max: ${max}`);
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * 参加者に役を割り当てる。並べ替え（Fisher–Yates）てから、先頭から比率の人数ずつ役を当てる。
 * randomInt は 0 以上 max 未満の整数を返す関数（本番は cryptoRandomInt、テストは種つき乱数）。
 */
export function assignRoles(
  pids: readonly string[],
  roles: readonly RoleRule[],
  randomInt: (max: number) => number = cryptoRandomInt,
): Map<string, RoleId> {
  const shuffled = [...pids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const counts = allocateCounts(shuffled.length, roles);
  const result = new Map<string, RoleId>();
  let k = 0;
  roles.forEach((role, i) => {
    for (let c = 0; c < counts[i]; c++) result.set(shuffled[k++], role.id);
  });
  return result;
}

/** 希望つきの配役に渡す1人。wish＝なりたい役（null はどちらでも）、miss＝続けて希望が通らなかった回数 */
export interface WishEntry {
  pid: string;
  wish: RoleId | null;
  miss: number;
}

export interface WishResult {
  roles: Map<string, RoleId>;
  /** 希望を出して、通らなかった人（もう一方の役になった） */
  missed: string[];
  /** 配役のあとの「続けて外れた回数」（通ったら 0、外れたら 1 増える、希望なしはそのまま） */
  miss: Map<string, number>;
}

/**
 * 希望を聞いて役を割り当てる。人数は比率のまま（allocateCounts）変えない。
 * 1. 全員を並べ替える（くじ）
 * 2. 役ごとに、その役を希望した人を「続けて外れた回数が多い順（同じならくじの順）」に並べ、枠の人数だけ通す
 * 3. 残った枠を、希望なしの人 → 外れた人 の順で埋める（外れた人の希望の役はもう満員なので、必ず別の役になる）
 * おかしな値（知らない役・負の回数）は「希望なし・0回」として扱う。
 */
export function assignWithWishes(
  people: readonly WishEntry[],
  roles: readonly RoleRule[],
  randomInt: (max: number) => number = cryptoRandomInt,
): WishResult {
  const known = new Set(roles.map((r) => r.id));
  const shuffled: WishEntry[] = people.map((p) => ({
    pid: p.pid,
    wish: p.wish !== null && known.has(p.wish) ? p.wish : null,
    miss: Number.isInteger(p.miss) && p.miss > 0 ? Math.min(p.miss, WISH_MISS_MAX) : 0,
  }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const counts = allocateCounts(shuffled.length, roles);
  const result = new Map<string, RoleId>();
  const left = [...counts];
  const overflow: WishEntry[] = [];
  roles.forEach((role, i) => {
    // sort は安定なので、同じ回数どうしはくじの順のまま
    const wishers = shuffled.filter((p) => p.wish === role.id).sort((a, b) => b.miss - a.miss);
    wishers.forEach((p, k) => {
      if (k < counts[i]) {
        result.set(p.pid, role.id);
        left[i] -= 1;
      } else {
        overflow.push(p);
      }
    });
  });
  const rest = [...shuffled.filter((p) => p.wish === null), ...overflow];
  let k = 0;
  roles.forEach((role, i) => {
    for (; left[i] > 0; left[i] -= 1) result.set(rest[k++].pid, role.id);
  });
  const missed: string[] = [];
  const miss = new Map<string, number>();
  for (const p of shuffled) {
    if (p.wish === null) {
      miss.set(p.pid, p.miss);
    } else if (result.get(p.pid) === p.wish) {
      miss.set(p.pid, 0);
    } else {
      miss.set(p.pid, Math.min(WISH_MISS_MAX, p.miss + 1));
      missed.push(p.pid);
    }
  }
  return { roles: result, missed, miss };
}
