import type { GameView } from './protocol';
import type { RoleId } from './rules';
import { isDone } from './schedule';

/**
 * チャット。自由な文字は打てない（参加者は）。送れるのは「決まった札」「絵文字」「数字」のどれか（主催者が切り替える）。
 *
 * - 回線は2本：team＝同じ役の仲間どうし（鬼は鬼だけ、逃走者は逃走者だけ）、hq＝本部と参加者
 * - 札には代入がある：「ここにいる！」＝送った人の位置、「◯◯、一緒に来て！」＝仲間の名前、「◯◯で合流しよう」＝場所の名前
 * - 牢屋の人は絵文字だけ（主催者が外せる）
 * - 仲間の回線は、配役から時間が0になるまで。次の配役で画面から消える（記録には残る）
 * - 本部の回線は、今夜に入っている間ずっと。本部あての札は、どの制約でも送れる（困ったときに届かないと困るため）
 */

export type ChatCh = 'team' | 'hq';
/** 仲間の回線で送れるもの。card＝決まった札、emoji＝絵文字だけ、digit＝数字だけ、off＝送れない */
export type ChatMode = 'card' | 'emoji' | 'digit' | 'off';
/** 牢屋の人。emoji＝絵文字だけになる、same＝外の人と同じ */
export type ChatJail = 'emoji' | 'same';
export type ChatKind = 'card' | 'emoji' | 'digit' | 'text';
/** 誰に見えるか。oni／runner＝その役の人、all＝今夜の全員（本部から）、hq＝本部と、その1人 */
export type ChatScope = RoleId | 'all' | 'hq';

export const DEFAULT_CHAT_MODE: ChatMode = 'card';
export const DEFAULT_CHAT_JAIL: ChatJail = 'emoji';
export const isChatMode = (m: unknown): m is ChatMode => m === 'card' || m === 'emoji' || m === 'digit' || m === 'off';
export const isChatJail = (m: unknown): m is ChatJail => m === 'emoji' || m === 'same';

export const CHAT_MODE_NAME: Record<ChatMode, string> = { card: '札だけ', emoji: '絵文字だけ', digit: '数字だけ', off: '送れない' };

/** 続けて送れる間隔（1人）。これより早い分はサーバーが捨てる */
export const CHAT_GAP_MS = 1_200;
/** 画面に残す数（古いものから消える。記録には全部残る） */
export const CHAT_KEEP = 80;
/** 絵文字・数字の1回の長さ */
export const EMOJI_MAX = 6;
export const DIGIT_MAX = 8;
/** 本部が打つ文の長さ */
export const HQ_TEXT_MAX = 60;

/** 絵文字の札（キーボードは出さない。ここから選ぶ） */
export const EMOJI = ['👍', '👎', '🙏', '🆘', '👀', '🏃', '🤫', '😂', '😱', '🔥', '❤️', '💀', '⬆️', '⬇️', '⬅️', '➡️', '❓', '❗', '⭕', '❌', '👹', '🔦', '🌙', '🍦'] as const;

/** 場所の名前（主催者が変えられる）。最初の値は仮 */
export const DEFAULT_PLACES: readonly string[] = ['広場', '鴨池', 'メディア', '生協', '食堂', '体育館', 'バス停'];
export const PLACES_MAX = 12;
export const PLACE_NAME_MAX = 12;

export type Pair = readonly [ja: string, en: string];

export interface CardDef {
  id: string;
  ch: ChatCh;
  /** {person}＝仲間の名前、{place}＝場所の名前 */
  text: Pair;
  /** 選んでから送るもの */
  pick: 'person' | 'place' | null;
  /** 送った人の位置を付ける（取れていれば） */
  pos: boolean;
}

