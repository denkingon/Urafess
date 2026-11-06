import { describe, expect, it } from 'vitest';
import { decideWinner, endReason, everyoneJailed, freeRunners } from '../src/shared/jail';

const c = (runner: number, caught: number) => ({ oni: 3, runner, total: runner + 3, caught });

describe('牢屋と終わり方の決まり', () => {
  it('全員が牢屋にいるか', () => {
    expect(everyoneJailed(c(7, 7))).toBe(true);
    expect(everyoneJailed(c(7, 6))).toBe(false);
    // 逃走者が0人の配役では起きない
    expect(everyoneJailed(c(0, 0))).toBe(false);
    expect(freeRunners(c(7, 9))).toBe(0);
  });

  it('全員が同時に入ったことがあれば、あとで出た人がいても鬼の勝ち', () => {
    expect(decideWinner({ counts: c(7, 3), allCaughtAt: 1 })).toBe('oni');
    expect(decideWinner({ counts: c(7, 7), allCaughtAt: null })).toBe('oni');
    expect(decideWinner({ counts: c(7, 6), allCaughtAt: null })).toBe('runner');
    expect(endReason({ counts: c(7, 6), allCaughtAt: null })).toContain('1人');
  });
});
