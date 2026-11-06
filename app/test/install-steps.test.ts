import { describe, expect, it } from 'vitest';
import { guideFor, hintsFor, iosMajor, langOf } from '../src/client/install/steps';

const labels = (path: Parameters<typeof guideFor>[0], ua = '', lang: 'ja' | 'en' = 'ja') =>
  guideFor(path, ua).steps.map((s) => s.label?.[lang] ?? s.kind);

describe('guideFor（置き方の手順の一覧）', () => {
  it('iPhone の Safari 26：••• → 共有 → その他 → ホーム画面に追加 → 追加 → アイコン', () => {
    expect(labels('ios-safari-26')).toEqual(['circle', '共有', 'その他', 'ホーム画面に追加', '追加', 'icon']);
    const g = guideFor('ios-safari-26');
    expect(g.title.ja).toBe('ホーム画面に追加');
    expect(g.pointer).toBe('bottom-right');
    // 最初のボタン（•••）と右上の「追加」には場所の印がある
    expect(g.steps[0].where).toBe('bottom-right');
    expect(g.steps[4].where).toBe('top-right');
    // iOS 26 の共有シートでは「その他」を押さないと出ない（点線ではなく、いつもの手）
    expect(g.steps[2].optional).toBeFalsy();
  });

  it('英語の iPhone では OS の字も英語（Share・More・Add to Home Screen・Add）', () => {
    expect(labels('ios-safari-26', '', 'en')).toEqual(['circle', 'Share', 'More', 'Add to Home Screen', 'Add', 'icon']);
    expect(guideFor('ios-safari-26').title.en).toBe('Add to Home Screen');
  });

  it('iPhone の Safari 18 まで：共有シートに「その他」の手は無い', () => {
    expect(labels('ios-safari')).toEqual(['tool', 'ホーム画面に追加', '追加', 'icon']);
    expect(guideFor('ios-safari').pointer).toBe('bottom-center');
  });

  it('iPhone の Chrome など：iOS 26 からは「その他」、版が分からなければ点線で入れる', () => {
    const ios26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1';
    const ios17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
    expect(labels('ios-other', ios26)).toEqual(['tool', 'その他', 'ホーム画面に追加', '追加', 'icon']);
    expect(guideFor('ios-other', ios26).steps[1].optional).toBeFalsy();
    expect(labels('ios-other', ios17)).toEqual(['tool', 'ホーム画面に追加', '追加', 'icon']);
    const unknown = guideFor('ios-other', 'Mozilla/5.0 (iPhone) CriOS/140');
    expect(unknown.steps[1].label?.ja).toBe('その他');
    expect(unknown.steps[1].optional).toBe(true);
  });

  it('Android とアプリの中', () => {
    expect(labels('android')).toEqual(['tool', 'アプリをインストール', 'インストール', 'icon']);
    expect(labels('android', '', 'en')).toEqual(['tool', 'Install app', 'Install', 'icon']);
    expect(guideFor('android').pointer).toBe('top-right');
    expect(labels('line')).toEqual(['tool', 'ブラウザで開く']);
    expect(labels('inapp', '', 'en')).toEqual(['tool', 'Open in browser']);
  });

  it('手は多くても6つ（URAJI の数字は 1〜6 まで）。どの手も日本語と英語の一言がそろっている', () => {
    for (const p of ['ios-safari-26', 'ios-safari', 'ios-other', 'android', 'inapp', 'line'] as const) {
      const g = guideFor(p);
      expect(g.steps.length).toBeLessThanOrEqual(6);
      for (const s of g.steps) {
        // 片方の言葉だけ一言がある、ということがない
        expect(Boolean(s.hint.ja)).toBe(Boolean(s.hint.en));
        if (s.label) expect(s.label.ja && s.label.en).toBeTruthy();
      }
    }
  });
});

describe('添える一言', () => {
  it('日本語のスマホ：日本語の一言と、英語で「押すものの字 — 場所」', () => {
    const [, share, more, , add, open] = guideFor('ios-safari-26').steps;
    expect(hintsFor(more, 'ja')).toEqual({ main: '共有シートの右端', other: 'More — right end of the sheet', otherLang: 'en' });
    expect(hintsFor(share, 'ja')).toEqual({ main: '', other: 'Share', otherLang: 'en' });
    expect(hintsFor(add, 'ja').other).toBe('Add — top right');
    expect(hintsFor(open, 'ja')).toEqual({ main: 'ホーム画面のアイコンから開く', other: 'Open from the Home Screen', otherLang: 'en' });
  });

  it('英語のスマホ：英語の一言（頭は大文字）と、日本語で「「字」場所」', () => {
    const [first, share, more] = guideFor('ios-safari-26').steps;
    expect(hintsFor(more, 'en')).toEqual({ main: 'Right end of the sheet', other: '「その他」 共有シートの右端', otherLang: 'ja' });
    expect(hintsFor(share, 'en')).toEqual({ main: '', other: '「共有」', otherLang: 'ja' });
    expect(hintsFor(first, 'en').main).toBe('••• at the bottom right');
  });

  it('スマホの言葉：日本語でなければ英語', () => {
    expect(langOf('ja-JP')).toBe('ja');
    expect(langOf('ja')).toBe('ja');
    expect(langOf('en-US')).toBe('en');
    expect(langOf('zh-CN')).toBe('en');
    expect(langOf(undefined)).toBe('ja');
  });

  it('iosMajor：UA の OS の版', () => {
    expect(iosMajor('CPU iPhone OS 26_1 like Mac OS X')).toBe(26);
    expect(iosMajor('CPU iPhone OS 18_7 like Mac OS X')).toBe(18);
    expect(iosMajor('Android 14')).toBeNull();
  });
});
