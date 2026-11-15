// 主催者が配役を決めるときに見る、1人ずつの数字と印。
// 数字は記録（events）から出す。印は主催者が付ける（男・女・速い…）。どちらも主催者の画面にしか出さない。

import { PHASES, START_LEAD_MS } from './rules';

/** 印の長さ（文字）と、1人に付けられる数 */
export const TAG_MAX_LEN = 6;
export const TAGS_MAX = 5;
/** はじめから出しておく印 */
export const DEFAULT_TAGS: readonly string[] = ['男', '女'];

/** 速さに数える走り：これより短い・近い走りは数えない（位置の誤差の方が大きい） */
export const SPEED_MIN_MS = 3_000;
export const SPEED_MIN_M = 10;
/** これより速い走りは位置の飛びとみなして捨てる（秒速。100m 11秒 ≒ 9） */
export const SPEED_MAX_MPS = 9;

const GAME_INDEX = PHASES.findIndex((p) => p.id === 'game');

/** 印をきれいにする。使えないものは null */
export function cleanTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!t || [...t].length > TAG_MAX_LEN) return null;
  return t;
}

/** 数えるのに使う記録の1行（events の一部）。run-end の data は { ms, m } だけでよい */
export type CastEvent = {
  at: number;
  assign_id: number;
  kind: string;
  pid: string | null;
  other_pid: string | null;
  elapsed: number | null;
  data: string | null;
};

export interface CastStat {
  /** 逃走者だった（始まった）ラウンドの数 */
  runs: number;
  /** そのうち捕まったラウンドの数 */
  caught: number;
  /** 追跡開始から最初に捕まるまでの平均（ミリ秒）。逃げ切ったラウンドは、ゲームの長さで数える。逃走者をやっていなければ null */
  holdMs: number | null;
  /** 鬼だった（始まった）ラウンドの数 */
  oni: number;
  /** 鬼で捕まえた数 */
  catches: number;
  /** 走った速さ（秒速 m）。「走ると光る」の記録が無ければ null */
  speed: number | null;
}

const empty = (): CastStat => ({ runs: 0, caught: 0, holdMs: null, oni: 0, catches: 0, speed: null });

