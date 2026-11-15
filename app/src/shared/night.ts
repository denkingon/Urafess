/**
 * 夜の予定（本部で、試合の前から夜全体を組む）。
 *
 * 開始の時刻（例 21:20）から、ブロック（話・プレ・本番・ハーフタイムショー・休み・終わり）を順に並べる。
 * 横軸は時計の時刻で、ブロックの幅は長さ（分）の比どおり。いちばん右に終わりの時刻が出る。
 * 本番・プレのブロックは、中身を1つずつ決める：配役／逃走開始まで／追跡開始まで／ゲーム／広場に戻るまで／結果発表（秒）。
 * ブロックの長さは中身の合計で決まる。中身はデッキの時間（試合のタイマー）へそのまま入れられる。
 *
 * 予定はサーバーに置く（どの本部の画面でも同じものが見える）。サーバーは中身を確かめて、そのまま覚えるだけ。
 */

export type NightKind = 'talk' | 'pre' | 'game' | 'show' | 'break' | 'end';

/** 種類の名前と、新しく足したときの長さ（分） */
export const NIGHT_KINDS: { kind: NightKind; name: string; mins: number; round: boolean }[] = [
  { kind: 'talk', name: '話', mins: 10, round: false },
  { kind: 'pre', name: 'プレ', mins: 8, round: true },
  { kind: 'game', name: '本番', mins: 13, round: true },
  { kind: 'show', name: 'ショー', mins: 10, round: false },
  { kind: 'break', name: '休み', mins: 5, round: false },
  { kind: 'end', name: '終わり', mins: 10, round: false },
];

/** プレ・本番の中身（秒）。phases はデッキの時間と同じ並び（逃走開始まで・追跡開始まで・ゲーム・広場に戻るまで） */
export interface NightRound {
  /** 配役（役が出て、みんなが動き出すまで） */
  cast: number;
  phases: number[];
  /** 結果発表 */
  result: number;
}

export interface NightBlock {
  id: string;
  kind: NightKind;
  /** 見出し（空なら種類の名前） */
  title: string;
  /** 長さ（分）。プレ・本番では使わない（中身の合計が長さ） */
  mins: number;
  /** プレ・本番：使うプリセットの印（無ければ、プリセットなし） */
  preset?: string | null;
  /**
   * プレ・本番の中身（時間）。プリセットがあれば「このブロックだけ」の上書き。
   * プリセットも中身も無いブロックは「詳細なし」で、長さは mins
   */
  round?: NightRound;
}

/** プリセットのうち、夜の予定が知っていればいいもの（時間と名前） */
export interface PresetRef {
  id: string;
  name: string;
  round: NightRound;
}

/** 中身の段の名前（配役・デッキの4段・結果発表） */
export const ROUND_PARTS = ['配役', '逃走開始まで', '追跡開始まで', 'ゲーム', '広場に戻るまで', '結果発表'] as const;
/** 中身の ＋− の刻み（秒）。ROUND_PARTS と同じ並び */
export const ROUND_STEP = [15, 5, 10, 30, 30, 30];
export const ROUND_PART_MIN = 0;
export const ROUND_PART_MAX = 60 * 60;

export function defaultRound(kind: NightKind): NightRound {
  return kind === 'pre'
    ? { cast: 60, phases: [20, 40, 180, 60], result: 120 }
    : { cast: 60, phases: [20, 60, 300, 120], result: 180 };
}

/** ブロックで使う中身：上書き → プリセット → なし（詳細なし） */
export function blockRound(b: NightBlock, presets: readonly PresetRef[] = []): NightRound | null {
  if (!kindInfo(b.kind).round) return null;
  if (b.round) return b.round;
  if (b.preset) return presets.find((p) => p.id === b.preset)?.round ?? null;
  return null;
}

/** ブロックの長さ（秒） */
export function blockSecs(b: NightBlock, presets: readonly PresetRef[] = []): number {
  const r = blockRound(b, presets);
  if (r) return r.cast + r.phases.reduce((a, x) => a + x, 0) + r.result;
  return b.mins * 60;
}

/** 中身を1列に（配役・4段・結果発表） */
export function roundParts(r: NightRound): number[] {
  return [r.cast, ...r.phases, r.result];
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
      { id: 'b2', kind: 'pre', title: 'プレ', mins: 8, preset: 'p1' },
      { id: 'b3', kind: 'game', title: '本番', mins: 13, preset: 'p2' },
      { id: 'b4', kind: 'show', title: 'ハーフタイムショー', mins: 10 },
      { id: 'b5', kind: 'game', title: '本番2', mins: 13, preset: 'p2' },
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
    const blk: NightBlock = { id: x.id, kind: x.kind, title: x.title.trim().slice(0, NIGHT_TITLE_MAX), mins: x.mins as number };
    if (kindInfo(x.kind).round) {
      if (x.preset !== undefined && x.preset !== null) {
        if (typeof x.preset !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(x.preset)) return null;
        blk.preset = x.preset;
      }
      if (x.round !== undefined && x.round !== null) {
        const r = cleanRound(x.round);
        if (!r) return null;
        blk.round = r;
      }
    }
    blocks.push(blk);
  }
  return { start: o.start as number, endBy: o.endBy as number | null, blocks };
}

