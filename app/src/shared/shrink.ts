import { checkArea } from './area';
import { CAPTURE_PHASE_INDEX } from './capture';
import { cumulative, elapsedAt, type Timer } from './schedule';
import type { LatLon } from './run';

/**
 * 範囲の縮小。遊ぶ範囲（主催者が描いた多角形）を、ラウンドの間に「縮む先」の点へ向けて縮める。
 *
 * - 形はそのまま、縮む先の点を中心に小さくする（相似に縮める）。へこんだ形でも元の範囲からはみ出さないよう、
 *   「今の範囲」は「縮めた形」と「元の範囲」の重なり（両方の中にいれば中）
 * - 1回の縮小（段）は「予告」（次の範囲の線が出る）→「縮む」（線が動く）の順。どちらも ZONE_WARN_MS・ZONE_MOVE_MS
 * - 段の引き金は3つ：時間（主催者が決めた回数を、ゲームの段階の中に等間隔で）・ミッション（写真の「成功」）・主催者の手（今すぐ1段）
 * - 段の時刻はタイマーの経過時間で持つ（タイマーと同じ考え方）。止めれば縮小も止まり、全員が同じ計算で同じ範囲になる。通信は増えない
 * - 段は「広さ（面積）を何倍にするか」。いくつ重なっても掛け算で、順番によらない。ZONE_MIN_SCALE より小さくはしない
 */

export type ShrinkTo = 'mid' | 'pick' | 'random';

/** 主催者が試合の前に決める縮み方（部屋に保存。新しい夜でも残る） */
export interface ShrinkPlan {
  /** 時間で縮む回数（0＝時間では縮まない） */
  times: number;
  /** 時間で縮み終えたときの広さ（元の広さに対する割合） */
  finalArea: number;
  /** 縮む先：mid＝範囲の真ん中／pick＝主催者が地図で選んだ点／random＝毎ラウンド、範囲の中のどこか */
  to: ShrinkTo;
  /** to='pick' の点（[緯度, 経度]） */
  pick: [number, number] | null;
  /** ミッション（写真の「成功」）で1段縮む */
  mission: boolean;
}

export type ShrinkWhy = 'time' | 'mission' | 'host';

export interface ShrinkStep {
  /** 予告が始まるタイマーの経過時間（ms） */
  at: number;
  warn: number;
  move: number;
  /** 長さを何倍にするか（広さはこの2乗） */
  f: number;
  why: ShrinkWhy;
}

/** このラウンドの縮小（試合を始めたときに決まり、配役で消える） */
export interface ShrinkLive {
  center: [number, number];
  steps: ShrinkStep[];
  /** ミッションで縮めた写真の印（1枚の写真で縮むのは1回だけ） */
  byPhoto: string[];
}

export const DEFAULT_SHRINK_PLAN: ShrinkPlan = { times: 0, finalArea: 0.25, to: 'mid', pick: null, mission: false };
export const SHRINK_MAX_TIMES = 4;
export const SHRINK_FINAL_AREAS = [0.5, 0.25, 0.1] as const;
/** 予告（次の範囲の線が出てから縮み始めるまで） */
export const ZONE_WARN_MS = 30_000;
/** 縮む（線が動いている間） */
export const ZONE_MOVE_MS = 30_000;
/** ミッション・主催者の1段で、広さを何倍にするか */
export const ZONE_STEP_AREA = 0.7;
/** これより小さくはしない（長さの倍率。広さで約2%） */
export const ZONE_MIN_SCALE = 0.15;

export function isShrinkPlan(v: unknown): v is ShrinkPlan {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    Number.isInteger(p.times) &&
    (p.times as number) >= 0 &&
    (p.times as number) <= SHRINK_MAX_TIMES &&
    typeof p.finalArea === 'number' &&
    p.finalArea >= 0.05 &&
    p.finalArea <= 0.95 &&
    (p.to === 'mid' || p.to === 'pick' || p.to === 'random') &&
    (p.pick === null ||
      (Array.isArray(p.pick) && p.pick.length === 2 && p.pick.every((x) => typeof x === 'number' && Number.isFinite(x)))) &&
    typeof p.mission === 'boolean'
  );
}

export function cleanShrinkPlan(p: ShrinkPlan): ShrinkPlan {
  return {
    times: p.times,
    finalArea: Math.round(p.finalArea * 100) / 100,
    to: p.to,
    pick: p.pick ? [Math.round(p.pick[0] * 1e6) / 1e6, Math.round(p.pick[1] * 1e6) / 1e6] : null,
    mission: p.mission,
  };
}

