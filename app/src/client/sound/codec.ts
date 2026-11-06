import type { GgwaveEnumValue, GgwaveModule, GgwaveParameters } from 'ggwave';
import type { SoundProtocol } from '../../shared/rules';

/**
 * 音で短い文字列（逃走者の番号）を送る・聞き取る部品。中身は ggwave（MIT）の FSK と誤り訂正。
 * ブラウザでも Node（テスト）でも同じものが動く。見た目もマイクもスピーカーも知らない。
 * 送り方：ultrasound は 15kHz より上（ほとんど聞こえない）、audible は 1.9〜6.4kHz（ピロピロ聞こえる）
 */

export type { SoundProtocol };

export const SOUND_PROTOCOLS: readonly SoundProtocol[] = [
  'ultrasound-fastest',
  'ultrasound-fast',
  'ultrasound-normal',
  'audible-fastest',
  'audible-fast',
  'audible-normal',
];

const PROTOCOL_KEY: Record<SoundProtocol, string> = {
  'ultrasound-fastest': 'GGWAVE_PROTOCOL_ULTRASOUND_FASTEST',
  'ultrasound-fast': 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
  'ultrasound-normal': 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL',
  'audible-fastest': 'GGWAVE_PROTOCOL_AUDIBLE_FASTEST',
  'audible-fast': 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
  'audible-normal': 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
};

let loading: Promise<GgwaveModule> | null = null;

/** ggwave を読み込む（1回だけ）。encode のたびに出る printf は捨てる */
export function loadGgwave(): Promise<GgwaveModule> {
  loading ??= import('ggwave')
    .then(async (m) => {
      const factory = (m as unknown as { default?: typeof m.default }).default ?? (m as unknown as typeof m.default);
      const g = await factory({ print: () => undefined, printErr: () => undefined });
      g.disableLog();
      return g;
    })
    .catch((e: unknown) => {
      // 読み込みに失敗したら（配役の瞬間に全員が取りに来て通信が詰まった等）、次に呼ばれたときにまた取りに行く
      loading = null;
      throw e;
    });
  return loading;
}

let codecPromise: Promise<SoundCodec> | null = null;

/** 画面から使う1つだけの SoundCodec（ggwave は1回だけ読み込む） */
export function getCodec(): Promise<SoundCodec> {
  codecPromise ??= loadGgwave()
    .then((g) => new SoundCodec(g))
    .catch((e: unknown) => {
      codecPromise = null;
      throw e;
    });
  return codecPromise;
}

export interface SoundDecoder {
  /** マイクから届いた音（-1〜1）を順に渡す。読み取れた文字列があれば返す */
  push(samples: Float32Array): string[];
  free(): void;
}

export class SoundCodec {
  private readonly params: GgwaveParameters;

  constructor(private readonly g: GgwaveModule) {
    this.params = g.getDefaultParameters();
  }

  private protocol(p: SoundProtocol): GgwaveEnumValue {
    return this.g.ProtocolId[PROTOCOL_KEY[p]];
  }

  /** 文字列を音の波形（sampleRate、-1〜1）にする。volume は 1〜100 */
  encode(text: string, protocol: SoundProtocol, volume: number, sampleRate: number): Float32Array {
    const g = this.g;
    const instance = g.init({
      ...this.params,
      sampleRateOut: sampleRate,
      sampleFormatOut: g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32,
      operatingMode: g.GGWAVE_OPERATING_MODE_TX,
    });
    try {
      const view = g.encode(instance, text, this.protocol(protocol), Math.max(1, Math.min(100, Math.round(volume))));
      // WASM のメモリを見ているだけなので、次の呼び出しの前に写す
      const bytes = new Int8Array(view);
      return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
    } finally {
      g.free(instance);
    }
  }

  /** 聞き取り役を作る。sampleRate はマイク側（AudioContext）の値 */
  decoder(sampleRate: number): SoundDecoder {
    const g = this.g;
    let instance: number | null = g.init({
      ...this.params,
      sampleRateInp: sampleRate,
      sampleFormatInp: g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32,
      operatingMode: g.GGWAVE_OPERATING_MODE_RX,
    });
    return {
      push(samples: Float32Array): string[] {
        if (instance === null) return [];
        const bytes = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
        const out = g.decode(instance, bytes);
        if (!out || out.length === 0) return [];
        return [decodeText(new Uint8Array(out))];
      },
      free() {
        if (instance !== null) g.free(instance);
        instance = null;
      },
    };
  }
}

function decodeText(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// ---------- 聞こえる音（かざり） ----------

/** 3桁の数字1つを1音にする（ペンタトニック。どの並びでも濁らない） */
const NOTE_HZ = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0];

/**
 * 3桁から、その人だけの3音のフレーズを作り、送る波形に重ねる。
 * 番号を運ぶのは超音波の側で、こちらは人の耳に「鳴っている」と分かるためのかざり（4kHz より下なので超音波の読み取りを邪魔しない）
 */
export function mixMelody(wave: Float32Array, code: string, rate: number, gain = 0.3): Float32Array<ArrayBuffer> {
  const out = new Float32Array(wave);
  const digits = [...code].map((c) => Number(c)).filter((d) => d >= 0 && d <= 9);
  if (!digits.length) return out;
  const note = Math.round(rate * 0.16);
  const step = Math.round(rate * 0.2);
  const phrase = step * digits.length + Math.round(rate * 0.2);
  for (let start = 0; start + note <= out.length; start += phrase) {
    digits.forEach((d, i) => {
      const f = NOTE_HZ[d];
      const s0 = start + i * step;
      for (let k = 0; k < note && s0 + k < out.length; k++) {
        const t = k / rate;
        // 立ち上がりと消え際をなめらかにして、プツッという音を出さない
        const env = Math.min(1, k / (rate * 0.008)) * Math.exp((-3 * k) / note);
        const v = Math.sin(2 * Math.PI * f * t) * 0.8 + Math.sin(4 * Math.PI * f * t) * 0.2;
        out[s0 + k] += gain * env * v;
      }
    });
  }
  return out;
}

// ---------- 送る中身 ----------

/** 音で送るのは「u」＋逃走者のその回の3桁。ほかの ggwave の音と混ざっても、頭の1文字で見分ける */
const PREFIX = 'u';

export function soundPayload(code: string): string {
  return `${PREFIX}${code}`;
}

/** 聞き取れた文字列から3桁を取り出す。違う形なら null */
export function parseSoundPayload(text: string): string | null {
  const m = /^u(\d{3})$/.exec(text.trim());
  return m ? m[1] : null;
}
