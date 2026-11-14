import { describe, expect, it } from 'vitest';
import { bannedHit, isSpecialName, normalizeBanWord, REDO_NAME, SHAME_NAME } from '../src/shared/badnames';

describe('使えない名前', () => {
  it('一覧の言葉が入っていれば弾く（打ち分け・記号・空白でもすり抜けない）', () => {
    for (const n of ['ちんこ', 'チンコ', 'ﾁﾝｺ', 'ち ん こ', 'チ.ン.コ', 'ち1ん2こ', 'たけしのちんこ', 'FUCK', 'ｆｕｃｋ', 'f-u-c-k', 'shithead']) {
      expect(bannedHit(n), n).not.toBeNull();
    }
  });

  it('= の言葉は、ちょうどその言葉か区切った1語のときだけ弾く', () => {
    expect(bannedHit('しね')).not.toBeNull();
    expect(bannedHit('シネ')).not.toBeNull();
    expect(bannedHit('しね たけし')).not.toBeNull();
    expect(bannedHit('シネマ')).toBeNull();
    expect(bannedHit('dick')).not.toBeNull();
    expect(bannedHit('Dickens')).toBeNull();
    expect(bannedHit('grape')).toBeNull();
    expect(bannedHit('class')).toBeNull();
    expect(bannedHit('うんちく')).toBeNull();
  });

  it('ふつうの名前は弾かない', () => {
    for (const n of ['さむ', 'ゆう', 'たけし', 'Sam', 'りょう', 'まさこ', 'こころ', 'シンジ', 'あんな', 'ナナ', 'Annalise', 'Sussex']) {
      expect(bannedHit(n), n).toBeNull();
    }
  });

  it('主催者が足した言葉も弾く', () => {
    expect(bannedHit('ばなな太郎')).toBeNull();
    expect(bannedHit('ばなな太郎', ['バナナ'])).toBe('バナナ');
    expect(bannedHit('ばなな', ['=ばなな'])).toBe('=ばなな');
    expect(bannedHit('ばなな太郎', ['=ばなな'])).toBeNull();
  });

  it('足す言葉を整える', () => {
    expect(normalizeBanWord('  うんこ ')).toBe('うんこ');
    expect(normalizeBanWord('')).toBeNull();
    expect(normalizeBanWord('!!!')).toBeNull();
    expect(normalizeBanWord('あ'.repeat(21))).toBeNull();
  });

  it('主催者が付ける名前はだれも名乗れない', () => {
    expect(isSpecialName(SHAME_NAME)).toBe(true);
    expect(isSpecialName(REDO_NAME)).toBe(true);
    expect(isSpecialName('なまえをつけなおしちゅう')).toBe(false);
    expect(isSpecialName('さむ')).toBe(false);
  });
});
