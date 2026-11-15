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

/**
 * 希望つきの配役に渡す1人。wish＝なりたい役（null はどちらでも）、miss＝続けて希望が通らなかった回数、
 * pin＝主催者の指名（この人はこの役、と決めた。希望やくじより強い。無ければ null）
 */
export interface WishEntry {
  pid: string;
  wish: RoleId | null;
  miss: number;
  pin?: RoleId | null;
}

export interface WishResult {
  roles: Map<string, RoleId>;
  /** 希望を出して、通らなかった人（もう一方の役になった。主催者の指名で希望とちがう役になった人も入る） */
  missed: string[];
  /** 配役のあとの「続けて外れた回数」（通ったら 0、外れたら 1 増える、希望なしはそのまま） */
  miss: Map<string, number>;
  /** 役ごとの人数（roles の並び）。指名が枠より多ければ、割合の人数からずれる */
  counts: number[];
}

/**
 * 主催者の指名を入れた、役ごとの人数。割合の人数（allocateCounts）から始めて、指名が枠より多い役は指名の人数まで増やし、
 * 増やした分は、指名に余裕のある役から減らす。pinned は役ごとの指名の人数（roles の並び）。
 * 2人以上いるのに、指名のせいでどれかの役が最低人数を割るなら null（その指名では配役できない）
 */
export function castCounts(n: number, roles: readonly RoleRule[], pinned: readonly number[]): number[] | null {
  const counts = allocateCounts(n, roles);
  if (pinned.reduce((a, b) => a + b, 0) > n) return null;
  roles.forEach((_, i) => {
    if ((pinned[i] ?? 0) > counts[i]) counts[i] = pinned[i];
  });
  for (let over = counts.reduce((a, b) => a + b, 0) - n; over > 0; over--) {
    // 余裕（人数 − 指名）がいちばん大きい役から1人減らす。並んだら、端数をもらいにくい役（tiePriority が大きい方）から
    let j = -1;
    for (let k = 0; k < roles.length; k++) {
      const slack = counts[k] - (pinned[k] ?? 0);
      if (slack <= 0) continue;
      const best = j === -1 ? -1 : counts[j] - (pinned[j] ?? 0);
      if (slack > best || (slack === best && roles[k].tiePriority > roles[j].tiePriority)) j = k;
    }
    if (j === -1) return null;
    counts[j] -= 1;
  }
  if (n >= roles.length && roles.some((r, i) => counts[i] < r.min)) return null;
  return counts;
}

/**
 * 希望を聞いて役を割り当てる。人数は比率のまま（allocateCounts）。主催者の指名があれば、その分だけずれる（castCounts）。
 * 1. 全員を並べ替える（くじ）
 * 2. 主催者が指名した人を、その役に入れる（希望やくじより先）
 * 3. 役ごとに、その役を希望した人を「続けて外れた回数が多い順（同じならくじの順）」に並べ、残りの枠の人数だけ通す
 * 4. 残った枠を、希望なしの人 → 外れた人 の順で埋める（外れた人の希望の役はもう満員なので、必ず別の役になる）
 * おかしな値（知らない役・負の回数）は「希望なし・指名なし・0回」として扱う。
 * 指名のせいで役が最低人数を割るとき（castCounts が null）は投げる。呼ぶ前に castCounts で確かめること。
 */
export function assignWithWishes(
  people: readonly WishEntry[],
  roles: readonly RoleRule[],
  randomInt: (max: number) => number = cryptoRandomInt,
): WishResult {
  const known = new Set(roles.map((r) => r.id));
  const shuffled: Required<WishEntry>[] = people.map((p) => ({
    pid: p.pid,
    wish: p.wish !== null && known.has(p.wish) ? p.wish : null,
    miss: Number.isInteger(p.miss) && p.miss > 0 ? Math.min(p.miss, WISH_MISS_MAX) : 0,
    pin: p.pin != null && known.has(p.pin) ? p.pin : null,
  }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const pinned = roles.map((r) => shuffled.filter((p) => p.pin === r.id).length);
  const counts = castCounts(shuffled.length, roles, pinned);
  if (!counts) throw new Error('cast: a role would fall below its minimum');
  const result = new Map<string, RoleId>();
  // 指名が先。残りの枠（open）を、指名されていない人で分ける
  for (const p of shuffled) if (p.pin !== null) result.set(p.pid, p.pin);
  const open = counts.map((c, i) => c - pinned[i]);
  const left = [...open];
  const free = shuffled.filter((p) => p.pin === null);
  const overflow: Required<WishEntry>[] = [];
  roles.forEach((role, i) => {
    // sort は安定なので、同じ回数どうしはくじの順のまま
    const wishers = free.filter((p) => p.wish === role.id).sort((a, b) => b.miss - a.miss);
    wishers.forEach((p, k) => {
      if (k < open[i]) {
        result.set(p.pid, role.id);
        left[i] -= 1;
      } else {
        overflow.push(p);
      }
    });
  });
  const rest = [...free.filter((p) => p.wish === null), ...overflow];
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
  return { roles: result, missed, miss, counts };
}
