/**
 * 主催者の合言葉の合わせ方。
 * スマホで打つので、空白のあるなし・大文字小文字・全角半角のちがいは同じ合言葉とみなす
 * （「urafess with no 前例」は「Urafesswithno前例」と打っても合う）。
 */

/**
 * 主催者画面で決める合言葉の長さ（そろえたあとの字数）。
 * 当てずっぽうを止めるしくみが無い（何回でも試せる）ので、短いものは受けない
 */
export const HOST_KEY_MIN = 8;
export const HOST_KEY_MAX = 64;

/** くらべる前の形にそろえる：全角半角をそろえ（NFKC）、小文字にし、空白を全部とる */
export function normalizeHostKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** 打たれた合言葉が、決めてある合言葉と同じか。どちらかが空なら合わない */
export function sameHostKey(given: unknown, expected: unknown): boolean {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const want = normalizeHostKey(expected);
  return want.length > 0 && normalizeHostKey(given) === want;
}

/**
 * 通信のヘッダー（x-host-token）に載せる形。ヘッダーには日本語をそのまま載せられない
 * （ブラウザが送る前にエラーにする）ので、% の形に直して送る
 */
export function encodeHostKey(value: string): string {
  return encodeURIComponent(value);
}

/** ヘッダーで届いた合言葉の候補：そのままと、% の形を戻したもの（前の版の画面はそのまま送ってくる） */
export function hostKeyCandidates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? [raw] : [decoded, raw];
  } catch {
    return [raw];
  }
}

/** 主催者画面で決める新しい合言葉が使えるか。short＝短すぎる、long＝長すぎる */
export function checkNewHostKey(value: unknown): 'ok' | 'short' | 'long' {
  if (typeof value !== 'string') return 'short';
  const n = [...normalizeHostKey(value)].length;
  if (n < HOST_KEY_MIN) return 'short';
  if (n > HOST_KEY_MAX) return 'long';
  return 'ok';
}
