/**
 * サーバーとの時計のずれを測る。
 * スマホが自分の時計で a に問い合わせ、サーバーが自分の時計の s を返し、スマホが b に受け取ったとき
 *   ずれ θ = s − (a + b) / 2
 * 行きと帰りが同じ時間なら、サーバーが s を返したのは往復のちょうど真ん中。
 * 誤差は最大で往復の半分なので、往復が一番短かった回を使う。
 */

export interface ClockSample {
  offset: number;
  rtt: number;
  /** 測った時刻（スマホの時計） */
  at: number;
}

export interface ClockEstimatorOptions {
  /** これより長い往復は捨てる */
  maxRttMs?: number;
  /** この時間より古い測定は使わない（スマホの時計も少しずつずれるため） */
  windowMs?: number;
  /** 持っておく測定の数 */
  maxSamples?: number;
}

export class ClockEstimator {
  private samples: ClockSample[] = [];
  private readonly maxRttMs: number;
  private readonly windowMs: number;
  private readonly maxSamples: number;

  constructor(options: ClockEstimatorOptions = {}) {
    this.maxRttMs = options.maxRttMs ?? 5_000;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.maxSamples = options.maxSamples ?? 40;
  }

  /** a: 送った時刻、s: サーバーの時刻、b: 受け取った時刻（a と b はスマホの時計） */
  add(a: number, s: number, b: number): ClockSample | null {
    const rtt = b - a;
    if (!(rtt >= 0) || rtt > this.maxRttMs || !Number.isFinite(s)) return null;
    const sample = { offset: s - (a + b) / 2, rtt, at: b };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return sample;
  }

  private best(now?: number): ClockSample | null {
    const latest = now ?? this.samples[this.samples.length - 1]?.at;
    if (latest === undefined) return null;
    let best: ClockSample | null = null;
    for (const s of this.samples) {
      if (latest - s.at > this.windowMs) continue;
      if (!best || s.rtt < best.rtt) best = s;
    }
    return best ?? this.samples[this.samples.length - 1] ?? null;
  }

  /** サーバー時刻 ≒ スマホの時計 + offset */
  offset(now?: number): number | null {
    return this.best(now)?.offset ?? null;
  }

  /** 誤差の上限（往復の半分） */
  errorBound(now?: number): number | null {
    const b = this.best(now);
    return b ? b.rtt / 2 : null;
  }

  /** スマホの時計が飛んだ疑いがあるときは測り直す */
  reset(): void {
    this.samples = [];
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}
