import { describe, expect, it } from 'vitest';
import { isAnnounceSettings, mayRing, newsText, newsTiming } from '../src/shared/announce';
import type { CaptureNews } from '../src/shared/protocol';
import { ANNOUNCE_SHOW_MS, ANNOUNCE_SOUND_LATE_MS } from '../src/shared/rules';
import { chimeSamples } from '../src/client/sound/chime';

const base: CaptureNews = {
  seq: 1,
  kind: 'capture',
  showAt: 10_000,
  runner: { num: 2, name: 'ゆいか' },
  oni: { num: 1, name: 'さむ' },
  left: 6,
  total: 7,
  sound: 'all',
};

describe('捕まったときの全員への知らせ', () => {
  it('帯の言葉：鬼も・捕まった人・人数だけ・取り消し・試し', () => {
    expect(newsText(base)).toEqual({ label: '確保', en: 'CAUGHT', who: 'さむ → ゆいか', left: '逃走者 残り 6/7' });
    expect(newsText({ ...base, oni: null }).who).toBe('ゆいか');
    expect(newsText({ ...base, oni: null, runner: null }).who).toBe('1人');
    expect(newsText({ ...base, kind: 'release', left: 7 })).toMatchObject({ label: '確保の取り消し', who: 'ゆいか', left: '逃走者 残り 7/7' });
    expect(newsText({ ...base, kind: 'test', runner: null, oni: null, total: 0 }).label).toBe('知らせのテスト');
  });

  it('鳴らすか：逃走者以外では、逃げている逃走者だけ鳴らさない', () => {
    expect(mayRing('all', true)).toBe(true);
    expect(mayRing('oni', true)).toBe(false);
    expect(mayRing('oni', false)).toBe(true);
    expect(mayRing('none', false)).toBe(false);
  });

  it('時刻：出す瞬間までは待ち、遅れて届いたら帯だけ、長く遅れたら出さない', () => {
    expect(newsTiming(base, 9_999)).toBe('wait');
    expect(newsTiming(base, 10_000)).toBe('show');
    expect(newsTiming(base, 10_000 + ANNOUNCE_SOUND_LATE_MS)).toBe('quiet');
    expect(newsTiming(base, 10_000 + ANNOUNCE_SHOW_MS)).toBe('over');
  });

  it('設定の形を見分ける', () => {
    expect(isAnnounceSettings({ show: 'both', sound: 'all' })).toBe(true);
    expect(isAnnounceSettings({ show: 'loud', sound: 'all' })).toBe(false);
    expect(isAnnounceSettings(null)).toBe(false);
  });

  it('確保の音：割れない・超音波の帯に音を出さない', () => {
    const rate = 48_000;
    const x = chimeSamples('capture', rate);
    expect(x.length / rate).toBeGreaterThan(1);
    expect(x.length / rate).toBeLessThan(1.6);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThanOrEqual(1);
    // 15kHz の成分（DFT 1点）が、1047Hz の成分よりずっと小さい
    const power = (f: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < x.length; i++) {
        re += x[i] * Math.cos((2 * Math.PI * f * i) / rate);
        im += x[i] * Math.sin((2 * Math.PI * f * i) / rate);
      }
      return Math.hypot(re, im);
    };
    expect(power(15_000)).toBeLessThan(power(1047) / 100);
  });
});
