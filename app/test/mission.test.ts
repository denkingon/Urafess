import { describe, expect, it } from 'vitest';
import { cleanMissionTitle, isPhotoId, MISSION_DEFAULT_TITLE, MISSION_TITLE_MAX, photosRevealed } from '../src/shared/mission';
import { startTimer } from '../src/shared/schedule';

describe('ミッションの題', () => {
  it('空なら既定の題、空白と改行は1つにまとめる', () => {
    expect(cleanMissionTitle('')).toBe(MISSION_DEFAULT_TITLE);
    expect(cleanMissionTitle('   ')).toBe(MISSION_DEFAULT_TITLE);
    expect(cleanMissionTitle(undefined)).toBe(MISSION_DEFAULT_TITLE);
    expect(cleanMissionTitle(' 3人で\n図書館の前で\t撮れ ')).toBe('3人で 図書館の前で 撮れ');
  });
  it('長すぎる題は切る（絵文字も1字として数える）', () => {
    const t = cleanMissionTitle('🌙'.repeat(100));
    expect([...t].length).toBe(MISSION_TITLE_MAX);
  });
});

describe('写真を全員に見せてよいか', () => {
  const d = [1000, 1000, 1000, 1000];
  it('配役〜時間が0になるまでは見せない。結果発表・待合室・夜の最後は見せる', () => {
    expect(photosRevealed({ stage: 'lobby', timer: null }, 0)).toBe(true);
    expect(photosRevealed({ stage: 'assigned', timer: null }, 0)).toBe(false);
    const timer = startTimer(d, 10_000);
    expect(photosRevealed({ stage: 'timer', timer }, 11_000)).toBe(false);
    expect(photosRevealed({ stage: 'timer', timer }, 10_000 + 60_000)).toBe(true);
    expect(photosRevealed({ stage: 'result', timer }, 0)).toBe(true);
    expect(photosRevealed({ stage: 'ended', timer: null }, 0)).toBe(true);
  });
});

describe('写真の印', () => {
  it('24桁の16進数だけ', () => {
    expect(isPhotoId('0123456789abcdef01234567')).toBe(true);
    expect(isPhotoId('0123456789abcdef0123456')).toBe(false);
    expect(isPhotoId('../../etc/passwd')).toBe(false);
    expect(isPhotoId(5)).toBe(false);
  });
});
