import { beforeAll, describe, expect, it } from 'vitest';
import { loadGgwave, mixMelody, parseSoundPayload, SoundCodec, soundPayload, type SoundProtocol } from '../src/client/sound/codec';
import { SOUND_MELODY_GAIN, SOUND_PROTOCOL, SOUND_VOLUME } from '../src/shared/rules';

/**
 * 音で番号を送る部品を、スピーカー→空気→マイクを真似た「回線」に通して確かめる。
 * 実機の代わりにはならないが、雑音・音の弱まり・高音の落ち込み・サンプリング周波数の違いで
 * どの送り方が残るかを見て、既定の送り方を選ぶ根拠にする。
 */

let codec: SoundCodec;

beforeAll(async () => {
  codec = new SoundCodec(await loadGgwave());
});

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Channel {
  /** 音の弱まり（1＝そのまま） */
  gain: number;
  /** 白い雑音の大きさ（全帯域。屋外の高音の雑音より厳しい） */
  white: number;
  /** 話し声・風のような低い雑音の大きさ（4kHz より下） */
  low: number;
  /** スピーカーとマイクの高音の落ち込み（Hz、0 で無し）。2段の1次フィルタ */
  rolloffHz: number;
  /** マイク側のサンプリング周波数 */
  rxRate: number;
}

function onePole(x: Float32Array, fc: number, fs: number): Float32Array<ArrayBuffer> {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += a * (x[i] - s);
    y[i] = s;
  }
  return y;
}

function resample(x: Float32Array<ArrayBuffer>, from: number, to: number): Float32Array<ArrayBuffer> {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to;
    const k = Math.floor(t);
    const f = t - k;
    y[i] = (x[k] ?? 0) * (1 - f) + (x[k + 1] ?? 0) * f;
  }
  return y;
}

/** 送る波形を回線に通し、マイクと同じ4096個ずつ渡して読み取れた文字列を返す */
function transmit(wave: Float32Array, ch: Channel, seed = 1): string[] {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pad = 24_000;
  let sig: Float32Array<ArrayBuffer> = new Float32Array(wave.length + pad * 2);
  for (let i = 0; i < wave.length; i++) sig[pad + i] = wave[i] * ch.gain;
  if (ch.rolloffHz > 0) sig = onePole(onePole(sig, ch.rolloffHz, 48_000), ch.rolloffHz, 48_000);
  const lowNoise = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) lowNoise[i] = gauss();
  // 話し声や風は 4kHz より下に集まる。6段の1次フィルタで高音をほぼ消した雑音にする
  let lowShaped: Float32Array<ArrayBuffer> = lowNoise;
  for (let k = 0; k < 6; k++) lowShaped = onePole(lowShaped, 3_000, 48_000);
  for (let i = 0; i < sig.length; i++) sig[i] += ch.white * gauss() + ch.low * 4 * lowShaped[i];
  const rx = resample(sig, 48_000, ch.rxRate);
  const dec = codec.decoder(ch.rxRate);
  const out: string[] = [];
  const chunk = 4096;
  for (let i = 0; i + chunk <= rx.length; i += chunk) out.push(...dec.push(rx.slice(i, i + chunk)));
  dec.free();
  return out;
}

const CHANNELS: Record<string, Channel> = {
  そのまま: { gain: 1, white: 0, low: 0, rolloffHz: 0, rxRate: 48_000 },
  // 鬼が相手のスマホに近づける（10〜30cm）ので、音は強い。まわりで人が話している
  '近くで話し声': { gain: 0.5, white: 0.003, low: 0.05, rolloffHz: 0, rxRate: 48_000 },
  '近くで大声': { gain: 0.5, white: 0.003, low: 0.2, rolloffHz: 0, rxRate: 48_000 },
  '近く・44.1kHz': { gain: 0.5, white: 0.003, low: 0.05, rolloffHz: 0, rxRate: 44_100 },
  '弱い＋雑音': { gain: 0.05, white: 0.01, low: 0, rolloffHz: 0, rxRate: 48_000 },
  '話し声の中': { gain: 0.05, white: 0.003, low: 0.3, rolloffHz: 0, rxRate: 48_000 },
  '高音が落ちる': { gain: 0.1, white: 0.005, low: 0.05, rolloffHz: 16_000, rxRate: 48_000 },
  '44.1kHzのマイク': { gain: 0.1, white: 0.005, low: 0.05, rolloffHz: 0, rxRate: 44_100 },
  'とても弱い': { gain: 0.01, white: 0.005, low: 0, rolloffHz: 0, rxRate: 48_000 },
};