/** 縮むことがある縮み方か（時間・ミッションのどちらか） */
export function shrinkActive(p: ShrinkPlan | null | undefined): boolean {
  return !!p && (p.times > 0 || p.mission);
}

// ---------- 形 ----------

/** 平らな座標で見た重心（面積の重心）。形がつぶれていれば頂点の平均 */
function centroid(pts: [number, number][]): [number, number] {
  const lat0 = pts[0][0];
  const k = Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][1] * k;
    const yi = pts[i][0];
    const xj = pts[j][1] * k;
    const yj = pts[j][0];
    const cr = xj * yi - xi * yj;
    a += cr;
    cx += (xj + xi) * cr;
    cy += (yj + yi) * cr;
  }
  if (Math.abs(a) < 1e-14) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cy / (3 * a), cx / (3 * a) / k];
}

/** 範囲の中の点を、格子で拾う（線からの距離つき） */
function insideGrid(pts: [number, number][], n = 28): { p: [number, number]; edge: number }[] {
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const la0 = Math.min(...lats);
  const la1 = Math.max(...lats);
  const lo0 = Math.min(...lons);
  const lo1 = Math.max(...lons);
  const out: { p: [number, number]; edge: number }[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p: [number, number] = [la0 + ((la1 - la0) * (i + 0.5)) / (n + 1), lo0 + ((lo1 - lo0) * (j + 0.5)) / (n + 1)];
      const c = checkArea(pts, { lat: p[0], lon: p[1] });
      if (c.inside) out.push({ p, edge: c.edgeM });
    }
  }
  return out;
}

/** 範囲の真ん中：重心が中にあって線から離れていれば重心、そうでなければ線からいちばん遠い点 */
export function midOf(pts: [number, number][]): [number, number] {
  const c = centroid(pts);
  const grid = insideGrid(pts);
  const best = grid.reduce((a, b) => (b.edge > a.edge ? b : a), grid[0] ?? { p: c, edge: 0 });
  const cc = checkArea(pts, { lat: c[0], lon: c[1] });
  if (cc.inside && cc.edgeM >= best.edge * 0.5) return c;
  return best.p;
}

/** 範囲の中のどこか（線のすぐそばは避ける）。rnd は 0〜1 */
export function randomInside(pts: [number, number][], rnd: () => number): [number, number] {
  const grid = insideGrid(pts);
  if (!grid.length) return midOf(pts);
  const max = Math.max(...grid.map((g) => g.edge));
  const ok = grid.filter((g) => g.edge >= max * 0.3);
  const pick = ok[Math.floor(rnd() * ok.length) % ok.length];
  return pick.p;
}

/** このラウンドの縮む先 */
export function resolveCenter(plan: ShrinkPlan, pts: [number, number][], rnd: () => number): [number, number] {
  if (plan.to === 'random') return randomInside(pts, rnd);
  if (plan.to === 'pick' && plan.pick && checkArea(pts, { lat: plan.pick[0], lon: plan.pick[1] }).inside) return plan.pick;
  return midOf(pts);
}

/** 中心へ向けて長さを s 倍にした形 */
export function scalePts(pts: [number, number][], c: [number, number], s: number): [number, number][] {
  return pts.map(([a, b]) => [c[0] + (a - c[0]) * s, c[1] + (b - c[1]) * s]);
}

// ---------- 段 ----------

/** 時間の段：ゲームの段階を回数+1 等分した区切りで予告を始める。短いゲームでは予告と縮むも短くする */
export function timeSteps(plan: ShrinkPlan, durations: readonly number[]): ShrinkStep[] {
  if (plan.times <= 0) return [];
  const gameStart = cumulative(durations)[CAPTURE_PHASE_INDEX];
  const D = durations[CAPTURE_PHASE_INDEX] ?? 0;
  const gap = D / (plan.times + 1);
  const warn = Math.min(ZONE_WARN_MS, gap / 2);
  const move = Math.min(ZONE_MOVE_MS, gap / 2);
  const f = Math.pow(plan.finalArea, 1 / (2 * plan.times));
  const out: ShrinkStep[] = [];
  for (let i = 1; i <= plan.times; i++) out.push({ at: Math.round(gameStart + gap * i - warn), warn, move, f, why: 'time' });
  return out;
}

