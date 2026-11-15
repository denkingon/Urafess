import { wavBlob } from './emitter';

/**
 * 捕まったときの全員への知らせの音（確保の音）。
 *
 * - <audio> で鳴らす。iPhone の消音スイッチが入っていても鳴る（Web Audio は消音スイッチで消える）
 * - スマホは「画面に触れた直後」でないと音を出させてくれない。それより前のどこかのタップで一度だけ無音を鳴らしておく（unlock）。
 *   一度鳴らした <audio> は、以後タップなしで鳴らせる（捕獲の番号の音と同じ）
 * - 音は聞こえる帯（1〜3kHz）だけで作る。番号を運ぶ超音波（15kHz より上）に混ざらない
 */

export type ChimeKind = 'capture' | 'release' | 'test';

const RATE = 48_000;

type Note = { f: number; ms: number; gap: number };

/** 確保：ピロッ↓ピロッ↓ を2回（ポケットの中でも気づくように） */
const CAPTURE: Note[] = [
  { f: 1568, ms: 90, gap: 25 },
  { f: 1047, ms: 90, gap: 25 },
  { f: 1568, ms: 90, gap: 25 },
  { f: 1047, ms: 170, gap: 160 },
  { f: 1568, ms: 90, gap: 25 },
  { f: 1047, ms: 90, gap: 25 },
  { f: 1568, ms: 90, gap: 25 },
  { f: 1047, ms: 220, gap: 0 },
];

/** 取り消し：ゆっくり上がる2音（確保の音と聞き分けられるように） */
const NOTES: Record<ChimeKind, Note[]> = {
  capture: CAPTURE,
  release: [
    { f: 1047, ms: 140, gap: 40 },
    { f: 1568, ms: 200, gap: 0 },
  ],
  test: CAPTURE,
};

const GAIN: Record<ChimeKind, number> = { capture: 0.7, release: 0.45, test: 0.7 };

/** 音の波形（テストでも使う）。silent は unlock 用の無音 */
export function chimeSamples(kind: ChimeKind | 'silent', rate = RATE): Float32Array {
  if (kind === 'silent') return new Float32Array(Math.round(rate * 0.1));
  const notes = NOTES[kind];
  const total = notes.reduce((s, n) => s + n.ms + n.gap, 0) + 30;
  const out = new Float32Array(Math.round((rate * total) / 1000));
  let at = 0;
  for (const n of notes) {
    const start = Math.round((rate * at) / 1000);
    const len = Math.round((rate * n.ms) / 1000);
    const attack = Math.round(rate * 0.004);
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / rate;
      // 立ち上がり4ms、あとは少しずつ減る（クリックしないよう、終わりの5msで0へ）
      const env = Math.min(1, i / attack) * Math.exp((-3 * i) / len) * Math.min(1, (len - i) / (rate * 0.005));
      // 基音と2倍音だけ（高い倍音を作らない＝超音波の帯に音を出さない）
      const x = Math.sin(2 * Math.PI * n.f * t) + 0.25 * Math.sin(4 * Math.PI * n.f * t);
      out[start + i] += (GAIN[kind] / 1.25) * env * x;
    }
    at += n.ms + n.gap;
  }
  return out;
}

export class AnnounceChime {
  private readonly audio: HTMLAudioElement | null;
  private readonly urls = new Map<string, string>();
  /** いま入っている音（unlock の無音か、知らせの音か） */
  private current: string | null = null;
  /** 一度でも鳴らせた（＝以後はタップなしで鳴らせる） */
  unlocked = false;

  constructor() {
    this.audio = typeof Audio === 'undefined' ? null : new Audio();
    if (this.audio) {
      this.audio.preload = 'auto';
      this.audio.setAttribute('playsinline', '');
    }
  }

  private url(kind: ChimeKind | 'silent'): string {
    let u = this.urls.get(kind);
    if (!u) {
      u = URL.createObjectURL(wavBlob(chimeSamples(kind), RATE));
      this.urls.set(kind, u);
    }
    return u;
  }

  /** タップの直後に呼ぶ。まだなら無音を一瞬鳴らして、以後タップなしで鳴らせるようにする */
  unlock(): void {
    const a = this.audio;
    if (!a || this.unlocked) return;
    const silent = this.url('silent');
    // 知らせの音を鳴らしている最中は入れ替えない
    if (this.current && this.current !== silent && !a.paused) return;
    a.src = silent;
    this.current = silent;
    a.play()
      .then(() => {
        this.unlocked = true;
        if (this.current === silent) a.pause();
      })
      .catch(() => {
        // まだ許されていない。次のタップでまた試す
      });
  }

  /** 知らせの音を1回鳴らす */
  play(kind: ChimeKind): void {
    const a = this.audio;
    if (!a) return;
    const u = this.url(kind);
    if (this.current !== u) {
      a.src = u;
      this.current = u;
    }
    try {
      a.currentTime = 0;
    } catch {
      // 読み込み前は動かせない端末がある。頭から鳴る
    }
    a.play()
      .then(() => {
        this.unlocked = true;
      })
      .catch(() => {
        // まだタップされていない端末。帯だけ出る（主催者の「試す」のあとに、画面に一度触れてもらう）
      });
  }
}
