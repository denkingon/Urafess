import type { SenseState } from '../shared/protocol';
import { RunDetector, RunLatch, type RunParams, type RunPos, type RunReading } from '../shared/run';

/**
 * 走ると光る：スマホのセンサー（動き・方角・位置）。見た目は持たない。
 *
 * - 動き（devicemotion）：走っているかを決める。iPhone はタップの中で許可を聞く（DeviceMotionEvent.requestPermission）
 * - 方角（deviceorientation）：光の地図を、自分の向いている方が上になるよう回す。取れなければ北が上
 * - 位置（geolocation.watchPosition）：地図の真ん中（自分）と、光っている間に送る位置。配役〜ゲームの終わりだけ見る
 *
 * 許可を聞くのは「走ると光るをオンにする」を押したときだけ（いきなり許可の画面を出さない）。
 * Android の動きのセンサーと、前に許可した位置は、押さなくても使う
 */

export type AskState = SenseState | 'asking';

export interface GeoFix extends RunPos {
  /** 受け取ったスマホの時刻 */
  at: number;
}

/** 動きのセンサーの最初の値を待つ長さ。来なければ「このスマホには無い」 */
const MOTION_PROBE_MS = 3_000;
/** 方角がこれだけ来なければ、北を上にする */
const HEADING_STALE_MS = 2_000;
/** 送る位置の古さの上限（光っている間は動いているので、位置は次々に届く） */
const FIX_SEND_MAX_MS = 5_000;
/** 地図の真ん中に使う位置の古さの上限（止まっているスマホは位置を出し直さないことがある） */
const FIX_SHOW_MAX_MS = 60_000;
/** 位置の誤差がこれより大きいときは送らない（場所が出ても意味がない） */
const FIX_SEND_ACC_MAX = 100;

type PermissionFn = () => Promise<'granted' | 'denied' | 'default'>;

function requestPermissionOf(ctor: unknown): PermissionFn | null {
  const fn = (ctor as { requestPermission?: PermissionFn } | undefined)?.requestPermission;
  return typeof fn === 'function' ? fn.bind(ctor) : null;
}

const RAD = Math.PI / 180;

/**
 * 方角（北から時計回りの度）。iPhone は webkitCompassHeading、Android は向きの絶対値（alpha・beta・gamma）から、
 * 画面の上の向きと背中の向きを水平に落として足したもの（寝かせても立てても、持っている人の前の方角になる）
 */
export function headingOf(e: { alpha: number | null; beta: number | null; gamma: number | null; absolute?: boolean; webkitCompassHeading?: number }): number | null {
  const ios = e.webkitCompassHeading;
  if (typeof ios === 'number' && Number.isFinite(ios) && ios >= 0) return ios % 360;
  if (!e.absolute || e.alpha == null || e.beta == null || e.gamma == null) return null;
  const a = e.alpha * RAD;
  const b = e.beta * RAD;
  const g = e.gamma * RAD;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  // 画面の上の向き（東・北）
  const topE = -sA * cB;
  const topN = cA * cB;
  // 背中（カメラ）の向き
  const backE = -cA * sG - sA * sB * cG;
  const backN = -sA * sG + cA * sB * cG;
  const e2 = topE + backE;
  const n2 = topN + backN;
  if (Math.hypot(e2, n2) < 0.2) return null;
  return (Math.atan2(e2, n2) / RAD + 360) % 360;
}

export class Sensors {
  motion: AskState = 'off';
  geo: AskState = 'off';
  compass: AskState = 'off';
  readonly detector: RunDetector;
  readonly latch = new RunLatch();
  /** 一度「オンにする」を押した（このページを開いている間は、次のラウンドからも自動でつける） */
  asked = false;
  private active = false;
  private watchId: number | null = null;
  private motionOn = false;
  private orientOn = false;
  private fix: GeoFix | null = null;
  private hx = 0;
  private hy = 0;
  private headingAt = -Infinity;
  private geoGranted = false;
  private readonly listeners = new Set<() => void>();