/** 試合を始めたときに決める。範囲が無ければ null */
export function makeLive(plan: ShrinkPlan | null | undefined, pts: [number, number][] | null | undefined, durations: readonly number[], rnd: () => number): ShrinkLive | null {
  if (!pts || pts.length < 3) return null;
  const p = plan ?? DEFAULT_SHRINK_PLAN;
  return { center: resolveCenter(p, pts, rnd), steps: timeSteps(p, durations), byPhoto: [] };
}

/** ミッション・主催者の1段（今の経過時間から予告を始める） */
export function extraStep(elapsed: number, why: ShrinkWhy): ShrinkStep {
  return { at: Math.round(elapsed), warn: ZONE_WARN_MS, move: ZONE_MOVE_MS, f: Math.sqrt(ZONE_STEP_AREA), why };
}

const ease = (t: number) => t * t * (3 - 2 * t);
const rank = (s: ZoneStatus) => (s.kind === 'move' ? 2 : s.kind === 'warn' ? 1 : 0);

export type ZoneStatus =
  | { kind: 'warn'; leftMs: number; why: ShrinkWhy }
  | { kind: 'move'; leftMs: number; why: ShrinkWhy }
  | { kind: 'idle'; nextInMs: number | null };

export interface ZoneNow {
  /** 元の範囲 */
  pts: [number, number][];
  /** 今の縮んだ形（縮んでいなければ null） */
  inner: [number, number][] | null;
  /** 予告中・縮んでいる途中の行き先（無ければ null） */
  next: [number, number][] | null;
  /** 今の長さの倍率・行き先の倍率 */
  scale: number;
  target: number;
  center: [number, number] | null;
  status: ZoneStatus;
}

/** 経過時間 el での倍率（今・行き先）と、いちばん先に終わる動き */
export function scaleAt(steps: readonly ShrinkStep[], el: number): { scale: number; target: number; status: ZoneStatus } {
  let scale = 1;
  let target = 1;
  let status: ZoneStatus | null = null;
  let nextIn: number | null = null;
  for (const s of steps) {
    if (el < s.at) {
      nextIn = nextIn === null ? s.at - el : Math.min(nextIn, s.at - el);
      continue;
    }
    const t = s.move > 0 ? Math.max(0, Math.min(1, (el - s.at - s.warn) / s.move)) : 1;
    scale *= 1 + (s.f - 1) * ease(t);
    target *= s.f;
    const st: ZoneStatus | null =
      el < s.at + s.warn
        ? { kind: 'warn', leftMs: s.at + s.warn - el, why: s.why }
        : el < s.at + s.warn + s.move
          ? { kind: 'move', leftMs: s.at + s.warn + s.move - el, why: s.why }
          : null;
    // 縮んでいる途中を予告より先に。同じ種類なら先に終わるほう
    if (st && (!status || rank(st) > rank(status) || (rank(st) === rank(status) && st.leftMs < (status as { leftMs: number }).leftMs))) status = st;
  }
  scale = Math.max(ZONE_MIN_SCALE, scale);
  target = Math.max(ZONE_MIN_SCALE, target);
  return { scale, target, status: status ?? { kind: 'idle', nextInMs: nextIn } };
}

/** 今の範囲。範囲が無ければ null。縮小が無い・まだ始めていなければ元の範囲だけ */
export function zoneAt(
  area: { pts: [number, number][] } | null | undefined,
  live: ShrinkLive | null | undefined,
  timer: Timer | null | undefined,
  serverNow: number,
): ZoneNow | null {
  if (!area || area.pts.length < 3) return null;
  const base: ZoneNow = { pts: area.pts, inner: null, next: null, scale: 1, target: 1, center: live?.center ?? null, status: { kind: 'idle', nextInMs: null } };
  if (!live || !timer || !live.steps.length) return base;
  const el = elapsedAt(timer, serverNow);
  const { scale, target, status } = scaleAt(live.steps, el);
  return {
    ...base,
    inner: scale < 0.9999 ? scalePts(area.pts, live.center, scale) : null,
    next: target < scale - 1e-4 ? scalePts(area.pts, live.center, target) : null,
    scale,
    target,
    status,
  };
}

/** 経過時間で見た広さ（元の広さに対する割合） */
export function areaRatio(scale: number): number {
  return scale * scale;
}
