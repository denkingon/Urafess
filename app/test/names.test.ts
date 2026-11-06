import { describe, expect, it } from 'vitest';
import { nameKey, normalizeName } from '../src/shared/names';

describe('名前のきまり', () => {
  it('カタカナとひらがな・全角と半角・大文字と小文字・空白と中黒の違いは同じ名前とみなす', () => {
    const same = ['ゆう', 'ユウ', 'ﾕｳ', 'ゆ う', 'ゆ・う', ' ゆう '];
    for (const n of same) expect(nameKey(normalizeName(n)!)).toBe(nameKey('ゆう'));
    expect(nameKey('Nate')).toBe(nameKey('ＮＡＴＥ'));
    expect(nameKey('ヴィ')).toBe(nameKey('ゔぃ'));
  });

  it('ちがう名前はちがう', () => {
    expect(nameKey('ゆう')).not.toBe(nameKey('ゆうと'));
    expect(nameKey('ゆう')).not.toBe(nameKey('ゆー'));
    expect(nameKey('もえ')).not.toBe(nameKey('もえ2'));
  });

  it('記号だけの名前も空にならない', () => {
    expect(nameKey('・')).not.toBe('');
  });

  it('使えない名前は null（空・長すぎる・文字でない）', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName('あ'.repeat(21))).toBeNull();
    expect(normalizeName(12)).toBeNull();
    expect(normalizeName(' あお ')).toBe('あお');
  });
});
