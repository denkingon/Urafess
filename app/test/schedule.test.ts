import { describe, expect, it } from 'vitest';
import { START_LEAD_MS } from '../src/shared/rules';
import {
  boundaryTimes,
  formatClock,
  matchLive,
  pauseTimer,
  positionAt,
  resumeTimer,
  startTimer,
} from '../src/shared/schedule';

const D = [20_000, 60_000, 300_000, 120_000];

describe('区切りの計算', () => {
  it('開始は2秒後を予約し、それまでは「逃走開始まで 0:20」で止まる', () => {
    const t = startTimer(D, 1_000_000);
    expect(t.t0).toBe(1_000_000 + START_LEAD_MS);
    const before = positionAt(t, 1_000_500);
    expect(before).toMatchObject({ kind: 'phase', index: 0, remainingMs: 20_000, waitingForStart: true });
    expect(formatClock(20_000)).toBe('0:20');
  });

  it('段階が時刻どおりに切り替わる', () => {
    const t = startTimer(D, 0);
    const at = (ms: number) => positionAt(t, START_LEAD_MS + ms);
    expect(at(0)).toMatchObject({ index: 0, remainingMs: 20_000 });
    expect(at(19_999)).toMatchObject({ index: 0, remainingMs: 1 });
    expect(at(20_000)).toMatchObject({ index: 1, remainingMs: 60_000 });
    expect(at(80_000)).toMatchObject({ index: 2, remainingMs: 300_000 });
    expect(at(380_000)).toMatchObject({ index: 3, remainingMs: 120_000 });
    expect(at(500_000).kind).toBe('done');
    expect(boundaryTimes(t)).toEqual([2_000, 22_000, 82_000, 382_000, 502_000]);
  });

  it('一時停止で止まり、再開は2秒後から、止めていた分だけ区切りが後ろにずれる', () => {
    const t = startTimer(D, 0);
    const paused = pauseTimer(t, START_LEAD_MS + 100_000); // ゲーム中（残り 280秒）
    expect(positionAt(paused, START_LEAD_MS + 100_000)).toMatchObject({ index: 2, remainingMs: 280_000 });
    expect(positionAt(paused, START_LEAD_MS + 999_999)).toMatchObject({ index: 2, remainingMs: 280_000 });

    const resumedAt = 2_000_000;
    const r = resumeTimer(paused, resumedAt);
    // 再開の2秒間は止めた値のまま
    expect(positionAt(r, resumedAt + 1_000)).toMatchObject({ index: 2, remainingMs: 280_000, waitingForStart: true });
    // 2秒後から減り始める
    expect(positionAt(r, resumedAt + START_LEAD_MS + 1_000)).toMatchObject({ index: 2, remainingMs: 279_000 });
    // 残りの区切りはすべて同じだけずれる
    const b = boundaryTimes(r)!;
    expect(b[3] - b[2]).toBe(300_000);
    expect(b[4] - b[3]).toBe(120_000);
    expect(b[3]).toBe(resumedAt + START_LEAD_MS + 280_000);
  });

  it('秒は切り上げで表示し、全員が同じ瞬間に数字を変える', () => {
    expect(formatClock(300_000)).toBe('5:00');
    expect(formatClock(299_001)).toBe('5:00');
    expect(formatClock(299_000)).toBe('4:59');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('試合中か（合図を出す・見張る・画面を消さない間）', () => {
  const end = START_LEAD_MS + 500_000; // 4つの区切りが全部終わる時刻（開始を0として）

  it('配役済みは試合中。待合室と結果発表は試合中ではない', () => {
    expect(matchLive('assigned', null, 0)).toBe(true);
    expect(matchLive('lobby', null, 0)).toBe(false);
    expect(matchLive('result', null, 0)).toBe(false);
    expect(matchLive(undefined, null, 0)).toBe(false);
  });

  it('タイマーは、最後の区切り（広場に戻るまで）が0になる瞬間まで試合中。0になったら、結果を押す前でも試合中ではない', () => {
    const t = startTimer(D, 0);
    expect(matchLive('timer', t, 0)).toBe(true); // 開始前の2秒
    expect(matchLive('timer', t, end - 1)).toBe(true);
    expect(matchLive('timer', t, end)).toBe(false);
    expect(matchLive('timer', t, end + 12 * 3_600_000)).toBe(false); // 結果待ちのまま一晩
  });

  it('一時停止中は、どれだけ止めていても試合中', () => {
    const paused = pauseTimer(startTimer(D, 0), START_LEAD_MS + 100_000);
    expect(matchLive('timer', paused, end + 3_600_000)).toBe(true);
    // 再開すると、止めていた分だけ0になる時刻が後ろにずれる
    const resumed = resumeTimer(paused, START_LEAD_MS + 700_000);
    expect(matchLive('timer', resumed, end + 600_000)).toBe(true);
    expect(matchLive('timer', resumed, end + 600_000 + START_LEAD_MS)).toBe(false);
  });

  it('タイマーの段階なのにタイマーがない（起きない状態）は、見張りを外さない側に倒して試合中とみなす', () => {
    expect(matchLive('timer', null, 0)).toBe(true);
  });
});
