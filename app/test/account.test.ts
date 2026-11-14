import { describe, expect, it } from 'vitest';
import { isHandoffCode, nightKeyOf, nightLabelOf, summarizeAccount, type AccountEvent } from '../src/shared/account';

/** 日本時間の時刻 → ms */
const jst = (s: string) => Date.parse(`${s}+09:00`);

let assign = 0;
const ev = (kind: string, at: string, e: Partial<AccountEvent> = {}): AccountEvent => ({
  at: jst(at),
  assign_id: e.assign_id ?? assign,
  kind,
  pid: e.pid ?? null,
  other_pid: e.other_pid ?? null,
  data: e.data ?? null,
});
const role = (pid: string, r: 'oni' | 'runner', at: string) => ev('role', at, { pid, data: JSON.stringify({ role: r, code: '123' }) });

describe('夜の区切り', () => {
  it('日本時間の朝6時で区切る（夜中の1時は前の日の夜）', () => {
    expect(nightKeyOf(jst('2026-11-06T21:30:00'))).toBe('2026-11-06');
    expect(nightKeyOf(jst('2026-11-07T01:30:00'))).toBe('2026-11-06');
    expect(nightKeyOf(jst('2026-11-07T06:00:00'))).toBe('2026-11-07');
    expect(nightLabelOf('2026-11-06')).toBe('11/6');
  });
});

