import { distanceM, type LatLon } from './run';

/**
 * 遊ぶ範囲（主催者がゲームの前に地図に描く多角形）。
 * - 頂点は [緯度, 経度] の並び（3〜AREA_MAX_PTS 個、描いた順）。null＝範囲なし（どこでも遊べる）
 * - 範囲の外に AREA_OUT_MARGIN_M より出て、それが AREA_OUT_CONFIRM_MS 続いたら「外」。位置のぶれで外と言わないため
 * - 外になった人は、内側へ AREA_BACK_MARGIN_M 入ったら「中」に戻る（境目でばたばたしないため）
 * - 「外」が AREA_DQ_MS（20秒）続いたら失格。中に戻れば数え直す。失格はそのラウンドの終わりまで戻らない
 * - 判定はスマホが自分の位置で決める（サーバーへの通信は増えない）。主催者の地図は届いた位置で同じ判定をする
 */

export interface Area {
  pts: [number, number][];
  /** 決めたサーバー時刻 */
  at: number;
}

export const AREA_MIN_PTS = 3;
export const AREA_MAX_PTS = 40;
/** キャンパスの真ん中からこれより遠い頂点は受け付けない（打ち間違い） */
export const AREA_MAX_FROM_CAMPUS_M = 5_000;
/** 範囲の線からこれだけ外に出たら「外」の候補（m）。屋外の位置のぶれ 5〜20m を見込む */
export const AREA_OUT_MARGIN_M = 15;
/** 「外」の候補がこれだけ続いたら「外」 */
export const AREA_OUT_CONFIRM_MS = 3_000;
/** 外になった人が「中」に戻るには、線から内側へこれだけ入る（m） */
export const AREA_BACK_MARGIN_M = 3;
/** 「外」がこれだけ続いたら失格（「戻れ」が出た時点から数える。中に戻れば数え直し） */
export const AREA_DQ_MS = 20_000;

const toPt = (p: [number, number]): LatLon => ({ lat: p[0], lon: p[1] });

/** 形が正しいか（数・数字・場所）。center はキャンパスの真ん中 */
export function isValidAreaPts(pts: unknown, center: LatLon): pts is [number, number][] {
  if (!Array.isArray(pts) || pts.length < AREA_MIN_PTS || pts.length > AREA_MAX_PTS) return false;
  return pts.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      typeof p[0] === 'number' &&
      typeof p[1] === 'number' &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 90 &&
      Math.abs(p[1]) <= 180 &&
      distanceM(center, { lat: p[0], lon: p[1] }) <= AREA_MAX_FROM_CAMPUS_M,
  );
}

/** 小数6桁（約0.1m）にそろえる */
export function cleanAreaPts(pts: [number, number][]): [number, number][] {
  return pts.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);
}

/** 平らな座標（m）に直す。範囲は数km までなので、基準点のまわりの平面で足りる */
function flat(origin: LatLon, p: LatLon): { x: number; y: number } {
  const k = 111_195;
  return { x: (p.lon - origin.lon) * k * Math.cos((origin.lat * Math.PI) / 180), y: (p.lat - origin.lat) * k };
}

function fromFlat(origin: LatLon, q: { x: number; y: number }): LatLon {
  const k = 111_195;
  return { lat: origin.lat + q.y / k, lon: origin.lon + q.x / (k * Math.cos((origin.lat * Math.PI) / 180)) };
}

export interface AreaCheck {
  inside: boolean;
  /** 線までの距離（m）。中なら内側の距離、外なら外側の距離 */
  edgeM: number;
  /** いちばん近い線の上の点（外にいる人が戻る先） */
  nearest: LatLon;
}

/** 点が範囲の中か、線までどれだけか */
export function checkArea(pts: [number, number][], p: LatLon): AreaCheck {
  const origin = p;
  const poly = pts.map((v) => flat(origin, toPt(v)));
  const me = { x: 0, y: 0 };
  let inside = false;
  let best = Infinity;
  let bestPt = poly[0];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > me.y !== b.y > me.y && me.x < ((b.x - a.x) * (me.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((me.x - a.x) * dx + (me.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x, q.y);
    if (d < best) {
      best = d;
      bestPt = q;
    }
  }
  return { inside, edgeM: best, nearest: fromFlat(origin, bestPt) };
}

/** その位置だけで見た「外」か（線から AREA_OUT_MARGIN_M より外） */
export function isFarOutside(pts: [number, number][], p: LatLon): boolean {
  const c = checkArea(pts, p);
  return !c.inside && c.edgeM > AREA_OUT_MARGIN_M;
}

/**
 * 外・中の見張り（1人分）。位置が来るたびに feed する。
 * 外の候補が AREA_OUT_CONFIRM_MS 続いたら out=true、内側へ AREA_BACK_MARGIN_M 入ったら out=false
 */
export class AreaWatch {
  out = false;
  /**
   * 失格（「外」が AREA_DQ_MS 続いた）。一度なったら clearDq まで戻らない。
   * reset（一時停止・範囲なし・位置が取れない）では消えない：一時停止で失格が取り消されないように
   */
  disqualified = false;
  private since: number | null = null;
  private outSince: number | null = null;
  last: AreaCheck | null = null;

  feed(pts: [number, number][] | null, p: LatLon | null, now: number): boolean {
    if (!pts || !p) {
      this.reset();
      return this.out;
    }
    const c = checkArea(pts, p);
    this.last = c;
    const far = !c.inside && c.edgeM > AREA_OUT_MARGIN_M;
    if (this.out) {
      if (c.inside && c.edgeM >= AREA_BACK_MARGIN_M) {
        this.out = false;
        this.since = null;
      }
    } else if (far) {
      this.since ??= now;
      if (now - this.since >= AREA_OUT_CONFIRM_MS) this.out = true;
    } else {
      this.since = null;
    }
    // 「外」が続いた長さ。中に戻れば数え直し
    if (this.out) {
      this.outSince ??= now;
      if (now - this.outSince >= AREA_DQ_MS) this.disqualified = true;
    } else {
      this.outSince = null;
    }
    return this.out;
  }

  /** 失格まで残り（ms）。外にいないときは null。失格済みは 0 */
  dqLeftMs(now: number): number | null {
    if (this.disqualified) return 0;
    if (!this.out || this.outSince === null) return null;
    return Math.max(0, AREA_DQ_MS - (now - this.outSince));
  }

  /** 外・中の見張りだけ止める（失格は残す） */
  reset(): void {
    this.out = false;
    this.since = null;
    this.outSince = null;
    this.last = null;
  }

  /** 失格を消す（新しいラウンド） */
  clearDq(): void {
    this.disqualified = false;
  }
}