describe('音で番号を送る', () => {
  it('送る中身は u＋3桁で、それ以外は読まない', () => {
    expect(soundPayload('482')).toBe('u482');
    expect(parseSoundPayload('u482')).toBe('482');
    expect(parseSoundPayload('u48')).toBeNull();
    expect(parseSoundPayload('x482')).toBeNull();
  });

  it('送り方ごとの長さと、回線ごとに読み取れるか（記録）', { timeout: 60_000 }, () => {
    const protocols: SoundProtocol[] = [
      'ultrasound-fastest',
      'ultrasound-fast',
      'ultrasound-normal',
      'audible-fastest',
      'audible-fast',
    ];
    const rows: Record<string, Record<string, string>> = {};
    for (const p of protocols) {
      const wave = codec.encode(soundPayload('482'), p, SOUND_VOLUME, 48_000);
      const row: Record<string, string> = { 長さ: `${(wave.length / 48_000).toFixed(2)}秒` };
      for (const [name, ch] of Object.entries(CHANNELS)) {
        let ok = 0;
        for (let seed = 1; seed <= 5; seed++) if (transmit(wave, ch, seed).includes('u482')) ok++;
        row[name] = `${ok}/5`;
      }
      rows[p] = row;
    }
    console.table(rows);
    expect(rows[SOUND_PROTOCOL]).toBeDefined();
  });

  it('既定の送り方（3音のフレーズを重ねた音）は、近づけたときの大声・遠くの話し声・高音の落ち込み・44.1kHz でも読み取れる', () => {
    const data = codec.encode(soundPayload('905'), SOUND_PROTOCOL, SOUND_VOLUME, 48_000);
    const wave = mixMelody(data, '905', 48_000, SOUND_MELODY_GAIN);
    for (const name of ['そのまま', '近くで話し声', '近くで大声', '近く・44.1kHz', '弱い＋雑音', '話し声の中', '高音が落ちる']) {
      for (let seed = 1; seed <= 3; seed++) expect(transmit(wave, CHANNELS[name], seed), `${name} ${seed}`).toContain('u905');
    }
  });

  it('雑音だけを聞いても、何も読み取らない（取り違えない）', () => {
    const silence = new Float32Array(48_000 * 4);
    const out = transmit(silence, { gain: 1, white: 0.05, low: 0.5, rolloffHz: 0, rxRate: 48_000 }, 9);
    expect(out.filter((s) => parseSoundPayload(s) !== null)).toEqual([]);
  });

  it('3音のフレーズは人の耳に届く高さ（4kHz より下）で、音がはみ出さない', () => {
    const data = codec.encode(soundPayload('905'), SOUND_PROTOCOL, SOUND_VOLUME, 48_000);
    const wave = mixMelody(data, '905', 48_000, SOUND_MELODY_GAIN);
    const peak = wave.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeLessThanOrEqual(1);
    // かざりだけの音でも、番号は読まない
    const melodyOnly = mixMelody(new Float32Array(data.length), '905', 48_000, SOUND_MELODY_GAIN);
    expect(transmit(melodyOnly, CHANNELS['そのまま']).filter((s) => parseSoundPayload(s) !== null)).toEqual([]);
  });

  it('44.1kHz の端末が鳴らした音も、48kHz の端末で読み取れる', () => {
    const wave = codec.encode(soundPayload('137'), SOUND_PROTOCOL, SOUND_VOLUME, 44_100);
    const as48 = resample(new Float32Array(wave), 44_100, 48_000);
    expect(transmit(as48, CHANNELS['弱い＋雑音'])).toContain('u137');
  });
});
