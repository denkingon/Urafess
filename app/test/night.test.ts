import { describe, expect, it } from 'vitest';
import { defaultPresets } from '../src/shared/preset';
import { blockSecs, cleanNightPlan, defaultNightPlan, defaultRound, hhmm, nightIssues, parseHhmm, placeNight, sameAsDeck, spanText } from '../src/shared/night';

describe('夜の予定', () => {
  it('開始から順に並べ、終わりの時刻を出す。プレ・本番の長さは中身（配役・4段・結果発表）の合計', () => {
    const p = defaultNightPlan();
    const ps = defaultPresets();
    expect(blockSecs(p.blocks[1], ps)).toBe(8 * 60); // プレ 1:00 + 0:20 + 0:40 + 3:00 + 1:00 + 2:00
    expect(blockSecs(p.blocks[2], ps)).toBe(12 * 60 + 20); // 本番 1:00 + 8:20 + 3:00
    const { blocks, end } = placeNight(p, ps);
    expect(blocks.map((b) => hhmm(b.from))).toEqual(['21:20', '21:30', '21:38', '21:50', '22:00', '22:12']);
    expect(hhmm(end)).toBe('22:22'); // 22:22:40（時刻は分で切り捨て）
    expect(spanText(end - p.start)).toBe('1時間3分');
    expect(nightIssues(p, ps)).toEqual([]);
  });

  it('このブロックだけ中身を変えると、その後ろの時刻が全部ずれる', () => {
    const p = defaultNightPlan();
    const ps = defaultPresets();
    p.blocks[2].round = { cast: 60, phases: [20, 60, 600, 120], result: 180 }; // 本番のゲームを 5:00 → 10:00
    expect(hhmm(placeNight(p, ps).blocks[3].from)).toBe('21:55');
    expect(hhmm(placeNight(p, ps).end)).toBe('22:27');
  });

  it('終わっていたい時刻を過ぎると不備にする', () => {
    const p = defaultNightPlan();
    p.blocks[3].mins = 25;
    expect(nightIssues(p, defaultPresets()).map((i) => i.text)).toEqual(['終わりが 22:30 を 8分 過ぎる（22:37）']);
  });

  it('日をまたぐ予定：0時を過ぎても時刻が正しく、終わっていたい時刻は次の日とみなす', () => {
    const p = { start: 23 * 60 + 40, endBy: 30, blocks: [{ id: 'a', kind: 'show' as const, title: '', mins: 40 }, { id: 'b', kind: 'game' as const, title: '', mins: 13, round: defaultRound('game') }] };
    expect(hhmm(placeNight(p).end)).toBe('0:32');
    expect(nightIssues(p).map((i) => i.text)).toEqual(['終わりが 0:30 を 3分 過ぎる（0:32）']);
  });

  it('本番が無い・「終わり」のあとにブロックがある', () => {
    const p = { start: 0, endBy: null, blocks: [{ id: 'a', kind: 'end' as const, title: '', mins: 5 }, { id: 'b', kind: 'talk' as const, title: '', mins: 5 }] };
    expect(nightIssues(p).map((i) => i.text)).toEqual(['本番のブロックが無い', '「終わり」のあとにまだブロックがある']);
  });

  it('中身がデッキの時間と同じか', () => {
    expect(sameAsDeck(defaultRound('game'), [20_000, 60_000, 300_000, 120_000])).toBe(true);
    expect(sameAsDeck(defaultRound('pre'), [20_000, 60_000, 300_000, 120_000])).toBe(false);
  });

  it('サーバーはおかしな予定を受け取らない。中身の無い本番は「詳細なし」', () => {
    expect(cleanNightPlan(defaultNightPlan())).toEqual(defaultNightPlan());
    expect(cleanNightPlan({ ...defaultNightPlan(), start: 1440 })).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'x', title: '', mins: 5 }] })).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'talk', title: '', mins: 0 }] })).toBeNull();
    const bad = { cast: 60, phases: [0, 60, 300, 120], result: 0 };
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'game', title: '', mins: 5, round: bad }] })).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'game', title: '', mins: 5 }] })?.blocks[0].round).toBeUndefined();
    const dup = { ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'talk', title: '', mins: 5 }, { id: 'a', kind: 'talk', title: '', mins: 5 }] };
    expect(cleanNightPlan(dup)).toBeNull();
    expect(cleanNightPlan({ ...defaultNightPlan(), blocks: [{ id: 'a', kind: 'talk', title: 'あ'.repeat(40), mins: 5 }] })?.blocks[0].title).toHaveLength(24);
  });

  it('時刻の読み書き', () => {
    expect(parseHhmm('21:20')).toBe(1280);
    expect(parseHhmm('9:05')).toBe(545);
    expect(parseHhmm('25:00')).toBeNull();
    expect(spanText(70)).toBe('1時間10分');
    expect(spanText(45)).toBe('45分');
  });
});
