import type { AskState, Sensors } from './sense';
import type { MicPermission, MicState, SoundListener } from './sound/listener';
import type { Pair } from './ui';

/**
 * スマホの許可（動き・方角・位置・マイク）を、最初に1回のタップでまとめてもらう。見た目は持たない（バナーは views/perm.ts）。
 *
 * - 前は、走ると光る（動きと位置）・鬼のマイク・牢屋のマイクが、それぞれ要る場面で別々の板を出していた。
 *   いまは入室してすぐの1枚のバナーだけ。押すと OS の確認が順に出る（動き → マイク → 位置）
 * - マイクは全員に聞く（役は配役まで分からない。逃走者も牢屋で使う）。許可だけもらってすぐ閉じ、
 *   要る場面（鬼の配役〜ゲーム、牢屋）になったら押さなくても開く
 * - 断られた・止まったときも、同じバナーが理由を変えて出る（別の板は出さない）
 */

export type PermItem = 'motion' | 'geo' | 'mic';

export interface PermSnapshot {
  /** バナーを一度押した（このページを開いている間） */
  asked: boolean;
  /** OS の確認が出ている途中 */
  busy: boolean;
  motion: AskState;
  /** iPhone：動きのセンサーは押してもらわないと使えない */
  motionNeedsTap: boolean;
  geo: AskState;
  /** 位置は前に許可されていると分かっている */
  geoAllowed: boolean;
  mic: MicPermission;
  micState: MicState;
  micLive: boolean;
  micSilent: boolean;
  /** いまマイクが要る（鬼の配役〜ゲームの終わり、牢屋の中） */
  wantMic: boolean;
}

export interface PermBanner {
  /** ask＝最初のお願い、asking＝確認が出ている途中、denied＝断られたものがある、fix＝マイクが止まった */
  kind: 'ask' | 'asking' | 'denied' | 'fix';
  head: Pair;
  sub: Pair;
  /** 押せるか */
  usable: boolean;
  /** 小さく出す（最初のお願いより後） */
  compact: boolean;
}

const NAME: Record<PermItem, Pair> = { motion: ['動き', 'motion'], geo: ['位置', 'location'], mic: ['マイク', 'mic'] };

const list = (items: PermItem[]): Pair => [items.map((i) => NAME[i][0]).join('・'), items.map((i) => NAME[i][1]).join(', ')];

/** まだ許可をもらっていないもの（最初のバナーに並べる） */
export function permMissing(s: PermSnapshot): PermItem[] {
  const out: PermItem[] = [];
  if (s.motionNeedsTap && s.motion !== 'ok') out.push('motion');
  if (!s.geoAllowed && s.geo !== 'ok' && s.geo !== 'unsupported') out.push('geo');
  if (s.mic === 'unknown') out.push('mic');
  return out;
}

/** 断られたもの */
export function permDenied(s: PermSnapshot): PermItem[] {
  const out: PermItem[] = [];
  if (s.motion === 'denied') out.push('motion');
  if (s.geo === 'denied') out.push('geo');
  if (s.mic === 'denied') out.push('mic');
  return out;
}

/** いま出すバナー（出さなくてよければ null）。出すのはいつも1枚だけ */
export function permBanner(s: PermSnapshot): PermBanner | null {
  if (s.busy) {
    return { kind: 'asking', head: ['許可を聞いている…', 'ASKING…'], sub: ['出てくる確認は、全部「許可」を押す', 'Tap "Allow" on every prompt'], usable: false, compact: false };
  }
  const missing = s.asked ? [] : permMissing(s);
  if (missing.length) {
    const [ja, en] = list(missing);
    return {
      kind: 'ask',
      head: ['スマホの許可をもらう', 'ALLOW ALL'],
      sub: [`${ja}を使う。全部「許可」`, `${en[0].toUpperCase()}${en.slice(1)}. Tap "Allow" on each`],
      usable: true,
      compact: false,
    };
  }
  // 断られたもの：押したあとだけ出す（マイクは、要る場面になったら押す前でも出す）
  const denied = permDenied(s).filter((i) => s.asked || (i === 'mic' && s.wantMic));
  if (denied.length) {
    const [ja] = list(denied);
    return {
      kind: 'denied',
      head: [`${ja}の許可がない`, 'NOT ALLOWED'],
      sub: ['押して聞き直す。だめなら設定で許可', 'Tap to retry, or allow in Settings'],
      usable: true,
      compact: true,
    };
  }
  if (s.wantMic && !s.micLive && s.mic !== 'unsupported' && s.micState !== 'unsupported') {
    if (s.micState === 'starting') {
      return { kind: 'asking', head: ['マイクを準備中…', 'STARTING MIC'], sub: ['確認が出たら「許可」を押す', 'Tap "Allow" if asked'], usable: false, compact: true };
    }
    if (s.micSilent) {
      return { kind: 'fix', head: ['マイクに音が来ていない', 'NO SOUND ON MIC'], sub: ['押して開き直す。直らなければアプリを開き直す', 'Tap to reopen. If that fails, reopen the app'], usable: true, compact: true };
    }
    // 許可はあるのに開いていない：自分で開き直している途中（tick）。少し待っても開かないときだけ、押してもらう
    return { kind: 'fix', head: ['マイクをもう一度オンにする', 'MIC ON AGAIN'], sub: ['マイクが止まっている。押すと戻る', 'The mic stopped. Tap to restart'], usable: true, compact: true };
  }
  return null;
}

