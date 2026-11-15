/**
 * 自分のページ（ステータスと設定）。サーバーの記録（events）から本人の数字を数える部分と、
 * スマホとサーバーがやりとりする形。数え方はここだけに置く（サーバーとテストが同じものを使う）。
 */

/** 引き継ぎの合言葉の長さ（数字） */
export const HANDOFF_DIGITS = 6;
/** 合言葉が効く長さ */
export const HANDOFF_TTL_MS = 10 * 60_000;
/**
 * 合言葉の打ち間違いをこれだけ数えたら、しばらく受け付けない（当てずっぽうを防ぐ）。
 * 同じ回線から（HANDOFF_MAX_FAILS）と、部屋全体で（HANDOFF_MAX_FAILS_ROOM）。
 * 部屋全体の上限を高くしておくのは、いたずらで全員の引き継ぎを止められないようにするため
 * （それでも当たる見込みは、生きている合言葉の数 × 回数 ÷ 100万で、ほぼない）
 */
export const HANDOFF_MAX_FAILS = 20;
export const HANDOFF_MAX_FAILS_ROOM = 200;
export const HANDOFF_FAIL_WINDOW_MS = 10 * 60_000;
/**
 * 使った合言葉をもう一度打たれたら、この間だけは同じ合い鍵を返す
 * （電波が弱くて答えが届かず、新しいスマホが打ち直したときに締め出さないように）
 */
export const HANDOFF_REPLAY_MS = 2 * 60_000;
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

/**
 * 本人の記録を数える。events は id の順（古い順）に並んでいること。
 * 配役の番号（assign_id）は、新しい夜（clear）で0から数え直し、やり直し（reset）では同じ番号のまま続くので、
 * 「何回目の夜か（clear の数）＋配役の番号」で1つのラウンドとみなす。
 * やり直したラウンドの捕獲・助けた記録は消える（サーバーの数え方と同じ）。やり直したあと始めなければ、役も数えない
 */
export function summarizeAccount(events: readonly AccountEvent[], pid: string): AccountStats {
  const roomNights = new Set<string>();
  const myNights = new Set<string>();
  // 始まっている（やり直されていない）ラウンド
  const started = new Set<string>();
  // 役：ラウンドごとに、最後に配られた役と、その時刻（配り直しは別のラウンドになる）
  const roleOf = new Map<string, { role: string; at: number }>();
  // 捕獲：ラウンドと逃走者ごとに、捕まえた鬼を積む。取り消しは最後の1つを外す（助けられて、また捕まることもある）
  const captures = new Map<string, Map<string, (string | null)[]>>();
  // 助けた：ラウンドごとの回数
  const rescues = new Map<string, number>();
  let epoch = 0;
  for (const e of events) {
    if (e.kind === 'clear') {
      epoch += 1;
      continue;
    }
    const round = `${epoch}:${e.assign_id}`;
    switch (e.kind) {
      case 'start':
        started.add(round);
        roomNights.add(nightKeyOf(e.at));
        break;
      case 'reset':
        started.delete(round);
        captures.delete(round);
        rescues.delete(round);
        break;
      case 'join':
      case 'enter':
        if (e.pid === pid) myNights.add(nightKeyOf(e.at));
        break;
      case 'role':
      case 'recast': {
        const role = e.pid === pid ? parseRole(e.data) : null;
        if (role) roleOf.set(round, { role, at: e.at });
        break;
      }
      case 'capture': {
        if (!e.other_pid) break;
        const byRunner = captures.get(round) ?? new Map<string, (string | null)[]>();
        const list = byRunner.get(e.other_pid) ?? [];
        list.push(e.pid);
        byRunner.set(e.other_pid, list);
        captures.set(round, byRunner);
        break;
      }
      case 'release':
        if (e.other_pid) captures.get(round)?.get(e.other_pid)?.pop();
        break;
      case 'rescue':
        if (e.pid === pid) rescues.set(round, (rescues.get(round) ?? 0) + 1);
        break;
    }
  }

  const roles = { oni: 0, runner: 0 };
  for (const [round, r] of roleOf) {
    if (!started.has(round)) continue;
    myNights.add(nightKeyOf(r.at));
    if (r.role === 'oni') roles.oni += 1;
    else if (r.role === 'runner') roles.runner += 1;
  }
  let caught = 0;
  let gotCaught = 0;
  for (const byRunner of captures.values()) {
    for (const [runner, onis] of byRunner) {
      for (const oni of onis) {
        if (oni === pid) caught += 1;
        if (runner === pid) gotCaught += 1;
      }
    }
  }
  let freed = 0;
  for (const n of rescues.values()) freed += n;

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
  /** 名前の状態：ok／due＝主催者に付け直すよう言われた（試合中でも付け直せる）／shamed＝主催者が名前を変えた（本人は変えられない） */
  nameState?: NameState;
}

export type NameState = 'ok' | 'due' | 'shamed';

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
  | 'banned' // 名前に使えない言葉が入っている
  | 'name-locked' // 主催者が名前を変えたので、本人は変えられない
  | 'bad-input';

export function isHandoffCode(code: unknown): code is string {
  return typeof code === 'string' && new RegExp(`^\\d{${HANDOFF_DIGITS}}$`).test(code);
}
