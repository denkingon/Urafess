/**
 * 夜の予定（本部で、試合の前から夜全体を組む）。
 *
 * 開始の時刻（例 21:20）から、ブロック（話・プレ・本番・ハーフタイムショー・休み・終わり）を順に並べる。
 * 横軸は時計の時刻で、ブロックの幅は長さ（分）の比どおり。いちばん右に終わりの時刻が出る。
 * 本番・プレのブロックには、デッキの時間（配役から結果まで）が実際の比で入る。
 *
 * 予定はサーバーに置く（どの本部の画面でも同じものが見える）。サーバーは中身を確かめて、そのまま覚えるだけ。
 */

export type NightKind = 'talk' | 'pre' | 'game' | 'show' | 'break' | 'end';

/** 種類の名前と、新しく足したときの長さ（分） */
export const NIGHT_KINDS: { kind: NightKind; name: string; mins: number; round: boolean }[] = [
  { kind: 'talk', name: '話', mins: 10, round: false },
  { kind: 'pre', name: 'プレ', mins: 10, round: true },
  { kind: 'game', name: '本番', mins: 15, round: true },
  { kind: 'show', name: 'ショー', mins: 10, round: false },
  { kind: 'break', name: '休み', mins: 5, round: false },
  { kind: 'end', name: '終わり', mins: 10, round: false },
];

export interface NightBlock {
  id: string;
  kind: NightKind;
  /** 見出し（空なら種類の名前） */
  title: string;
  /** 長さ（分） */
  mins: number;
}

export interface NightPlan {
  /** 開始の時刻（0時からの分。0〜1439） */
  start: number;
  /** 終わっていたい時刻（0時からの分）。null＝決めていない */
  endBy: number | null;
  blocks: NightBlock[];
}

export const NIGHT_MAX_BLOCKS = 24;
export const NIGHT_TITLE_MAX = 24;
export const NIGHT_MINS_MIN = 1;
export const NIGHT_MINS_MAX = 180;
const DAY = 24 * 60;

/** 最初の予定（本人の例：プレ・本番・ハーフタイムショー・本番2・終わり） */
export function defaultNightPlan(): NightPlan {
  return {
    start: 21 * 60 + 20,
    endBy: 22 * 60 + 30,
    blocks: [
      { id: 'b1', kind: 'talk', title: '集合・ルール説明', mins: 10 },
      { id: 'b2', kind: 'pre', title: 'プレ', mins: 10 },
      { id: 'b3', kind: 'game', title: '本番', mins: 15 },
      { id: 'b4', kind: 'show', title: 'ハーフタイムショー', mins: 10 },
      { id: 'b5', kind: 'game', title: '本番2', mins: 15 },
      { id: 'b6', kind: 'end', title: '終わり・結果発表', mins: 10 },
    ],
  };
}

export function kindInfo(kind: NightKind) {
  return NIGHT_KINDS.find((k) => k.kind === kind) ?? NIGHT_KINDS[0];
}

const isKind = (v: unknown): v is NightKind => typeof v === 'string' && NIGHT_KINDS.some((k) => k.kind === v);
const isMinute = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < DAY;

/** サーバーが受け取る前に確かめる（おかしければ null） */
export function cleanNightPlan(v: unknown): NightPlan | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isMinute(o.start)) return null;
  if (!(o.endBy === null || isMinute(o.endBy))) return null;
  if (!Array.isArray(o.blocks) || o.blocks.length > NIGHT_MAX_BLOCKS) return null;
  const blocks: NightBlock[] = [];
  const ids = new Set<string>();
  for (const b of o.blocks) {
    if (!b || typeof b !== 'object') return null;
    const x = b as Record<string, unknown>;
    if (typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(x.id) || ids.has(x.id)) return null;
    if (!isKind(x.kind)) return null;
    if (typeof x.title !== 'string') return null;
    if (!Number.isInteger(x.mins) || (x.mins as number) < NIGHT_MINS_MIN || (x.mins as number) > NIGHT_MINS_MAX) return null;
    ids.add(x.id);
    blocks.push({ id: x.id, kind: x.kind, title: x.title.trim().slice(0, NIGHT_TITLE_MAX), mins: x.mins as number });
  }
  return { start: o.start as number, endBy: o.endBy as number | null, blocks };
}

export interface PlacedBlock extends NightBlock {
  /** 開始・終わり（開始の時刻からの分。日をまたいでも増え続ける） */
  from: number;
  to: number;
}

/** 並べる：それぞれのブロックの始まりと終わり（0時からの分。日をまたぐと 1440 を超える） */
export function placeNight(plan: NightPlan): { blocks: PlacedBlock[]; end: number } {
  let t = plan.start;
  const blocks = plan.blocks.map((b) => {
    const p = { ...b, from: t, to: t + b.mins };
    t = p.to;
    return p;
  });
  return { blocks, end: t };
}

/** 0時からの分 → 「21:20」（日をまたいだら 24:10 ではなく 0:10） */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % DAY) + DAY) % DAY;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 「21:20」 → 0時からの分（読めなければ null） */
export function parseHhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v < DAY ? v : null;
}

/** 分 → 「1時間10分」「45分」 */
export function spanText(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}時間${m}分` : `${h}時間`) : `${m}分`;
}

export interface NightIssue {
  /** どのブロックの話か（夜全体なら null） */
  id: string | null;
  text: string;
}

/**
 * 不備を見つける。roundMs＝デッキの時間の合計（配役から結果発表まで。ラウンドの中身）
 * - 終わっていたい時刻を過ぎる
 * - プレ・本番のブロックに、デッキの時間が収まらない
 * - 本番が1つもない／「終わり」が最後でない
 */
export function nightIssues(plan: NightPlan, roundMs: number): NightIssue[] {
  const out: NightIssue[] = [];
  const { blocks, end } = placeNight(plan);
  if (!blocks.length) return [{ id: null, text: 'ブロックが無い' }];
  if (plan.endBy !== null) {
    // 終わっていたい時刻は、開始より前なら次の日とみなす
    const endBy = plan.endBy <= plan.start ? plan.endBy + DAY : plan.endBy;
    if (end > endBy) out.push({ id: null, text: `終わりが ${hhmm(plan.endBy)} を ${spanText(end - endBy)} 過ぎる（${hhmm(end)}）` });
  }
  const roundMin = roundMs / 60_000;
  for (const b of blocks) {
    if (kindInfo(b.kind).round && b.mins < roundMin) {
      out.push({ id: b.id, text: `「${b.title || kindInfo(b.kind).name}」${b.mins}分にデッキの時間（${clockText(roundMs)}）が収まらない` });
    }
  }
  if (!blocks.some((b) => b.kind === 'game')) out.push({ id: null, text: '本番のブロックが無い' });
  const endIdx = blocks.findIndex((b) => b.kind === 'end');
  if (endIdx >= 0 && endIdx !== blocks.length - 1) out.push({ id: blocks[endIdx].id, text: '「終わり」のあとにまだブロックがある' });
  return out;
}

function clockText(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 新しいブロックの印（いまある印と重ならない） */
export function newBlockId(plan: NightPlan): string {
  let n = plan.blocks.length + 1;
  const ids = new Set(plan.blocks.map((b) => b.id));
  while (ids.has(`b${n}`)) n++;
  return `b${n}`;
}
