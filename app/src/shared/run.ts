import {
  RUN_ACCURACY_MAX,
  RUN_CADENCE_MIN,
  RUN_PEAK_MIN,
  RUN_PEAK_RELEASE,
  RUN_SEND_EVERY_MS,
  RUN_SPEED_MIN,
  RUN_START_MS,
  RUN_STEPS_MIN,
  RUN_STOP_MS,
  RUN_WINDOW_MS,
} from './rules';

/**
 * 走ると光る：走っているかを決めるしくみ（スマホの中で動く。サーバーにもテストにも同じものを使う）。
 *
 * 動きのセンサー（重力込みの加速度の大きさ）を見て、強い揺れ1回＝1歩と数える。
 * ここ RUN_WINDOW_MS の1歩が RUN_STEPS_MIN 以上・テンポが RUN_CADENCE_MIN 以上・最後の1歩が今に近ければ「走り」。
 * 動きのセンサーが届いていないスマホは、位置の速さ（RUN_SPEED_MIN 以上が2回続く）で決める。
 * 光る・消えるは RunLatch で少し待ってから切り替える（一瞬の跳ね・一瞬の止まりで点滅しない）。
 */

export interface RunParams {
  windowMs: number;
  stepsMin: number;
  cadenceMin: number;
  peakMin: number;
  peakRelease: number;
  speedMin: number;
  accuracyMax: number;
}

export const RUN_PARAMS: RunParams = {
  windowMs: RUN_WINDOW_MS,
  stepsMin: RUN_STEPS_MIN,
  cadenceMin: RUN_CADENCE_MIN,
  peakMin: RUN_PEAK_MIN,
  peakRelease: RUN_PEAK_RELEASE,
  speedMin: RUN_SPEED_MIN,
  accuracyMax: RUN_ACCURACY_MAX,
};

/** 位置1回（緯度・経度・誤差の半径 m・速さ m/s。速さはスマホが出さなければ null） */
export interface Fix {
  t: number;
  lat: number;
  lon: number;
  acc: number;
  speed: number | null;
}

export interface RunReading {
  /** 動きのセンサーの値が届いている（最後の値が1秒以内） */
  motion: boolean;
  /** ここ windowMs の1歩の数・テンポ（1秒あたり）・1歩の強さの平均（m/s²） */
  steps: number;
  cadence: number;
  peak: number;
  /** いまの揺れの大きさ（m/s²、少しなめらかにしたもの） */
  level: number;
  /** 位置の速さ（m/s。分からなければ null）と、そのときの位置の誤差（m） */
  speed: number | null;
  accuracy: number | null;
  /** 瞬間の判定（光る・消えるの待ちの前） */
  running: boolean;
  /** 判定に使ったもの */
  by: 'motion' | 'gps' | null;
}

/** 動きのセンサーが止まったとみなすまで */
const MOTION_FRESH_MS = 1_000;
/** 1歩と1歩の間の最小（これより近い強い揺れは同じ1歩） */
const STEP_MIN_GAP_MS = 220;
/** 最後の1歩が、平均の間隔のこれだけ倍より古ければ、もう走っていない（ただし最低 600ms は待つ） */
const STEP_RECENT_FACTOR = 1.5;
const STEP_RECENT_MIN_MS = 600;
/** 位置は最後のものが3秒以内なら使う */
const FIX_FRESH_MS = 3_000;
/** 速さを位置の差から出すときに使う、前の位置の古さ（短いと誤差に負ける） */
const DERIVE_MIN_MS = 2_500;
const DERIVE_MAX_MS = 6_000;

export class RunDetector {
  params: RunParams;
  private smooth: number | null = null;
  private lastMotionAt = -Infinity;
  /** 揺れが peakMin を超えている途中なら、その中のいちばん強い所 */
  private rising: { t: number; v: number } | null = null;
  private steps: { t: number; v: number }[] = [];
  private fixes: Fix[] = [];
  /** 試し（/lab）の波形用：最近の揺れ（なめらかにしたもの）と、数えた1歩 */
  private recent: { t: number; v: number }[] = [];
  private recentSteps: { t: number; v: number }[] = [];
  keepTraceMs = 0;

  constructor(params: Partial<RunParams> = {}) {
    this.params = { ...RUN_PARAMS, ...params };
  }

