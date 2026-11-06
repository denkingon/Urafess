import { describe, expect, it } from 'vitest';
import type { GameView, MeView } from '../src/shared/protocol';
import { START_LEAD_MS } from '../src/shared/rules';
import { pauseTimer, startTimer } from '../src/shared/schedule';
import { FAREWELL, hostStatus, participantView } from '../src/shared/viewmodel';

const D = [20_000, 60_000, 300_000, 120_000];

function game(partial: Partial<GameView>): GameView {
  return {
    gameId: 'main', round: 1, assignId: 1, stage: 'assigned', cv: 1, timer: null,
    counts: { oni: 9, runner: 21, total: 30, caught: 0 }, result: null, durations: D, ...partial,
  };
}
const oni: MeView = {
  pid: 'a', num: 1, name: 'あ', role: 'oni', assignId: 1, removed: false, code: '123', caught: null, catches: 0, claim: null,
};
const runner: MeView = { ...oni, pid: 'b', role: 'runner' };

describe('参加者の画面（キャンバスの Phone に渡す中身）', () => {
  it('配役前はロビー', () => {
    const v = participantView(game({ stage: 'lobby', assignId: 0 }), { ...oni, role: null, assignId: 0 }, 0, true);
    expect(v).toMatchObject({ role: 'なし', step: 0, label: '配役を待っている', big: '30人', oni: '?' });
  });

  it('配役で自分の役が出る', () => {
    expect(participantView(game({}), oni, 0, true)).toMatchObject({ role: '鬼', step: 1, big: '鬼' });
    expect(participantView(game({}), runner, 0, true)).toMatchObject({ role: '逃走者', step: 1, big: '逃走者' });
  });

  it('1ラウンドの段階と残り時間', () => {
    const t = startTimer(D, 0);
    const g = game({ stage: 'timer', timer: t });
    const at = (ms: number) => participantView(g, runner, START_LEAD_MS + ms, true);
    expect(at(-1_000)).toMatchObject({ step: 2, label: '逃走開始まで', big: '0:20' });
    expect(at(20_000)).toMatchObject({ step: 3, label: '追跡開始まで', big: '1:00' });
    expect(at(80_000)).toMatchObject({ step: 4, label: '残り時間', big: '5:00', message: '逃げ切れ。' });
    expect(participantView(g, oni, START_LEAD_MS + 80_000, true).message).toBe('捕まえろ。');
    expect(at(380_000)).toMatchObject({ step: 5, label: '広場に戻るまで', big: '2:00' });
    expect(at(500_000)).toMatchObject({ step: 6, label: '結果発表', big: '発表待ち' });
  });

  it('一時停止中は止まった数字', () => {
    const t = pauseTimer(startTimer(D, 0), START_LEAD_MS + 100_000);
    const v = participantView(game({ stage: 'timer', timer: t }), runner, 9_999_999, true);
    expect(v).toMatchObject({ step: 4, big: '4:40' });
    expect(v.label).toContain('一時停止中');
  });

  it('結果発表', () => {
    expect(participantView(game({ stage: 'result', result: 'runner' }), oni, 0, true)).toMatchObject({ step: 6, big: '逃走者の勝ち' });
  });

  it('配役のあとに来た人は次の配役から', () => {
    const late: MeView = { ...runner, role: null, assignId: 0 };
    expect(participantView(game({}), late, 0, true)).toMatchObject({ role: 'なし', label: '次の配役から参加' });
  });

  it('捕獲の長押しボタンは「ゲーム」の段階（終わった直後の10秒を含む）だけ。捕まった人には出さない', () => {
    const t = startTimer(D, 0);
    const g = game({ stage: 'timer', timer: t, counts: { oni: 9, runner: 21, total: 30, caught: 3 } });
    const at = (me: MeView, ms: number) => participantView(g, me, START_LEAD_MS + ms, true);
    expect(at(runner, 30_000).touch).toBe('none');
    expect(at(runner, 80_000).touch).toBe('runner');
    expect(at(oni, 80_000).touch).toBe('oni');
    expect(at(oni, 385_000).touch).toBe('oni');
    expect(at(oni, 391_000).touch).toBe('none');
    expect(at(runner, 80_000).runners).toBe('残り18/21');
    const caught: MeView = { ...runner, caught: { byNum: 1, byName: 'あ', at: 0, via: 'sound' } };
    expect(at(caught, 80_000)).toMatchObject({ touch: 'none', caught: true, label: '残り時間・捕まった' });
    expect(at(caught, 80_000).message).toContain('あに捕まった');
  });

  it('通信が切れていたら、そう出す', () => {
    expect(participantView(game({}), oni, 0, false).offline).toBe(true);
  });

  it('夜の最後は、役にかかわらず全員が SEE YOU AGAIN だけを見る', () => {
    const ended = game({ stage: 'ended', result: 'runner' });
    expect(FAREWELL).toBe('SEE YOU AGAIN');
    for (const me of [oni, runner, { ...oni, role: null, assignId: 0 }, { ...oni, removed: true }]) {
      expect(participantView(ended, me, 0, true)).toMatchObject({ step: 6, big: 'SEE YOU AGAIN', message: '', touch: 'none', caught: false, ended: true });
    }
    // 終わっていない画面には ended が付かない
    expect(participantView(game({ stage: 'result', result: 'runner' }), oni, 0, true).ended).toBeUndefined();
  });

  it('夜の最後の主催者画面は、再開か部屋を空にするを案内する', () => {
    expect(hostStatus(game({ stage: 'ended' }), 0)).toMatchObject({ title: '夜は終わった', big: 'SEE YOU AGAIN' });
  });

  it('走ると光る：配役〜追跡開始までは準備、ゲームの段階は地図。光るのは、配役に入っていて捕まっていない人が、ゲームの段階が動いている間だけ', () => {
    const t = startTimer(D, 0);
    const g = game({ stage: 'timer', timer: t });
    const at = (me: MeView, ms: number) => participantView(g, me, START_LEAD_MS + ms, true);
    expect(participantView(game({ stage: 'lobby', assignId: 0 }), { ...oni, role: null, assignId: 0 }, 0, true).glow).toBe('none');
    expect(participantView(game({}), runner, 0, true)).toMatchObject({ glow: 'prep', lightable: false });
    expect(at(runner, 10_000)).toMatchObject({ glow: 'prep', lightable: false });
    expect(at(runner, 30_000)).toMatchObject({ glow: 'prep', lightable: false });
    expect(at(runner, 80_000)).toMatchObject({ glow: 'live', lightable: true });
    expect(at(oni, 80_000)).toMatchObject({ glow: 'live', lightable: true });
    // 捕獲と違い、終わった直後の猶予は無い
    expect(at(oni, 380_500)).toMatchObject({ glow: 'none', lightable: false });
    expect(at(oni, 500_000)).toMatchObject({ glow: 'none', lightable: false });
    // 捕まった人・見学の人は、地図は見えるが光らない
    const caught: MeView = { ...runner, caught: { byNum: 1, byName: 'あ', at: 0, via: 'sound' } };
    expect(at(caught, 80_000)).toMatchObject({ glow: 'live', lightable: false });
    const late: MeView = { ...runner, role: null, assignId: 0 };
    expect(at(late, 80_000)).toMatchObject({ glow: 'live', lightable: false });
    // 一時停止中は地図を出したまま、誰も光らない
    const paused = game({ stage: 'timer', timer: pauseTimer(t, START_LEAD_MS + 100_000) });
    expect(participantView(paused, runner, 9_999_999, true)).toMatchObject({ glow: 'live', lightable: false });
    expect(participantView(game({ stage: 'result', result: 'oni' }), runner, 0, true).glow).toBe('none');
  });
});