  constructor(params: Partial<RunParams> = {}) {
    this.detector = new RunDetector(params);
    // 画面に戻ったら位置の見張りを張り直す（iPhone は裏にいる間の見張りが戻らないことがあるため）
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || this.watchId === null) return;
        this.stopGeo();
        this.startGeo();
      });
    }
    // 前に位置を許可していれば、押さなくても使える（許可の画面は出ない）
    try {
      void navigator.permissions
        ?.query({ name: 'geolocation' as PermissionName })
        .then((p) => {
          this.geoGranted = p.state === 'granted';
          if (this.geoGranted && this.active) this.startGeo();
          p.onchange = () => {
            this.geoGranted = p.state === 'granted';
            if (p.state === 'denied') this.setGeo('denied');
          };
        })
        .catch(() => undefined);
    } catch {
      // 聞けない端末は押してもらう
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** iPhone の動きのセンサーは、押してもらわないと使えない */
  get motionNeedsTap(): boolean {
    return typeof DeviceMotionEvent !== 'undefined' && requestPermissionOf(DeviceMotionEvent) !== null;
  }

  /** 「オンにする」を出すか：まだ押しておらず、押さないと使えないものがある */
  get needsTap(): boolean {
    if (this.asked) return false;
    const motionMissing = this.motion === 'off' && this.motionNeedsTap;
    const geoMissing = this.geo === 'off';
    return motionMissing || geoMissing;
  }

  /** 走りを決められるか（動きのセンサーか位置のどちらか） */
  get canDetect(): boolean {
    return this.motion === 'ok' || this.geo === 'ok';
  }

  /** タップの中で呼ぶ。許可を聞いて、使えるものから使い始める */
  request(): void {
    this.asked = true;
    // iPhone：許可を聞く関数は、タップの処理の中で（await の前に）呼ばないと断られる
    const motionAsk = typeof DeviceMotionEvent !== 'undefined' ? requestPermissionOf(DeviceMotionEvent) : null;
    const orientAsk = typeof DeviceOrientationEvent !== 'undefined' ? requestPermissionOf(DeviceOrientationEvent) : null;
    if (motionAsk) {
      this.setMotion('asking');
      motionAsk()
        .then((r) => (r === 'granted' ? this.startMotion() : this.setMotion('denied')))
        .catch(() => this.setMotion('error'));
    } else {
      this.startMotion();
    }
    if (orientAsk) {
      orientAsk()
        .then((r) => (r === 'granted' ? this.startOrientation() : (this.compass = 'denied')))
        .catch(() => (this.compass = 'error'));
    } else {
      this.startOrientation();
    }
    this.geoGranted = true;
    this.startGeo(true);
  }

  /** 配役〜ゲームの終わりだけ見る。それ以外は位置を見るのをやめる（電池のため） */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      // 許可の要らないもの・前に許可したものは、押さなくても始める
      if (!this.motionNeedsTap || this.asked) this.startMotion();
      if (this.asked || typeof DeviceOrientationEvent === 'undefined' || requestPermissionOf(DeviceOrientationEvent) === null) this.startOrientation();
      if (this.asked || this.geoGranted) this.startGeo();
    } else {
      this.stopGeo();
      this.stopMotion();
      this.stopOrientation();
      this.latch.reset();
    }
  }

  /** 今の時刻で、走っているか（光る・消えるの待ちつき）を決め直す */
  tick(now: number): boolean {
    if (!this.active) return false;
    return this.latch.update(now, this.detector.read(now).running);
  }

  get lit(): boolean {
    return this.latch.lit;
  }

  read(now: number): RunReading {
    return this.detector.read(now);
  }

  /** 地図の真ん中に使う自分の位置（古すぎれば null） */
  position(now: number): GeoFix | null {
    return this.fix && now - this.fix.at <= FIX_SHOW_MAX_MS ? this.fix : null;
  }

  /** 光っている間に送る位置（新しく、誤差が大きすぎないものだけ） */
  sendPos(now: number): RunPos | null {
    const f = this.fix;
    if (!f || now - f.at > FIX_SEND_MAX_MS || f.acc > FIX_SEND_ACC_MAX) return null;
    return { lat: f.lat, lon: f.lon, acc: f.acc };
  }

  /** 向いている方角（取れなければ null＝北が上） */
  heading(now: number): number | null {
    if (now - this.headingAt > HEADING_STALE_MS) return null;
    return (Math.atan2(this.hx, this.hy) / RAD + 360) % 360;
  }

  /** サーバーに知らせる形（聞いている途中は「まだ」） */
  report(): { motion: SenseState; geo: SenseState } {
    const f = (s: AskState): SenseState => (s === 'asking' ? 'off' : s);
    return { motion: f(this.motion), geo: f(this.geo) };
  }

  // ---------- 動き ----------

  private readonly onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    this.detector.addMotion(Date.now(), a.x, a.y, a.z);
    if (this.motion !== 'ok') this.setMotion('ok');
  };

  private startMotion(): void {
    if (this.motionOn) return;
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
      this.setMotion('unsupported');
      return;
    }
    this.motionOn = true;
    window.addEventListener('devicemotion', this.onMotion);
    if (this.motion !== 'ok') {
      this.setMotion('asking');
      // パソコンなど：イベントは来ても値が空（または来ない）
      setTimeout(() => {
        if (this.motionOn && this.motion === 'asking') this.setMotion('unsupported');
      }, MOTION_PROBE_MS);
    }
  }

  private stopMotion(): void {
    if (!this.motionOn) return;
    this.motionOn = false;
    window.removeEventListener('devicemotion', this.onMotion);
  }

  private setMotion(s: AskState): void {
    if (this.motion === s) return;
    this.motion = s;
    this.emit();
  }

  // ---------- 方角 ----------

  private readonly onOrient = (e: DeviceOrientationEvent) => {
    const h = headingOf(e as DeviceOrientationEvent & { webkitCompassHeading?: number });
    if (h === null) return;
    const now = Date.now();
    const r = h * RAD;
    // 円の上でなめらかにする（359°→1° を逆回りしない）。久しぶりなら、いきなりその向きにする
    const k = now - this.headingAt > HEADING_STALE_MS ? 1 : 0.25;
    this.hx = this.hx * (1 - k) + Math.sin(r) * k;
    this.hy = this.hy * (1 - k) + Math.cos(r) * k;
    this.headingAt = now;
    if (this.compass !== 'ok') this.compass = 'ok';
  };

  private startOrientation(): void {
    if (this.orientOn || typeof window === 'undefined') return;
    this.orientOn = true;
    // Android の Chrome は北を基準にした向きを deviceorientationabsolute で出す。iPhone は deviceorientation に方角が付く
    window.addEventListener('deviceorientationabsolute', this.onOrient as EventListener);
    window.addEventListener('deviceorientation', this.onOrient as EventListener);
  }

  private stopOrientation(): void {
    if (!this.orientOn) return;
    this.orientOn = false;
    window.removeEventListener('deviceorientationabsolute', this.onOrient as EventListener);
    window.removeEventListener('deviceorientation', this.onOrient as EventListener);
  }

  // ---------- 位置 ----------

  private startGeo(fromTap = false): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      this.setGeo('unsupported');
      return;
    }
    if (this.watchId !== null) return;
    if (!this.active && !fromTap) return;
    if (this.geo !== 'ok') this.setGeo('asking');
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        const fix: GeoFix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, at: Date.now() };
        this.fix = fix;
        this.detector.addFix({ t: fix.at, lat: fix.lat, lon: fix.lon, acc: fix.acc, speed: c.speed });
        if (this.geo !== 'ok') this.setGeo('ok');
        else this.emit();
      },
      (err) => {
        if (err.code === 1) {
          this.stopGeo();
          this.setGeo('denied');
        } else if (this.geo !== 'ok' || !this.fix || Date.now() - this.fix.at > FIX_SHOW_MAX_MS) {
          // 取れない（屋内・電波）。見張りは続ける
          this.setGeo('error');
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
    // 押したときに始めたが、まだ配役の前（待合室）なら、許可の画面が出たあとで止める
    if (fromTap && !this.active) {
      setTimeout(() => {
        if (!this.active) this.stopGeo();
      }, 20_000);
    }
  }

  private stopGeo(): void {
    if (this.watchId === null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private setGeo(s: AskState): void {
    if (this.geo === s) return;
    this.geo = s;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
