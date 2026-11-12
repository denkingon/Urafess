/**
 * 自分のページ（ステータスと設定）。サーバーの記録（events）から本人の数字を数える部分と、
 * スマホとサーバーがやりとりする形。数え方はここだけに置く（サーバーとテストが同じものを使う）。
 */

/** 引き継ぎの合言葉の長さ（数字） */
export const HANDOFF_DIGITS = 6;
/** 合言葉が効く長さ */
export const HANDOFF_TTL_MS = 10 * 60_000;
/** 合言葉の打ち間違いをこれだけ数えたら、しばらく受け付けない（部屋全体で。当てずっぽうを防ぐ） */
export const HANDOFF_MAX_FAILS = 20;
export const HANDOFF_FAIL_WINDOW_MS = 10 * 60_000;
/** 名簿から消えた人の、記録に残す名前 */
export const GONE_NAME = '消えた人';

/** 夜の区切り：日本時間の朝6時。夜中の1時に遊んでいても前の日の夜に数える */
const JST_MS = 9 * 3600_000;
const NIGHT_CUT_MS = 6 * 3600_000;

export function nightKeyOf(at: number): string {
  const d = new Date(at + JST_MS - NIGHT_CUT_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** 2026-11-06 → 11/6 */
export function nightLabelOf(key: string): string {
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 数えるのに使う記録の1行（events の一部） */
export type AccountEvent = {
  at: number;
  assign_id: number;
  kind: string;
  pid: string | null;
  other_pid: string | null;
  data: string | null;
};

export interface AccountNight {
  /** 2026-11-06 */
  key: string;
  /** 11/6 */
  label: string;
  /** この夜にいたか */
  here: boolean;
}

export interface AccountStats {
  /** 部屋で遊んだ夜（ラウンドが始まった夜）と、本人が来た夜を合わせて古い順 */
  nights: AccountNight[];
  /** 本人が来た夜の数 */
  nightsHere: number;
  /** 始まったラウンドで、その役だった回数 */
  roles: { oni: number; runner: number };
  /** 捕まえた（取り消されたものは数えない） */
  caught: number;
  /** 捕まった（取り消されたものは数えない） */
  gotCaught: number;
  /** 牢屋から助けた */
  freed: number;
}

/** 本人の記録を数える。events は id の順（古い順）に並んでいること */
export function summarizeAccount(events: readonly AccountEvent[], pid: string): AccountStats {
  const started = new Set<number>();
  const roomNights = new Set<string>();
  const myNights = new Set<string>();
  for (const e of events) {
    if (e.kind === 'start') {
      started.add(e.assign_id);
      roomNights.add(nightKeyOf(e.at));
    }
  }

  // 役：始まった配役ごとに、最後に配られた役（配り直しは別の配役になる）
  const roleOf = new Map<number, string>();
  // 捕獲：配役と逃走者ごとに、捕まえた鬼を積む。取り消しは最後の1つを外す（助けられて、また捕まることもある）
  const captures = new Map<string, { oni: string | null; runner: string }[]>();
  let freed = 0;
  for (const e of events) {
    if (e.pid === pid && (e.kind === 'join' || e.kind === 'enter')) myNights.add(nightKeyOf(e.at));
    if (e.kind === 'role' && e.pid === pid) {
      const role = parseRole(e.data);
      if (role) roleOf.set(e.assign_id, role);
      if (started.has(e.assign_id)) myNights.add(nightKeyOf(e.at));
    } else if (e.kind === 'capture' && e.other_pid) {
      const k = `${e.assign_id}:${e.other_pid}`;
      const list = captures.get(k) ?? [];
      list.push({ oni: e.pid, runner: e.other_pid });
      captures.set(k, list);
    } else if (e.kind === 'release' && e.other_pid) {
      captures.get(`${e.assign_id}:${e.other_pid}`)?.pop();
    } else if (e.kind === 'rescue' && e.pid === pid) {
      freed += 1;
    }
  }

  const roles = { oni: 0, runner: 0 };
  for (const [assignId, role] of roleOf) {
    if (!started.has(assignId)) continue;
    if (role === 'oni') roles.oni += 1;
    else if (role === 'runner') roles.runner += 1;
  }
  let caught = 0;
  let gotCaught = 0;
  for (const list of captures.values()) {
    for (const c of list) {
      if (c.oni === pid) caught += 1;
      if (c.runner === pid) gotCaught += 1;
    }
  }

  const keys = [...new Set([...roomNights, ...myNights])].sort();
  return {
    nights: keys.map((key) => ({ key, label: nightLabelOf(key), here: myNights.has(key) })),
    nightsHere: myNights.size,
    roles,
    caught,
    gotCaught,
    freed,
  };
}

function parseRole(data: string | null): string | null {
  if (!data) return null;
  try {
    const role = (JSON.parse(data) as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** GET /api/game/<id>/me の答え */
export interface AccountView {
  name: string;
  /** 名簿に入った時刻 */
  since: number;
  stats: AccountStats;
  /** 試合中で今夜に入っているので、名前を変える・名簿から消えるができない */
  busy: boolean;
}

/** POST /api/game/<id>/me の頼み */
export type AccountOp =
  | { op: 'rename'; name: string }
  | { op: 'handoff' }
  | { op: 'leave' }
  | { op: 'take'; code: string };

/** 断られた理由 */
export type AccountError =
  | 'unknown' // 合い鍵が合わない（名簿にいない・ほかのスマホへ移した）
  | 'invalid' // 名前が使えない（1〜20文字）
  | 'taken' // 名簿のほかの人の名前
  | 'busy' // 試合中
  | 'bad-code' // 合言葉が違う・切れた
  | 'locked' // 合言葉の打ち間違いが多すぎる
  | 'bad-input';

export function isHandoffCode(code: unknown): code is string {
  return typeof code === 'string' && new RegExp(`^\\d{${HANDOFF_DIGITS}}$`).test(code);
}