  /** 動きのセンサーの値（重力込みの加速度 m/s²）。t はミリ秒 */
  addMotion(t: number, x: number | null | undefined, y: number | null | undefined, z: number | null | undefined): void {
    if (x == null || y == null || z == null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const m = Math.sqrt(x * x + y * y + z * z);
    // センサーのざらつきだけを少し落とす（1歩の山はつぶさない）
    this.smooth = this.smooth === null ? m : this.smooth * 0.5 + m * 0.5;
    this.lastMotionAt = t;
    const v = this.smooth;
    if (this.keepTraceMs > 0) {
      this.recent.push({ t, v });
      while (this.recent.length > 0 && t - this.recent[0].t > this.keepTraceMs) this.recent.shift();
    }
    const p = this.params;
    if (this.rising) {
      if (v > this.rising.v) this.rising = { t, v };
      if (v < Math.min(p.peakRelease, p.peakMin - 1)) {
        this.pushStep(this.rising);
        this.rising = null;
      }
    } else if (v >= p.peakMin) {
      this.rising = { t, v };
    }
    this.trim(t);
  }

  addFix(fix: Fix): void {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.acc)) return;
    const last = this.fixes[this.fixes.length - 1];
    if (last && fix.t <= last.t) return;
    this.fixes.push({ ...fix, speed: fix.speed != null && Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null });
    while (this.fixes.length > 0 && fix.t - this.fixes[0].t > DERIVE_MAX_MS * 2) this.fixes.shift();
  }

  /** 最後の位置（古くても返す） */
  lastFix(): Fix | null {
    return this.fixes[this.fixes.length - 1] ?? null;
  }

  read(now: number): RunReading {
    const p = this.params;
    this.trim(now);
    const motion = now - this.lastMotionAt <= MOTION_FRESH_MS;
    const steps = this.steps;
    let cadence = 0;
    let peak = 0;
    if (steps.length >= 2) {
      const span = (steps[steps.length - 1].t - steps[0].t) / 1000;
      cadence = span > 0 ? (steps.length - 1) / span : 0;
    }
    if (steps.length > 0) peak = steps.reduce((s, x) => s + x.v, 0) / steps.length;
    let recent = false;
    if (steps.length > 0) {
      const last = steps[steps.length - 1].t;
      const gap = cadence > 0 ? 1000 / cadence : STEP_RECENT_MIN_MS;
      recent = now - last <= Math.max(STEP_RECENT_MIN_MS, gap * STEP_RECENT_FACTOR);
    }
    const motionRunning = motion && steps.length >= p.stepsMin && cadence >= p.cadenceMin && recent;

    const sp = this.speeds(now);
    const latest = sp[sp.length - 1] ?? null;
    const gpsRunning =
      sp.length >= 2 &&
      sp.slice(-2).every((s) => s.speed >= p.speedMin && s.acc <= p.accuracyMax) &&
      sp[sp.length - 1].t - sp[sp.length - 2].t <= FIX_FRESH_MS;

    const by = motion ? 'motion' : latest ? 'gps' : null;
    return {
      motion,
      steps: steps.length,
      cadence,
      peak,
      level: this.smooth ?? 0,
      speed: latest ? latest.speed : null,
      accuracy: latest ? latest.acc : null,
      running: motion ? motionRunning : gpsRunning,
      by,
    };
  }

  /** 新しい順に2つまでの、位置ごとの速さ（最後の位置が古ければ空） */
  private speeds(now: number): { t: number; speed: number; acc: number }[] {
    const f = this.fixes;
    const last = f[f.length - 1];
    if (!last || now - last.t > FIX_FRESH_MS) return [];
    const out: { t: number; speed: number; acc: number }[] = [];
    for (let i = f.length - 1; i >= 0 && out.length < 2; i--) {
      const s = this.speedOf(i);
      if (s !== null) out.unshift({ t: f[i].t, speed: s.speed, acc: s.acc });
      else if (out.length === 0) break;
    }
    return out;
  }

  /** i 番目の位置での速さ：スマホが出した速さ、無ければ少し前の位置との差から */
  private speedOf(i: number): { speed: number; acc: number } | null {
    const f = this.fixes[i];
    if (f.speed !== null) return { speed: f.speed, acc: f.acc };
    for (let j = i - 1; j >= 0; j--) {
      const dt = f.t - this.fixes[j].t;
      if (dt < DERIVE_MIN_MS) continue;
      if (dt > DERIVE_MAX_MS) break;
      return { speed: distanceM(this.fixes[j], f) / (dt / 1000), acc: Math.max(f.acc, this.fixes[j].acc) };
    }
    return null;
  }

  private pushStep(s: { t: number; v: number }): void {
    const last = this.steps[this.steps.length - 1];
    if (last && s.t - last.t < STEP_MIN_GAP_MS) {
      if (s.v > last.v) this.steps[this.steps.length - 1] = s;
      return;
    }
    this.steps.push(s);
    if (this.keepTraceMs > 0) {
      this.recentSteps.push(s);
      while (this.recentSteps.length > 0 && s.t - this.recentSteps[0].t > this.keepTraceMs) this.recentSteps.shift();
    }
  }

  /** 試し（/lab）の波形：keepTraceMs を 0 より大きくしておくと、その長さだけ残る */
  trace(): { samples: readonly { t: number; v: number }[]; steps: readonly { t: number; v: number }[] } {
    return { samples: this.recent, steps: this.recentSteps };
  }

  private trim(now: number): void {
    const from = now - this.params.windowMs;
    while (this.steps.length > 0 && this.steps[0].t < from) this.steps.shift();
  }
}

