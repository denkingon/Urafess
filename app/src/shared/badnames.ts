import { nameKey } from './names';

/**
 * 不適切な名前を弾く。
 * 自動：名前を入れたとき・名前を変えるとき、下の一覧（と主催者が足した言葉）に引っかかれば入れない。
 * 手動：主催者が「名前を付け直させる」か「SHAME_NAME に切り替える」。
 *
 * 照らし合わせは名簿の「同じ名前」と同じ形（全角半角・カタカナとひらがな・大文字小文字）に、
 * さらに記号・数字・空白を抜いた形で見る（「ち ん こ」「チ.ン.コ」「ﾁﾝｺ」も引っかかる）。
 * 言葉の頭に = を付けると「その言葉ちょうど」だけを弾く（名前の全体か、空白や記号で区切った1語がその言葉のとき）。
 * 短い英語や、ほかの言葉の中によく出てくる言葉は = にする（class の ass、シネマ の しね を弾かないように）
 */

/** 主催者が「名前を付け直させる」とき、付け直すまでの仮の名前（何人いてもいい） */
export const REDO_NAME = '名前を付け直し中';
/** 主催者が切り替える名前（何人いてもいい。本人は変えられない） */
export const SHAME_NAME = '不適切な名前にしたために名前を変更されたやつ';

/** 主催者が足せる言葉の数と長さ */
export const BAN_MAX_WORDS = 200;
export const BAN_MAX_LENGTH = 20;

/** 最初から入れておく言葉。足すときは、かな・漢字・英小文字どれで書いてもよい（照らし合わせの形にそろえる） */
export const DEFAULT_BANNED: readonly string[] = [
  // 性的な言葉
  'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'ふぇら', 'ぱいずり', 'なかだし', '中出し', 'れいぷ', '強姦', '痴漢', '射精',
  'おっぱい', 'ぺにす', 'きんたま', '=あなる', 'おなに', 'しこしこ', '=sex', 'porn', 'penis', 'vagina', 'pussy',
  '=dick', '=cock', '=anal', '=rape', 'blowjob', 'boobs', 'whore', '=slut', 'hentai',
  // 汚い言葉・脅し
  'うんこ', '=うんち', '死ね', '=しね', '氏ね', '殺す', 'ころす', '殺害', 'fuck', 'shit', 'bitch', 'cunt', 'asshole', '=kill',
  // 差別の言葉
  'きちがい', '気違い', '基地外', '害児', '=がいじ', 'ガイジ', '池沼', '=かたわ', 'めくら', 'つんぼ', '支那', '=ちょん',
  'nigger', 'nigga', 'faggot', 'retard', '=fag',
  // 人をおとしめる名乗り・名前のふり
  'hitler', 'ヒトラー', 'nazi', 'ナチス', '主催者', '運営', 'admin',
];

/** 照らし合わせの形：名簿の同じ名前の形から、記号・数字・空白を抜く */
export function matchKey(s: string): string {
  return nameKey(s).replace(/[^\p{L}]/gu, '');
}

interface BanEntry {
  /** 主催者が打った・一覧に書いた形 */
  word: string;
  key: string;
  exact: boolean;
}

export function banEntry(raw: string): BanEntry | null {
  const t = raw.normalize('NFKC').trim();
  const exact = t.startsWith('=');
  // 「おし(唖)」のような書き添えは照らし合わせに使わない
  const body = (exact ? t.slice(1) : t).replace(/\(.*?\)/g, '');
  const key = matchKey(body);
  if (!key) return null;
  return { word: t, key, exact };
}

const DEFAULT_ENTRIES: BanEntry[] = DEFAULT_BANNED.map(banEntry).filter((e): e is BanEntry => e !== null);

/** 名前の中で区切られた1語ずつ（= の言葉はこれと名前の全体で見る） */
function tokens(name: string): string[] {
  return name
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .map(matchKey)
    .filter(Boolean);
}

/** 名前が引っかかる言葉（最初の1つ）。引っかからなければ null。extra＝主催者が足した言葉 */
export function bannedHit(name: string, extra: readonly string[] = []): string | null {
  const whole = matchKey(name);
  if (!whole) return null;
  const words = new Set([whole, ...tokens(name)]);
  const entries = [...DEFAULT_ENTRIES, ...extra.map(banEntry).filter((e): e is BanEntry => e !== null)];
  for (const e of entries) {
    if (e.exact ? words.has(e.key) : whole.includes(e.key)) return e.word;
  }
  return null;
}

/** 主催者が足す言葉を整える。使えなければ null */
export function normalizeBanWord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!t || [...t].length > BAN_MAX_LENGTH) return null;
  return banEntry(t) ? t : null;
}

/** 手で付ける名前（だれも名乗れない） */
export function isSpecialName(name: string): boolean {
  const k = nameKey(name);
  return k === nameKey(REDO_NAME) || k === nameKey(SHAME_NAME);
}
