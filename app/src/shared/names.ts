import { NAME_MAX_LENGTH } from './rules';

/**
 * 名前のきまり。名前は名簿の中で1人1つ（番号は画面に出さないので、名前で人を見分ける）。
 */

/** 入力された名前を整える。使えない名前なら null */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX_LENGTH) return null;
  return name;
}

/**
 * 名簿で「同じ名前」とみなすための形。
 * 全角と半角・大文字と小文字・カタカナとひらがな・空白や中黒の有無の違いは、同じ名前とみなす
 * （「ゆう」「ユウ」「ﾕｳ」「ゆ う」は同じ。前に来た人が打ち方を覚えていなくても見つかるように）
 */
export function nameKey(name: string): string {
  const base = name.normalize('NFKC').toLowerCase();
  const key = base
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･.\-_]/g, '');
  return key || base;
}
