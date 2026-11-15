/**
 * ルールのプリセット（本部で先に作っておく、デッキ全部の組み合わせ）。
 *
 * 1つのプリセット＝遊び方・時間（配役・4段・結果発表）・鬼と逃走者の割合・マイク・配役の決め方・出し方・司令塔・チャットの制約・範囲の縮み方。
 * 夜の予定のプレ・本番のブロックはプリセットを選ぶ。当日はそのブロックで「このプリセットを入れる」を押すと、デッキ全部が一度に切りかわる。
 *
 * サーバーに置く（どの本部の画面でも同じ）。合言葉つきの /presets で読み書きできる（Claude と一緒に作るための口）。
 * 遊び方は、いまはドロケイだけが動く。増やし鬼・氷鬼は名前だけ先に置いてある（選んでもドロケイで動く）。
 */
import { type ChatJail, type ChatMode, DEFAULT_CHAT_JAIL, DEFAULT_CHAT_MODE, isChatJail, isChatMode } from './chat';
import { DEFAULT_LEAD_RULES, isLeadRules, type LeadRules } from './lead';
import { defaultRound, type NightRound } from './night';
import {
  DEFAULT_MIC_MODE,
  DEFAULT_RATIO,
  DEFAULT_REVEAL_MODE,
  DEFAULT_WISH_MODE,
  isMicMode,
  isRevealMode,
  isValidRatio,
  isWishMode,
  type MicMode,
  type RevealMode,
  type WishMode,
} from './rules';
import { cleanShrinkPlan, DEFAULT_SHRINK_PLAN, isShrinkPlan, type ShrinkPlan } from './shrink';

export type GameMode = 'dorokei' | 'fueshi' | 'koori';
export const GAME_MODES: { mode: GameMode; name: string; ready: boolean }[] = [
  { mode: 'dorokei', name: 'ドロケイ', ready: true },
  { mode: 'fueshi', name: '増やし鬼', ready: false },
  { mode: 'koori', name: '氷鬼', ready: false },
];

export interface Preset {
  id: string;
  name: string;
  mode: GameMode;
  /** 時間（秒）：配役・4段（デッキの時間）・結果発表 */
  round: NightRound;
  ratio: { oni: number; runner: number };
  mic: MicMode;
  wish: WishMode;
  reveal: RevealMode;
  lead: LeadRules;
  chat: { mode: ChatMode; jail: ChatJail };
  /** 範囲の縮み方。縮む先を地図で選ぶ形（pick）は、プリセットでは持たない（範囲ごとに点がちがうため） */
  shrink: ShrinkPlan;
}

export const PRESETS_MAX = 24;
export const PRESET_NAME_MAX = 20;

export function basePreset(id: string, name: string): Preset {
  return {
    id,
    name,
    mode: 'dorokei',
    round: defaultRound('game'),
    ratio: { ...DEFAULT_RATIO },
    mic: DEFAULT_MIC_MODE,
    wish: DEFAULT_WISH_MODE,
    reveal: DEFAULT_REVEAL_MODE,
    lead: { ...DEFAULT_LEAD_RULES },
    chat: { mode: DEFAULT_CHAT_MODE, jail: DEFAULT_CHAT_JAIL },
    shrink: { ...DEFAULT_SHRINK_PLAN },
  };
}

