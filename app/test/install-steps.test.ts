import { describe, expect, it } from 'vitest';
import { guideFor, iosMajor } from '../src/client/install/steps';

const labels = (path: Parameters<typeof guideFor>[0], ua = '') => guideFor(path, ua).steps.map((s) => s.label ?? s.kind);

describe('guideFor（置き方の手順の一覧）', () => {
  it('iPhone の Safari 26：••• → 共有 → その他 → ホーム画面に追加 → 追加 → アイコン', () => {
    expect(labels('ios-safari-26')).toEqual(['circle', '共有', 'その他', 'ホーム画面に追加', '追加', 'icon']);
    const g = guideFor('ios-safari-26');
    expect(g.title).toBe('ホーム画面に追加');
    expect(g.pointer).toBe('bottom-right');
    // 最初のボタン（•••）と右上の「追加」には場所の印がある
    expect(g.steps[0].where).toBe('bottom-right');
    expect(g.steps[4].where).toBe('top-right');
    // iOS 26 の共有シートでは「その他」を押さないと出ない（点線ではなく、いつもの手）
    expect(g.steps[2].optional).toBeFalsy();
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
    expect(unknown.steps[1].label).toBe('その他');
    expect(unknown.steps[1].optional).toBe(true);
  });

  it('Android とアプリの中', () => {
    expect(labels('android')).toEqual(['tool', 'アプリをインストール', 'インストール', 'icon']);
    expect(guideFor('android').pointer).toBe('top-right');
    expect(labels('line')).toEqual(['tool', 'ブラウザで開く']);
    expect(labels('inapp')).toEqual(['tool', 'ブラウザで開く']);
  });

  it('手は多くても6つ（URAJI の数字は 1〜6 まで）', () => {
    for (const p of ['ios-safari-26', 'ios-safari', 'ios-other', 'android', 'inapp', 'line'] as const) {
      expect(guideFor(p).steps.length).toBeLessThanOrEqual(6);
    }
  });

  it('iosMajor：UA の OS の版', () => {
    expect(iosMajor('CPU iPhone OS 26_1 like Mac OS X')).toBe(26);
    expect(iosMajor('CPU iPhone OS 18_7 like Mac OS X')).toBe(18);
    expect(iosMajor('Android 14')).toBeNull();
  });
});