export const CARDS: readonly CardDef[] = [
  { id: 'here', ch: 'team', text: ['ここにいる！', "I'M HERE"], pick: null, pos: true },
  { id: 'come', ch: 'team', text: ['{person}、一緒に来て！', '{person}, COME'], pick: 'person', pos: true },
  { id: 'meet', ch: 'team', text: ['{place}で合流しよう', 'MEET AT {place}'], pick: 'place', pos: false },
  { id: 'spot', ch: 'team', text: ['{place}に相手がいる', 'ENEMY AT {place}'], pick: 'place', pos: false },
  { id: 'help', ch: 'team', text: ['助けて！', 'HELP'], pick: null, pos: true },
  { id: 'going', ch: 'team', text: ['いま行く', 'ON MY WAY'], pick: null, pos: false },
  { id: 'ok', ch: 'team', text: ['了解', 'OK'], pick: null, pos: false },
  { id: 'no', ch: 'team', text: ['無理', "CAN'T"], pick: null, pos: false },
  { id: 'hq-come', ch: 'hq', text: ['本部、来て', 'HQ, COME HERE'], pick: null, pos: true },
  { id: 'hq-app', ch: 'hq', text: ['アプリが動かない', 'APP BROKEN'], pick: null, pos: false },
  { id: 'hq-rule', ch: 'hq', text: ['ルールを教えて', 'RULES?'], pick: null, pos: false },
];

export const cardOf = (id: unknown): CardDef | null => CARDS.find((c) => c.id === id) ?? null;

/** 1通。from が null なら本部から */
export interface ChatMsg {
  id: number;
  at: number;
  ch: ChatCh;
  scope: ChatScope;
  from: { num: number; name: string } | null;
  kind: ChatKind;
  card?: string;
  /** 札に代入した仲間の名前・場所の名前 */
  person?: string;
  place?: string;
  /** 絵文字・数字・本部の文 */
  text?: string;
  pos?: { lat: number; lon: number; acc: number };
  /** 牢屋から送った */
  jail?: boolean;
  /** 本部が1人にあてた返事の、相手の名前（その人と本部にだけ届く） */
  toName?: string;
  /** 主催者にだけ付く：送った人（返事のあて先）と、その人の役 */
  pid?: string;
  role?: RoleId | null;
}

/** 画面と記録に出す文 */
export function chatText(m: Pick<ChatMsg, 'kind' | 'card' | 'person' | 'place' | 'text'>): Pair {
  if (m.kind !== 'card') return [m.text ?? '', m.text ?? ''];
  const c = cardOf(m.card);
  if (!c) return ['', ''];
  const fill = (s: string) => s.replace('{person}', m.person ?? '？').replace('{place}', m.place ?? '？');
  return [fill(c.text[0]), fill(c.text[1])];
}

/** 仲間の回線が開いているか：配役から、時間が0になるまで */
export function teamOpen(game: Pick<GameView, 'stage' | 'timer'>, now: number): boolean {
  if (game.stage === 'assigned') return true;
  return game.stage === 'timer' && !(game.timer !== null && isDone(game.timer, now));
}

/** その人が仲間の回線でいま送れるもの */
export function teamInput(mode: ChatMode, jail: ChatJail, caught: boolean): ChatMode {
  if (mode === 'off') return 'off';
  return caught && jail === 'emoji' ? 'emoji' : mode;
}

/** 絵文字の番号の並びを確かめる（1〜EMOJI_MAX 個、どれも札にある）。だめなら null */
export function emojiText(idx: unknown): string | null {
  if (!Array.isArray(idx) || idx.length < 1 || idx.length > EMOJI_MAX) return null;
  if (!idx.every((i) => Number.isInteger(i) && i >= 0 && i < EMOJI.length)) return null;
  return (idx as number[]).map((i) => EMOJI[i]).join('');
}

export function digitText(raw: unknown): string | null {
  return typeof raw === 'string' && new RegExp(`^[0-9]{1,${DIGIT_MAX}}$`).test(raw) ? raw : null;
}

/** 本部が打った文・場所の名前を整える（改行・制御文字を消し、長すぎれば切る）。空なら null */
export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, max).join('') || null;
}

/** 場所の名前の並びを整える（空・重なりを消す）。1つも無ければ null */
export function cleanPlaces(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const r of raw) {
    const name = cleanLine(r, PLACE_NAME_MAX);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= PLACES_MAX) break;
  }
  return out.length ? out : null;
}