/** 最初に置いておくプリセット（まだ1つも作っていない部屋） */
export function defaultPresets(): Preset[] {
  const pre = basePreset('p1', 'プレ用ドロケイ');
  pre.round = defaultRound('pre');
  pre.reveal = 'now';
  const std = basePreset('p2', 'ドロケイ（標準）');
  const hard = basePreset('p3', 'ドロケイ（司令塔・縮む）');
  hard.lead = { ...DEFAULT_LEAD_RULES, on: true };
  hard.shrink = { times: 2, finalArea: 0.25, to: 'mid', pick: null, mission: true };
  hard.round = { cast: 60, phases: [20, 60, 420, 120], result: 180 };
  return [pre, std, hard];
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(v);
const isPart = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3600;

/** 1つのプリセットを確かめる（足りない札は最初の値で埋める。形がおかしければ null） */
export function cleanPreset(v: unknown): Preset | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isId(o.id) || typeof o.name !== 'string') return null;
  const name = o.name.trim().slice(0, PRESET_NAME_MAX);
  if (!name) return null;
  const base = basePreset(o.id, name);
  const mode = o.mode === undefined ? base.mode : o.mode;
  if (!GAME_MODES.some((m) => m.mode === mode)) return null;
  let round = base.round;
  if (o.round !== undefined) {
    const r = o.round as Record<string, unknown> | null;
    if (!r || !isPart(r.cast) || !isPart(r.result) || !Array.isArray(r.phases) || r.phases.length !== 4) return null;
    if (!r.phases.every((x) => isPart(x) && (x as number) >= 1)) return null;
    round = { cast: r.cast, phases: [...(r.phases as number[])], result: r.result };
  }
  const ratio = o.ratio === undefined ? base.ratio : o.ratio;
  if (!isValidRatio(ratio)) return null;
  const mic = o.mic === undefined ? base.mic : o.mic;
  const wish = o.wish === undefined ? base.wish : o.wish;
  const reveal = o.reveal === undefined ? base.reveal : o.reveal;
  if (!isMicMode(mic) || !isWishMode(wish) || !isRevealMode(reveal)) return null;
  const lead = o.lead === undefined ? base.lead : o.lead;
  if (!isLeadRules(lead)) return null;
  const chat = (o.chat === undefined ? base.chat : o.chat) as Record<string, unknown> | null;
  if (!chat || !isChatMode(chat.mode) || !isChatJail(chat.jail)) return null;
  const shrinkIn = o.shrink === undefined ? base.shrink : o.shrink;
  if (!isShrinkPlan(shrinkIn) || shrinkIn.to === 'pick') return null;
  return {
    id: o.id,
    name,
    mode: mode as GameMode,
    round,
    ratio: { oni: ratio.oni, runner: ratio.runner },
    mic,
    wish,
    reveal,
    lead: { on: lead.on, seen: lead.seen, dark: lead.dark, expose: lead.expose, restore: lead.restore },
    chat: { mode: chat.mode, jail: chat.jail },
    shrink: cleanShrinkPlan({ ...shrinkIn, pick: null }),
  };
}

/** プリセットの並びを確かめる（印が重なる・多すぎる・1つでもおかしければ null） */
export function cleanPresets(v: unknown): Preset[] | null {
  if (!Array.isArray(v) || v.length > PRESETS_MAX) return null;
  const out: Preset[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    const p = cleanPreset(x);
    if (!p || ids.has(p.id)) return null;
    ids.add(p.id);
    out.push(p);
  }
  return out;
}

export function newPresetId(list: readonly Preset[]): string {
  const ids = new Set(list.map((p) => p.id));
  let n = list.length + 1;
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
}

/** プリセットの時間（デッキの4段）を ms で */
export const presetDurations = (p: Preset): number[] => p.round.phases.map((s) => s * 1000);

const MIC_NAME: Record<MicMode, string> = { always: 'マイクずっと', hold: 'マイク押す間' };
const WISH_NAME: Record<WishMode, string> = { wish: '希望を聞く', lot: 'くじだけ' };
const REVEAL_NAME: Record<RevealMode, string> = { sync: '全員同時', tap: 'タップ', now: 'すぐ出す' };
const CHAT_NAME: Record<ChatMode, string> = { card: '札', emoji: '絵文字', digit: '数字', off: 'なし' };

/** 1行の要約（並びで見せる） */
export function presetSummary(p: Preset): string {
  const g = p.round.phases[2];
  const parts = [
    GAME_MODES.find((m) => m.mode === p.mode)!.name,
    `ゲーム${Math.floor(g / 60)}:${String(g % 60).padStart(2, '0')}`,
    `鬼${p.ratio.oni}:逃${p.ratio.runner}`,
    WISH_NAME[p.wish],
    REVEAL_NAME[p.reveal],
    MIC_NAME[p.mic],
    p.lead.on ? '司令塔' : '',
    p.shrink.times || p.shrink.mission ? `縮む${p.shrink.times ? `${p.shrink.times}回` : ''}${p.shrink.mission ? '・ミッション' : ''}` : '',
    `チャット${CHAT_NAME[p.chat.mode]}`,
  ];
  return parts.filter(Boolean).join('・');
}