function parse(data: string | null): Record<string, unknown> {
  if (!data) return {};
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 全員の数字を1回でまとめる。events は id の順（古い順）。
 * ラウンドの見分け方は account.ts と同じ（新しい夜の数＋配役の番号。やり直したラウンドは数えない）。
 * 「次に進む」で段階を飛ばしても、経過時間（elapsed）は飛ばした分だけ進むので、
 * ゲームの段階の始まりはいつも「逃走開始まで＋追跡開始まで」の長さになる
 */
export function castStatsAll(events: readonly CastEvent[]): Map<string, CastStat> {
  type Round = {
    started: boolean;
    /** ゲームの段階の始まり・長さ（経過時間） */
    gameFrom: number;
    gameLen: number;
    roles: Map<string, string>;
    /** 逃走者ごとの、捕まった経過時間（取り消しは最後の1つを外す） */
    caught: Map<string, { at: number | null; oni: string | null }[]>;
  };
  const rounds = new Map<string, Round>();
  const roundOf = (key: string): Round => {
    let r = rounds.get(key);
    if (!r) {
      r = { started: false, gameFrom: 0, gameLen: 0, roles: new Map(), caught: new Map() };
      rounds.set(key, r);
    }
    return r;
  };
  const runM = new Map<string, number>();
  const runMs = new Map<string, number>();
  let epoch = 0;
  for (const e of events) {
    if (e.kind === 'clear') {
      epoch += 1;
      continue;
    }
    if (e.kind === 'run-end') {
      if (!e.pid) continue;
      const d = parse(e.data);
      const ms = Number(d.ms);
      const m = Number(d.m);
      if (!(ms >= SPEED_MIN_MS) || !(m >= SPEED_MIN_M) || m / (ms / 1000) > SPEED_MAX_MPS) continue;
      runM.set(e.pid, (runM.get(e.pid) ?? 0) + m);
      runMs.set(e.pid, (runMs.get(e.pid) ?? 0) + ms);
      continue;
    }
    const r = roundOf(`${epoch}:${e.assign_id}`);
    switch (e.kind) {
      case 'start': {
        const d = parse(e.data).durations;
        const dur = Array.isArray(d) ? d.map(Number) : [];
        r.started = true;
        r.gameFrom = dur.slice(0, GAME_INDEX).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
        r.gameLen = Number.isFinite(dur[GAME_INDEX]) ? dur[GAME_INDEX] : 0;
        break;
      }
      case 'reset':
        r.started = false;
        r.caught.clear();
        break;
      case 'skip':
        // ゲームの段階を途中で終わらせた：そこまでがゲームの長さ
        if (parse(e.data).from === GAME_INDEX && e.elapsed !== null) {
          r.gameLen = Math.max(0, Math.min(r.gameLen, e.elapsed - r.gameFrom + START_LEAD_MS));
        }
        break;
      case 'role':
      case 'recast': {
        const role = parse(e.data).role;
        if (e.pid && typeof role === 'string') r.roles.set(e.pid, role);
        break;
      }
      case 'capture': {
        if (!e.other_pid) break;
        const list = r.caught.get(e.other_pid) ?? [];
        list.push({ at: e.elapsed, oni: e.pid });
        r.caught.set(e.other_pid, list);
        break;
      }
      case 'release':
        if (e.other_pid) r.caught.get(e.other_pid)?.pop();
        break;
    }
  }

  const out = new Map<string, CastStat>();
  const statOf = (pid: string): CastStat => {
    let s = out.get(pid);
    if (!s) {
      s = empty();
      out.set(pid, s);
    }
    return s;
  };
  const holdSum = new Map<string, number>();
  for (const r of rounds.values()) {
    if (!r.started) continue;
    for (const [pid, role] of r.roles) {
      const s = statOf(pid);
      if (role === 'oni') {
        s.oni += 1;
        continue;
      }
      if (role !== 'runner') continue;
      s.runs += 1;
      const first = r.caught.get(pid)?.[0];
      if (first) s.caught += 1;
      // 経過時間の無い捕獲（時間が0になったあとに手で入れたもの）は、ゲームの長さで数える
      const hold = first && first.at !== null ? Math.max(0, Math.min(r.gameLen, first.at - r.gameFrom)) : r.gameLen;
      holdSum.set(pid, (holdSum.get(pid) ?? 0) + hold);
    }
    for (const list of r.caught.values()) {
      for (const c of list) if (c.oni) statOf(c.oni).catches += 1;
    }
  }
  for (const [pid, sum] of holdSum) {
    const s = statOf(pid);
    if (s.runs > 0) s.holdMs = Math.round(sum / s.runs);
  }
  for (const [pid, m] of runM) {
    const ms = runMs.get(pid) ?? 0;
    if (ms > 0) statOf(pid).speed = Math.round((m / (ms / 1000)) * 10) / 10;
  }
  return out;
}

/** 主催者の板の並べ方 */
export type CastSort = 'num' | 'hold' | 'speed' | 'tag' | 'wish';

export const CAST_SORTS: readonly { id: CastSort; label: string }[] = [
  { id: 'num', label: '入った順' },
  { id: 'hold', label: '捕まるまで' },
  { id: 'speed', label: '速さ' },
  { id: 'tag', label: '印' },
  { id: 'wish', label: '希望' },
];

type Sortable = { num: number; wish: string | null; tags?: string[]; stat?: CastStat };

/**
 * 並べる。数字の無い人は下。
 * 捕まるまで＝長く逃げる人が上。速さ＝速い人が上。印＝同じ印の人をまとめる。希望＝鬼・逃走者・どちらでも
 */
export function sortCast<T extends Sortable>(list: readonly T[], by: CastSort): T[] {
  const num = (a: T, b: T) => a.num - b.num;
  const desc = (f: (x: T) => number | null | undefined) => (a: T, b: T) => {
    const x = f(a) ?? null;
    const y = f(b) ?? null;
    if (x === null || y === null) return x === y ? num(a, b) : x === null ? 1 : -1;
    return y - x || num(a, b);
  };
  const copy = [...list];
  switch (by) {
    case 'hold':
      return copy.sort(desc((x) => x.stat?.holdMs));
    case 'speed':
      return copy.sort(desc((x) => x.stat?.speed));
    case 'tag': {
      const key = (x: T) => (x.tags?.length ? [...x.tags].sort().join('\u0001') : '￿');
      return copy.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : num(a, b)));
    }
    case 'wish': {
      const rank = (x: T) => (x.wish === 'oni' ? 0 : x.wish === 'runner' ? 1 : 2);
      return copy.sort((a, b) => rank(a) - rank(b) || num(a, b));
    }
    default:
      return copy.sort(num);
  }
}

/** 1人の数字を1行に（無ければ空） */
export function castStatText(s: CastStat | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.runs > 0 && s.holdMs !== null) {
    const sec = Math.round(s.holdMs / 1000);
    parts.push(`捕まるまで ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}（${s.runs}回中${s.caught}回捕まった）`);
  }
  if (s.speed !== null) parts.push(`秒速 ${s.speed.toFixed(1)}m`);
  if (s.oni > 0) parts.push(`鬼${s.oni}回で${s.catches}人捕まえた`);
  return parts.join('・');
}
