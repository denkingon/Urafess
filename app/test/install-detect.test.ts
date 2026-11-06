import { describe, expect, it } from 'vitest';
import { detectInstall, lineEscapeUrl } from '../src/client/install/detect';

const UA = {
  // Safari 26 は OS の版を 18_x に固定している。版は Version/ で見る
  safari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
  safari18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  lineIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.16.0',
  lineAndroid: 'Mozilla/5.0 (Linux; Android 14; SO-51D Build/68.1.A.2.170; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Mobile Safari/537.36 Line/15.16.1/IAB',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 360.0.0.31.89 (iPhone15,2; iOS 18_6; ja_JP; ja; scale=3.00; 1179x2556; 661548412)',
  iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

const at = (ua: string, extra: Partial<{ standalone: boolean; maxTouchPoints: number }> = {}) =>
  detectInstall({ ua, standalone: false, maxTouchPoints: 5, ...extra });

describe('detectInstall', () => {
  it('ホーム画面のアプリとして開いていれば、何も案内しない', () => {
    expect(at(UA.safari26, { standalone: true })).toBe('installed');
  });

  it('iPhone の Safari は版で分ける（26 からは ••• の中に共有がある）', () => {
    expect(at(UA.safari26)).toBe('ios-safari-26');
    expect(at(UA.safari18)).toBe('ios-safari');
  });

  it('パソコンを名乗る iPad の Safari も iPhone と同じに扱う', () => {
    expect(at(UA.ipadSafari, { maxTouchPoints: 5 })).toBe('ios-safari-26');
    expect(at(UA.ipadSafari, { maxTouchPoints: 0 })).toBe('desktop');
  });

  it('iPhone の Chrome', () => {
    expect(at(UA.chromeIos)).toBe('ios-other');
  });

  it('LINE の中は、iPhone でも Android でも LINE として扱う', () => {
    expect(at(UA.lineIos)).toBe('line');
    expect(at(UA.lineAndroid)).toBe('line');
  });

  it('ほかのアプリの中のブラウザ', () => {
    expect(at(UA.instagram)).toBe('inapp');
    expect(at(UA.iosWebView)).toBe('inapp');
    expect(at(UA.androidWebView)).toBe('inapp');
  });

  it('Android とパソコン', () => {
    expect(at(UA.androidChrome)).toBe('android');
    expect(at(UA.macChrome, { maxTouchPoints: 0 })).toBe('desktop');
  });
});

describe('lineEscapeUrl', () => {
  it('openExternalBrowser=1 を付ける（ほかの印は残す）', () => {
    expect(lineEscapeUrl('https://urafess.example.dev/')).toBe('https://urafess.example.dev/?openExternalBrowser=1');
    expect(lineEscapeUrl('https://urafess.example.dev/?a=1')).toBe('https://urafess.example.dev/?a=1&openExternalBrowser=1');
  });

  it('付けて開き直したのに LINE の中のままなら、もう付けない（行ったり来たりしない）', () => {
    expect(lineEscapeUrl('https://urafess.example.dev/?openExternalBrowser=1')).toBeNull();
  });
});
