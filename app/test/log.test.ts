import { describe, expect, it } from 'vitest';
import { eventsToCsv, jst, type EventRow } from '../src/server/log';
import type { GameView, MeView } from '../src/shared/protocol';
import { participantView } from '../src/shared/viewmodel';
import { startTimer } from '../src/shared/schedule';
import { START_LEAD_MS } from '../src/shared/rules';

const row = (over: Partial<EventRow>): EventRow => ({
  id: 1,
  at: Date.UTC(2026, 10, 6, 12, 34, 5, 123),
  round: 1,
  assign_id: 1,
  phase: 2,
  elapsed: 95_400,
  kind: 'capture',
  pid: 'a',
  num: 3,
  name: 'たけ',
  other_pid: 'b',
  other_num: 12,
  other_name: 'ゆう',
  via: 'sound',
  data: '{"gapMs":0}',
  ...over,
});

describe('記録の CSV', () => {
  it('日本時間・段階の名前・方式の名前で1行にする（Excel 用の BOM つき）', () => {
    const csv = eventsToCsv([row({})]);
    expect(csv.startsWith('﻿番号,')).toBe(true);
    expect(csv).toContain('1,2026-11-06 21:34:05.123,1,1,残り時間,95.4,捕獲,3,たけ,12,ゆう,音,"{""gapMs"":0}"');
  });

  it('= + - @ で始まる名前は、数式として動かないよう頭に \' を付ける', () => {
    const csv = eventsToCsv([row({ name: '=HYPERLINK("http://x")', other_name: '@SUM(1)' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`'@SUM(1)`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('長押しは「押した」「離した」に分けて出す', () => {
    const csv = eventsToCsv([row({ kind: 'hold', via: null, data: '{"on":true}' }), row({ id: 2, kind: 'hold', via: null, data: '{"on":false,"ms":1200}' })]);
    expect(csv).toContain(',長押し（押した）,');
    expect(csv).toContain(',長押し（離した）,');
  });

  it('日本時間の書き方', () => {
    expect(jst(Date.UTC(2026, 0, 1, 15, 0, 0, 5))).toBe('2026-01-02 00:00:00.005');
  });
});

describe('古いサーバーとつながったとき（公開の切り替わりの間）', () => {
  it('caught を送ってこなくても、捕まっていない扱い・人数は NaN にならない', () => {
    const game = {
      gameId: 'main', round: 1, assignId: 1, stage: 'timer', cv: 1, timer: startTimer([20_000, 60_000, 300_000, 120_000], 0),
      counts: { oni: 3, runner: 7, total: 10 }, result: null, durations: [20_000, 60_000, 300_000, 120_000],
    } as unknown as GameView;
    const me = { pid: 'a', num: 1, name: 'あ', role: 'runner', assignId: 1, removed: false } as unknown as MeView;
    const v = participantView(game, me, START_LEAD_MS + 90_000, true);
    expect(v.caught).toBe(false);
    expect(v.touch).toBe('runner');
    expect(v.runners).toBe('残り7/7');
  });
});

describe('走ると光るの記録', () => {
  it('光った・消えた（理由つき）を言葉で出す', () => {
    const csv = eventsToCsv([
      row({ kind: 'run', via: null, other_num: null, other_name: null, data: '{"lat":35.388,"lon":139.427,"acc":8}' }),
      row({ id: 2, kind: 'run-end', via: null, other_num: null, other_name: null, data: '{"reason":"stop","ms":12000,"m":40,"path":[]}' }),
      row({ id: 3, kind: 'run-end', via: null, other_num: null, other_name: null, data: '{"reason":"stale","ms":3000,"m":0,"path":[]}' }),
      row({ id: 4, kind: 'run-end', via: null, other_num: null, other_name: null, data: '{"reason":"caught","ms":3000,"m":0,"path":[]}' }),
    ]);
    expect(csv).toContain(',光った（走り出した）,');
    expect(csv).toContain(',消えた（止まった）,');
    expect(csv).toContain(',消えた（位置が届かなくなった）,');
    expect(csv).toContain(',消えた（捕まった）,');
  });
});