describe('自分の記録を数える', () => {
  it('来た夜・役・捕まえた・捕まった・助けた（取り消しと配り直しは数えない）', () => {
    assign = 1;
    const events: AccountEvent[] = [
      // 11/6：入って、1回目は配り直してから始まる（配り直す前の役は数えない）
      ev('join', '2026-11-06T21:00:00', { pid: 'me' }),
      ev('join', '2026-11-06T21:00:05', { pid: 'a' }),
      role('me', 'runner', '2026-11-06T21:05:00'),
    ];
    assign = 2;
    events.push(role('me', 'oni', '2026-11-06T21:06:00'), role('a', 'runner', '2026-11-06T21:06:00'), ev('start', '2026-11-06T21:07:00'));
    // 自分（鬼）が a を捕まえる → 取り消し → もう一度捕まえる → a が助けられて、また捕まえる
    events.push(
      ev('capture', '2026-11-06T21:10:00', { pid: 'me', other_pid: 'a' }),
      ev('release', '2026-11-06T21:10:30', { pid: 'host', other_pid: 'a' }),
      ev('capture', '2026-11-06T21:11:00', { pid: 'me', other_pid: 'a' }),
      ev('rescue', '2026-11-06T21:12:00', { pid: 'b', other_pid: 'a' }),
      ev('capture', '2026-11-06T21:13:00', { pid: 'me', other_pid: 'a' }),
    );
    // 2回目（日付をまたいだ夜中）：自分が逃走者で捕まり、ほかの人を助ける
    assign = 3;
    events.push(
      role('me', 'runner', '2026-11-07T00:30:00'),
      ev('start', '2026-11-07T00:31:00'),
      ev('capture', '2026-11-07T00:35:00', { pid: 'a', other_pid: 'me' }),
      ev('rescue', '2026-11-07T00:40:00', { pid: 'me', other_pid: 'c' }),
    );
    // 3回目は配っただけで始まらなかった
    assign = 4;
    events.push(role('me', 'oni', '2026-11-07T01:00:00'));
    // 11/12：部屋では遊んだが、自分は来ていない
    assign = 5;
    events.push(ev('start', '2026-11-12T21:00:00'));
    // 11/13：名前のボタンで入っただけ（ラウンドは始まっていない）
    events.push(ev('enter', '2026-11-13T21:00:00', { pid: 'me' }));

    const s = summarizeAccount(events, 'me');
    expect(s.nights).toEqual([
      { key: '2026-11-06', label: '11/6', here: true },
      { key: '2026-11-12', label: '11/12', here: false },
      { key: '2026-11-13', label: '11/13', here: true },
    ]);
    expect(s.nightsHere).toBe(2);
    expect(s.roles).toEqual({ oni: 1, runner: 1 });
    expect(s.caught).toBe(2);
    expect(s.gotCaught).toBe(1);
    expect(s.freed).toBe(1);

    const a = summarizeAccount(events, 'a');
    expect(a.gotCaught).toBe(2);
    expect(a.caught).toBe(1);
    expect(a.roles).toEqual({ oni: 0, runner: 1 });
  });

  it('新しい夜（clear）で配役の番号が1に戻っても、夜ごとに別のラウンドとして数える', () => {
    const events: AccountEvent[] = [];
    // 11/6：1回目は鬼、2回目は逃走者（どちらも始まった）。2回目で b に捕まる
    assign = 1;
    events.push(ev('join', '2026-11-06T21:00:00', { pid: 'me' }), role('me', 'oni', '2026-11-06T21:05:00'), ev('start', '2026-11-06T21:06:00'));
    assign = 2;
    events.push(
      role('me', 'runner', '2026-11-06T21:30:00'),
      ev('start', '2026-11-06T21:31:00'),
      ev('capture', '2026-11-06T21:35:00', { pid: 'b', other_pid: 'me' }),
    );
    // 11/7：新しい夜。番号は1から。1回目は配っただけで配り直し、2回目で鬼として始まる
    assign = 0;
    events.push(ev('clear', '2026-11-07T20:00:00'));
    assign = 1;
    events.push(ev('enter', '2026-11-07T21:00:00', { pid: 'me' }), role('me', 'runner', '2026-11-07T21:05:00'));
    assign = 2;
    events.push(
      role('me', 'oni', '2026-11-07T21:06:00'),
      ev('start', '2026-11-07T21:07:00'),
      // 前の夜の2番と同じ番号の取り消しが、前の夜の捕獲を消さない
      ev('capture', '2026-11-07T21:10:00', { pid: 'me', other_pid: 'c' }),
      ev('release', '2026-11-07T21:10:30', { pid: 'me', other_pid: 'c' }),
    );

    const s = summarizeAccount(events, 'me');
    expect(s.roles).toEqual({ oni: 2, runner: 1 });
    expect(s.gotCaught).toBe(1);
    expect(s.caught).toBe(0);
    expect(s.nights.map((n) => n.label)).toEqual(['11/6', '11/7']);
    expect(s.nightsHere).toBe(2);
  });

  it('やり直し（reset）たラウンドの捕獲と助けた記録は数えない。やり直して始め直せば役は1回', () => {
    const events: AccountEvent[] = [];
    assign = 1;
    events.push(
      ev('join', '2026-11-06T21:00:00', { pid: 'me' }),
      role('me', 'runner', '2026-11-06T21:05:00'),
      ev('start', '2026-11-06T21:06:00'),
      ev('capture', '2026-11-06T21:08:00', { pid: 'b', other_pid: 'me' }),
      ev('rescue', '2026-11-06T21:09:00', { pid: 'me', other_pid: 'c' }),
      ev('reset', '2026-11-06T21:10:00'),
      // 同じ配役のまま始め直す：こちらの捕獲は数える
      ev('start', '2026-11-06T21:11:00'),
      ev('capture', '2026-11-06T21:15:00', { pid: 'b', other_pid: 'c' }),
    );
    // 2回目は始まってからやり直し、始め直さずに配り直した：役は数えない
    assign = 2;
    events.push(role('me', 'oni', '2026-11-06T21:30:00'), ev('start', '2026-11-06T21:31:00'), ev('reset', '2026-11-06T21:32:00'));
    assign = 3;
    events.push(role('me', 'runner', '2026-11-06T21:33:00'));

    const s = summarizeAccount(events, 'me');
    expect(s.roles).toEqual({ oni: 0, runner: 1 });
    expect(s.gotCaught).toBe(0);
    expect(s.freed).toBe(0);
    expect(summarizeAccount(events, 'b').caught).toBe(1);
  });

  it('記録が無い人はすべて0', () => {
    const s = summarizeAccount([], 'nobody');
    expect(s).toEqual({ nights: [], nightsHere: 0, roles: { oni: 0, runner: 0 }, caught: 0, gotCaught: 0, freed: 0 });
  });
});

describe('引き継ぎの合言葉', () => {
  it('6桁の数字だけ', () => {
    expect(isHandoffCode('012345')).toBe(true);
    expect(isHandoffCode('12345')).toBe(false);
    expect(isHandoffCode('1234567')).toBe(false);
    expect(isHandoffCode('12a456')).toBe(false);
    expect(isHandoffCode(123456)).toBe(false);
  });
});