export interface PermsDeps {
  sensors: Sensors;
  listener: SoundListener;
  /** 音を出せるようにする（タップの直後でないとできない端末がある） */
  unlockAudio: () => void;
}

/** 確認に答えないまま放っておかれても、これだけたてばバナーをもう一度押せるようにする */
const BUSY_MAX_MS = 45_000;
/** 押さずにマイクを開き直す間隔 */
const AUTO_OPEN_EVERY_MS = 3_000;
/** マイクが要るようになってから、自分で開くのを待つ長さ（この間は「もう一度オンにする」を出さない） */
const AUTO_OPEN_GRACE_MS = 2_500;

export class Perms {
  asked = false;
  private busyUntil = 0;
  private lastAuto = -Infinity;
  private wantSince: number | null = null;

  constructor(private readonly deps: PermsDeps) {
    deps.listener.watchPermission();
  }

  /** バナーのタップの中で呼ぶ。動き → マイク → 位置の順に、確認を1つずつ出す */
  request(wantMic: boolean, now = Date.now()): void {
    const { sensors, listener, unlockAudio } = this.deps;
    this.asked = true;
    this.busyUntil = now + BUSY_MAX_MS;
    // このタップの中でしかできないもの：音の準備と、iPhone の動きの許可
    unlockAudio();
    const motion = sensors.requestMotion();
    const mic = () => (wantMic ? listener.open() : listener.prime());
    void motion
      .catch(() => undefined)
      .then(mic)
      .catch(() => undefined)
      .then(() => {
        sensors.requestGeo();
        this.busyUntil = 0;
      });
  }

  /** 毎フレーム呼ぶ。許可をもらってあれば、マイクが要る場面で押さなくても開く */
  tick(wantMic: boolean, now = Date.now()): void {
    const { listener } = this.deps;
    if (!wantMic) {
      this.wantSince = null;
      return;
    }
    this.wantSince ??= now;
    if (this.busy(now) || listener.permission !== 'granted') return;
    if ((listener.state === 'off' || listener.state === 'error') && now - this.lastAuto >= AUTO_OPEN_EVERY_MS) {
      this.lastAuto = now;
      void listener.open();
    }
  }

  private busy(now: number): boolean {
    return now < this.busyUntil;
  }

  snapshot(wantMic: boolean, now = Date.now()): PermSnapshot {
    const { sensors, listener } = this.deps;
    return {
      asked: this.asked,
      busy: this.busy(now),
      motion: sensors.motion,
      motionNeedsTap: sensors.motionNeedsTap,
      geo: sensors.geo,
      geoAllowed: sensors.geoAllowed,
      mic: listener.permission,
      micState: listener.state,
      micLive: listener.live,
      micSilent: listener.silent,
      wantMic,
    };
  }

  /** いま出すバナー */
  banner(wantMic: boolean, now = Date.now()): PermBanner | null {
    const s = this.snapshot(wantMic, now);
    const b = permBanner(s);
    // 許可はあって自分で開き直している間は、すぐには出さない（配役の瞬間に一瞬だけ出て消えるのを避ける）
    const opening = b !== null && !s.busy && (b.kind === 'fix' || b.kind === 'asking') && !s.micSilent;
    if (opening && s.mic === 'granted' && this.wantSince !== null && now - this.wantSince < AUTO_OPEN_GRACE_MS) return null;
    return b;
  }
}