/** 光る・消えるを少し待ってから切り替える（瞬間の判定の点滅を消す） */
export class RunLatch {
  lit = false;
  private since: number | null = null;
  private lastRaw = -Infinity;

  constructor(
    private readonly startMs = RUN_START_MS,
    private readonly stopMs = RUN_STOP_MS,
  ) {}

  update(now: number, raw: boolean): boolean {
    if (raw) {
      this.since ??= now;
      this.lastRaw = now;
      if (!this.lit && now - this.since >= this.startMs) this.lit = true;
    } else if (!this.lit) {
      this.since = null;
    } else if (now - this.lastRaw >= this.stopMs) {
      this.lit = false;
      this.since = null;
    }
    return this.lit;
  }

  reset(): void {
    this.lit = false;
    this.since = null;
    this.lastRaw = -Infinity;
  }
}

export interface RunPos {
  lat: number;
  lon: number;
  acc: number;
}

export type RunSend = { on: true; pos: RunPos | null } | { on: false };

/**
 * いつ送るか：光っている間（かつ光ってよい段階）は RUN_SEND_EVERY_MS ごとに「走っている＋位置」、
 * 光らなくなったら1回だけ「止まった」。送るものがなければ null
 */
export class RunReporter {
  private sending = false;
  private lastSentAt = -Infinity;

  constructor(private readonly everyMs = RUN_SEND_EVERY_MS) {}

  next(now: number, lit: boolean, open: boolean, pos: RunPos | null): RunSend | null {
    if (lit && open) {
      if (this.sending && now - this.lastSentAt < this.everyMs) return null;
      this.sending = true;
      this.lastSentAt = now;
      return { on: true, pos };
    }
    if (!this.sending) return null;
    this.sending = false;
    return { on: false };
  }

  get active(): boolean {
    return this.sending;
  }
}

// ---------- 位置の計算（キャンパスの中くらいの距離なら平らとみなしてよい） ----------

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** origin から見た p の位置（東へ m、北へ m） */
export function offsetM(origin: LatLon, p: LatLon): { east: number; north: number } {
  return {
    east: (p.lon - origin.lon) * RAD * EARTH_M * Math.cos(((origin.lat + p.lat) / 2) * RAD),
    north: (p.lat - origin.lat) * RAD * EARTH_M,
  };
}

export function distanceM(a: LatLon, b: LatLon): number {
  const o = offsetM(a, b);
  return Math.hypot(o.east, o.north);
}

/** origin から見た p の方角（北から時計回りの度、0〜360） */
export function bearingDeg(origin: LatLon, p: LatLon): number {
  const o = offsetM(origin, p);
  return (Math.atan2(o.east, o.north) / RAD + 360) % 360;
}

const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const;

/** 方角を8方位の言葉に */
export function compassName(deg: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** 距離の言葉（10m 単位。近いと「すぐ近く」） */
export function distanceText(m: number): string {
  if (m < 15) return 'すぐ近く';
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ---------- 光の地図（自分が真ん中） ----------

/** 輪の距離（m）。いちばん外の縁が RADAR_MAX_M */
export const RADAR_RINGS_M = [50, 100, 200] as const;
export const RADAR_MAX_M = 400;
/** ここより近いところは広く、遠いところは縮めて描く（近くの人ほど細かく見える） */
const RADAR_KNEE_M = 25;

/** 距離 d（m）を、地図の半径に対する割合（0〜1）にする。RADAR_MAX_M より遠い人は縁に置く */
export function radarRadius(d: number): number {
  return Math.min(1, Math.log1p(Math.max(0, d) / RADAR_KNEE_M) / Math.log1p(RADAR_MAX_M / RADAR_KNEE_M));
}
