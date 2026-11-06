import { SOUND_GAP_MS, SOUND_MELODY_GAIN, SOUND_PROTOCOL, SOUND_VOLUME, type SoundProtocol } from '../../shared/rules';
import { getCodec, mixMelody, soundPayload } from './codec';

/**
 * 逃走者のスマホが「捕まった」を長押ししている間、自分の3桁を音で繰り返し鳴らす。
 *
 * - <audio> で鳴らす。iPhone の消音スイッチが入っていても鳴る（Web Audio は消音スイッチで消える）
 * - スマホは「画面に触れた直後」でないと音を出させてくれない。長押しの押し始めはその「直後」に数えられないので、
 *   それより前のどこかのタップで一度だけ無音を鳴らしておく（unlock）。一度鳴らした <audio> は、以後いつでも鳴らせる
 */
export class SoundEmitter {
  private readonly audio: HTMLAudioElement | null;
  private readonly urls = new Map<string, string>();
  private silentUrl: string | null = null;
  private current: string | null = null;
  private want = false;
  /** 一度でも鳴らせた（＝以後はタップなしで鳴らせる） */
  unlocked = false;

  constructor() {
    this.audio = typeof Audio === 'undefined' ? null : new Audio();
    if (this.audio) {
      this.audio.loop = true;
      this.audio.preload = 'auto';
      this.audio.setAttribute('playsinline', '');
    }
  }

  /** タップの直後に呼ぶ。まだなら無音を一瞬鳴らして、以後タップなしで鳴らせるようにする */
  unlock(): void {
    const a = this.audio;
    if (!a || this.unlocked || this.want) return;
    this.silentUrl ??= URL.createObjectURL(wavBlob(new Float32Array(4800), 48_000));
    a.src = this.silentUrl;
    a.play()
      .then(() => {
        this.unlocked = true;
        if (!this.want) a.pause();
      })
      .catch(() => {
        // まだ許されていない。次のタップでまた試す
      });
  }

  /** 3桁の音を前もって作っておく（長押しの瞬間に作り始めると間に合わないことがある） */
  async prepare(code: string, protocol: SoundProtocol = SOUND_PROTOCOL, volume = SOUND_VOLUME): Promise<string> {
    const key = `${protocol}:${volume}:${code}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const codec = await getCodec();
    const rate = 48_000;
    const data = codec.encode(soundPayload(code), protocol, volume, rate);
    // 3桁のあとに少し間をあけて、繰り返し鳴らす（loop）。聞こえる3音のフレーズを重ねる
    const withGap = new Float32Array(data.length + Math.round((rate * SOUND_GAP_MS) / 1000));
    withGap.set(data);
    const mixed = SOUND_MELODY_GAIN > 0 ? mixMelody(withGap, code, rate, SOUND_MELODY_GAIN) : withGap;
    const url = URL.createObjectURL(wavBlob(mixed, rate));
    this.urls.set(key, url);
    return url;
  }

  /** 長押しの押し始めで呼ぶ。音がまだ作れていなければ、作れた瞬間に鳴り始める */
  start(code: string, protocol: SoundProtocol = SOUND_PROTOCOL, volume = SOUND_VOLUME): void {
    const a = this.audio;
    if (!a) return;
    this.want = true;
    const key = `${protocol}:${volume}:${code}`;
    const play = (url: string) => {
      if (!this.want) return;
      if (this.current !== url) {
        a.src = url;
        this.current = url;
      }
      a.currentTime = 0;
      a.play()
        .then(() => {
          this.unlocked = true;
        })
        .catch(() => {
          // タップの直後でないと鳴らせない端末。画面に「音を試す」を出して、そこで unlock してもらう
        });
    };
    const ready = this.urls.get(key);
    if (ready) play(ready);
    else void this.prepare(code, protocol, volume).then(play).catch(() => undefined);
  }

  stop(): void {
    this.want = false;
    if (!this.audio) return;
    this.audio.pause();
  }

  get playing(): boolean {
    return this.want && !!this.audio && !this.audio.paused;
  }
}

/** 16bit・1チャンネルの WAV にする */
export function wavBlob(samples: Float32Array, rate: number): Blob {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