const isPart = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= ROUND_PART_MIN && (v as number) <= ROUND_PART_MAX;

function cleanRound(v: unknown): NightRound | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isPart(o.cast) || !isPart(o.result) || !Array.isArray(o.phases) || o.phases.length !== 4) return null;
  // デッキの時間は1秒より短くできない
  if (!o.phases.every((x) => isPart(x) && (x as number) >= 1)) return null;
  return { cast: o.cast, phases: [...(o.phases as number[])], result: o.result };
}

export interface PlacedBlock extends NightBlock {
  /** 始まり・終わり（0時からの分。秒の分は小数。日をまたいでも増え続ける） */
  from: number;
  to: number;
}

/** 並べる：それぞれのブロックの始まりと終わり（0時からの分。日をまたぐと 1440 を超える） */
export function placeNight(plan: NightPlan, presets: readonly PresetRef[] = []): { blocks: PlacedBlock[]; end: number } {
  let t = plan.start;
  const blocks = plan.blocks.map((b) => {
    const p = { ...b, from: t, to: t + blockSecs(b, presets) / 60 };
    t = p.to;
    return p;
  });
  return { blocks, end: t };
}

/** 0時からの分 → 「21:20」（日をまたいだら 24:10 ではなく 0:10） */
export function hhmm(min: number): string {
  const m = ((Math.floor(min + 1e-9) % DAY) + DAY) % DAY;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 「21:20」 → 0時からの分（読めなければ null） */
export function parseHhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v < DAY ? v : null;
}

/** 分 → 「1時間10分」「45分」（秒の分は切り上げ） */
export function spanText(mins: number): string {
  const all = Math.ceil(mins - 1e-9);
  const h = Math.floor(all / 60);
  const m = all % 60;
  return h ? (m ? `${h}時間${m}分` : `${h}時間`) : `${m}分`;
}

export interface NightIssue {
  /** どのブロックの話か（夜全体なら null） */
  id: string | null;
  text: string;
}

/**
 * 不備を見つける
 * - 終わっていたい時刻を過ぎる
 * - プレ・本番の配役と結果発表が0（集まる・話す時間が無い）／選んだプリセットが消えている
 * - 本番が1つもない／「終わり」が最後でない
 */
export function nightIssues(plan: NightPlan, presets: readonly PresetRef[] = []): NightIssue[] {
  const out: NightIssue[] = [];
  const { blocks, end } = placeNight(plan, presets);
  if (!blocks.length) return [{ id: null, text: 'ブロックが無い' }];
  if (plan.endBy !== null) {
    // 終わっていたい時刻は、開始より前なら次の日とみなす
    const endBy = plan.endBy <= plan.start ? plan.endBy + DAY : plan.endBy;
    if (end > endBy + 1e-9) out.push({ id: null, text: `終わりが ${hhmm(plan.endBy)} を ${spanText(end - endBy)} 過ぎる（${hhmm(end)}）` });
  }
  for (const b of blocks) {
    const name = b.title || kindInfo(b.kind).name;
    if (b.preset && !presets.some((p) => p.id === b.preset)) out.push({ id: b.id, text: `「${name}」のプリセットが消えている` });
    const r = blockRound(b, presets);
    if (r && r.cast + r.result === 0) out.push({ id: b.id, text: `「${name}」配役と結果発表の時間が0` });
  }
  if (!blocks.some((b) => b.kind === 'game')) out.push({ id: null, text: '本番のブロックが無い' });
  const endIdx = blocks.findIndex((b) => b.kind === 'end');
  if (endIdx >= 0 && endIdx !== blocks.length - 1) out.push({ id: blocks[endIdx].id, text: '「終わり」のあとにまだブロックがある' });
  return out;
}

/** 秒 → 「8:20」 */
export function clockText(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** プレ・本番の中身が、いまのデッキの時間（ms）と同じか */
export function sameAsDeck(r: NightRound | undefined, durationsMs: readonly number[]): boolean {
  return !!r && r.phases.length === durationsMs.length && r.phases.every((x, i) => x * 1000 === durationsMs[i]);
}

/** 新しいブロックの印（いまある印と重ならない） */
export function newBlockId(plan: NightPlan): string {
  let n = plan.blocks.length + 1;
  const ids = new Set(plan.blocks.map((b) => b.id));
  while (ids.has(`b${n}`)) n++;
  return `b${n}`;
}
