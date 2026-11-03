import type { RoleId, RoleRule } from './rules';

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
