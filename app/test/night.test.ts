import { describe, expect, it } from 'vitest';
import { cleanNightPlan, defaultNightPlan, hhmm, nightIssues, parseHhmm, placeNight, spanText } from '../src/shared/night';

const ROUND_MS = (20 + 60 + 300 + 120) * 1000; // 8:20

describe('夜の予定', () => {
  it('開始から順に並べ、終わりの時刻を出す（例：21:20 から 70分 → 22:30）', () => {
    const p = defaultNightPlan();
    const { blocks, end } = placeNight(p);
    expect(blocks.map((b) => hhmm(b.from))).toEqual(['21:20', '21:30', '21:40', '21:55', '22:05', '22:20']);
    expect(hhmm(end)).toBe('22:30');
    expect(nightIssues(p, ROUND_MS)).toEqual([]);
  });

  it('終わっていたい時刻を過ぎると不備にする', () => {
    const p = defaultNightPlan();
    p.blocks[3].mins = 18;
    expect(nightIssues(p, ROUND_MS).map((i) => i.text)).toEqual(['終わりが 22:30 を 8分 過ぎる（22:38）']);
  });

  it('日をまたぐ予定：0時を過ぎても時刻が正しく、終わっていたい時刻は次の日とみなす', () => {
    const p = { start: 23 * 60 + 40, endBy: 30, blocks: [{ id: 'a', kind: 'game' as const, title: '本番', mins: 40 }] };
    expect(hhmm(placeNight(p).end)).toBe('0:20');
    expect(nightIssues(p, ROUND_MS)).toEqual([]);
  });

  it('プレ・本番のブロックにデッキの時間が収まらなければ、そのブロックの不備にする', () => {
    const p = defaultNightPlan();
    p.blocks[1].mins = 5;
    const issues = nightIssues(p, ROUND_MS);
    expect(issues).toEqual([{ id: 'b2', text: '「プレ」5分にデッキの時間（8:20）が収まらない' }]);
  });

  it('本番が無い・「終わり」のあとにブロックがある', () => {
    const p = { start: 0, endBy: null, blocks: [{ id: 'a', kind: 'end' as const, title: '', mins: 5 }, { id: 'b', kind: 'talk' as const, title: '', mins: 5 }] };
    expect(nightIssues(p, ROUND_MS).map((i) => i.text)).toEqual(['本番のブロックが無い', '「終わり」のあとにまだブロックがある']);
  });

  it('サーバーはおかしな予定を受け取らない', () => {
    expect(cleanNightPlan(defaultNightPlan())).toEqual(defaultNightPlan());
    expect(cleanNightPlan({ ...defaultNightPlan(), start: 1440 })).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'x', title: '', mins: 5 }] })).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'game', title: '', mins: 0 }] })).toBeNull();
    const dup = { ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'game', title: '', mins: 5 }, { id: 'a', kind: 'game', title: '', mins: 5 }] };
    expect(cleanNightPlan(dup)).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'game', title: 'あ'.repeat(40), mins: 5 }] })?.blocks[0].title).toHaveLength(24);
  });

  it('時刻の読み書き', () => {
    expect(parseHhmm('21:20')).toBe(1280);
    expect(parseHhmm('9:05')).toBe(545);
    expect(parseHhmm('25:00')).toBeNull();
    expect(spanText(70)).toBe('1時間10分');
    expect(spanText(45)).toBe('45分');
  });
});
