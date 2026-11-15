import { describe, expect, it } from 'vitest';
import { checkNewHostKey, encodeHostKey, HOST_KEY_MIN, hostKeyCandidates, normalizeHostKey, sameHostKey } from '../src/shared/hostkey';

const KEY = 'urafess with no 前例';

describe('主催者の合言葉の合わせ方', () => {
  it('空白・大文字小文字・全角半角のちがいは同じ合言葉', () => {
    for (const typed of [
      'urafess with no 前例',
      'urafesswithno前例',
      'Urafess With No 前例',
      ' urafess  with no 前例 ',
      'urafess　with　no　前例', // 全角の空白
      'ｕｒａｆｅｓｓ ｗｉｔｈ ｎｏ 前例', // 全角の英字
      'URAFESS WITH NO 前例\n',
    ]) {
      expect(sameHostKey(typed, KEY), typed).toBe(true);
    }
  });

  it('字がちがえば合わない', () => {
    for (const typed of ['urafess with no', 'urafess with no 前列', 'urafes with no 前例', '前例', '', '   ']) {
      expect(sameHostKey(typed, KEY), typed).toBe(false);
    }
  });

  it('決めてある合言葉が空（まだ入れていない）なら、何を打っても合わない', () => {
    expect(sameHostKey('', '')).toBe(false);
    expect(sameHostKey(' ', '  ')).toBe(false);
    expect(sameHostKey('a', undefined)).toBe(false);
    expect(sameHostKey(undefined, 'a')).toBe(false);
    expect(sameHostKey(123, '123')).toBe(false);
  });

  it('数字だけ・英字だけの合言葉もそのまま合う', () => {
    expect(sameHostKey('２０２６', '2026')).toBe(true);
    expect(sameHostKey('simtoken', 'simtoken')).toBe(true);
    expect(sameHostKey('simtokem', 'simtoken')).toBe(false);
  });

  it('そろえた形', () => {
    expect(normalizeHostKey(' Ａb　Ｃ 前例 ')).toBe('abc前例');
  });

  it('ヘッダーに載せる形は英数字と % だけで、戻すと元の合言葉', () => {
    const sent = encodeHostKey(KEY);
    expect(/^[\x21-\x7e]+$/.test(sent)).toBe(true);
    expect(hostKeyCandidates(sent)[0]).toBe(KEY);
  });

  it('前の版の画面がそのまま送ってきた合言葉も候補に残る', () => {
    expect(hostKeyCandidates('simtoken')).toEqual(['simtoken']);
    expect(hostKeyCandidates('100%')).toEqual(['100%']); // % の形として読めないもの
    expect(hostKeyCandidates('a%20b')).toEqual(['a b', 'a%20b']);
    expect(hostKeyCandidates(null)).toEqual([]);
    expect(hostKeyCandidates('')).toEqual([]);
  });
});

describe('主催者画面で決める新しい合言葉', () => {
  it('そろえたあと8文字以上なら使える（空白は数えない）', () => {
    expect(HOST_KEY_MIN).toBe(8);
    expect(checkNewHostKey('Urafess no')).toBe('ok'); // urafessno＝9文字
    expect(checkNewHostKey('noprecedent')).toBe('ok');
    expect(checkNewHostKey('前例のない夜の祭り')).toBe('ok');
  });

  it('短いもの・空白でかさ増ししたもの・字でないものは受けない', () => {
    for (const v of ['', 'urafess', '1234', 'u r a f e s s', '        ', 'ａｂｃ　ｄｅｆ']) expect(checkNewHostKey(v), v).toBe('short');
    for (const v of [undefined, null, 12345678, {}]) expect(checkNewHostKey(v)).toBe('short');
  });

  it('長すぎるものは受けない', () => {
    expect(checkNewHostKey('a'.repeat(64))).toBe('ok');
    expect(checkNewHostKey('a'.repeat(65))).toBe('long');
  });
});
