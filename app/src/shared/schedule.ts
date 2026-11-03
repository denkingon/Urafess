import { START_LEAD_MS } from './rules';

/**
 * タイマーは「数えない」。区切りの時刻（サーバーの時計）だけを持ち、残り時間は毎回そこから計算する。
 *
 * - t0: 1つ目の段階（逃走開始まで）が始まるサーバー時刻
 * - floorElapsed: 予約した時刻までは表示をこの経過時間で止めておく（開始は0、再開は止めた時点）
 * - pausedElapsed: 一時停止中の経過時間
 */
export interface Timer {
  status: 'running' | 'paused';
  t0: number;
  floorElapsed: number;
  pausedElapsed: number;
  durations: number[];
}

export type PhasePosition =
  | { kind: 'phase'; index: number; remainingMs: number; elapsedMs: number; waitingForStart: boolean }
  | { kind: 'done'; elapsedMs: number };

export function totalMs(durations: readonly number[]): number {
  return durations.reduce((a, b) => a + b, 0);
}

/** [0, d0, d0+d1, ...]（各段階が始まる経過時間） */
export function cumulative(durations: readonly number[]): number[] {
  const out = [0];
  for (const d of durations) out.push(out[out.length - 1] + d);
  return out;
}

export function startTimer(durations: readonly number[], serverNow: number): Timer {
  return {
    status: 'running',
    t0: serverNow + START_LEAD_MS,
    floorElapsed: 0,
    pausedElapsed: 0,
    durations: [...durations],
  };
}

export function elapsedAt(timer: Timer, serverNow: number): number {
  if (timer.status === 'paused') return timer.pausedElapsed;
  return Math.max(serverNow - timer.t0, timer.floorElapsed);
}

export function pauseTimer(timer: Timer, serverNow: number): Timer {
  if (timer.status !== 'running') return timer;
  return { ...timer, status: 'paused', pausedElapsed: elapsedAt(timer, serverNow) };
}

/** 再開は2秒後を予約し、残りの区切りをすべて止めていた分だけ後ろにずらす */
export function resumeTimer(timer: Timer, serverNow: number): Timer {
  if (timer.status !== 'paused') return timer;
  const resumeAt = serverNow + START_LEAD_MS;
  return {
    ...timer,
    status: 'running',
    t0: resumeAt - timer.pausedElapsed,
    floorElapsed: timer.pausedElapsed,
  };
}

export function positionAt(timer: Timer, serverNow: number): PhasePosition {
  const elapsed = elapsedAt(timer, serverNow);
  const cum = cumulative(timer.durations);
  const total = cum[cum.length - 1];
  if (elapsed >= total) return { kind: 'done', elapsedMs: elapsed };
  let index = 0;
  while (index < timer.durations.length - 1 && elapsed >= cum[index + 1]) index++;
  const waitingForStart = timer.status === 'running' && serverNow - timer.t0 < timer.floorElapsed;
  return { kind: 'phase', index, remainingMs: cum[index + 1] - elapsed, elapsedMs: elapsed, waitingForStart };
}

export function isDone(timer: Timer, serverNow: number): boolean {
  return positionAt(timer, serverNow).kind === 'done';
}

/** 走っている間の、各区切りのサーバー時刻（全員が同じ値を持つ） */
export function boundaryTimes(timer: Timer): number[] | null {
  if (timer.status !== 'running') return null;
  return cumulative(timer.durations).map((c) => timer.t0 + c);
}

/** 秒の表示。全員が同じ切り上げ方をするので、数字は同じ瞬間に変わる */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
