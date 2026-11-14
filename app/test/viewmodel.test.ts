import { describe, expect, it } from 'vitest';
import type { GameView, MeView } from '../src/shared/protocol';
import { START_LEAD_MS } from '../src/shared/rules';
import { pauseTimer, startTimer } from '../src/shared/schedule';
import { FAREWELL, hostStatus, participantView, BOOT_QUIET_MS, bootQuiet } from '../src/shared/viewmodel';

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
    // 時間が0になったら、アプリが決めた結果を出す（1人でも牢屋の外にいれば逃走者の勝ち）
    expect(at(500_000)).toMatchObject({ step: 6, label: '結果発表', big: '逃走者の勝ち' });
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
    expect(at(caught, 80_000)).toMatchObject({ touch: 'none', caught: true, label: '残り時間・牢屋', rescue: 'help' });
    expect(at(caught, 80_000).message).toContain('牢屋で待つ');
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

  it('見た目の層：段階ごとの絵とひとこと（日本語・英語）、大きい数字、人数の印', () => {
    const t = startTimer(D, 0);
    const g = game({ stage: 'timer', timer: t, counts: { oni: 3, runner: 7, total: 10, caught: 1 } });
    const at = (me: MeView, ms: number) => participantView(g, me, START_LEAD_MS + ms, true);
    expect(at(runner, 5_000)).toMatchObject({ scene: 'ready', word: ['待つ', 'WAIT'], time: '0:15' });
    expect(at(runner, 30_000)).toMatchObject({ scene: 'run', word: ['逃げろ', 'RUN'] });
    expect(at(oni, 30_000)).toMatchObject({ scene: 'chaser', word: ['待つ', 'WAIT'] });
    expect(at(runner, 100_000)).toMatchObject({ scene: 'wall', word: ['隠れろ', 'HIDE'], counts: { oni: 3, runners: 7, left: 6 } });
    expect(at(oni, 100_000)).toMatchObject({ scene: 'search', word: ['探せ', 'HUNT'] });
    expect(at(runner, 400_000)).toMatchObject({ scene: 'gather', word: ['戻る', 'BACK'] });
    expect(at(runner, 0).times).toEqual(['0:20', '1:00', '5:00', '2:00']);
    const caught: MeView = { ...runner, caught: { byNum: 1, byName: 'さむ', at: 0, via: 'sound' } };
    expect(at(caught, 100_000)).toMatchObject({ scene: 'jail', word: ['牢屋', 'JAIL'], rescue: 'help' });
    const lobby = participantView(game({ stage: 'lobby', assignId: 0 }), { ...oni, role: null, assignId: 0 }, 0, true);
    expect(lobby).toMatchObject({ scene: 'gather', time: '30', unit: 'person', counts: null });
    expect(participantView(game({}), oni, 0, true)).toMatchObject({ scene: 'chaser', word: ['鬼', 'CHASER'], time: null });
  });

  it('結果は、自分の側が勝ったか負けたかで出す', () => {
    const g = game({ stage: 'result', result: 'runner' });
    expect(participantView(g, runner, 0, true)).toMatchObject({ outcome: 'win', word: ['勝ち', 'WIN'], note: ['逃走者の勝ち', 'Runners win'] });
    expect(participantView(g, oni, 0, true)).toMatchObject({ outcome: 'lose', word: ['負け', 'LOSE'] });
    // 結果がまだ無ければ、アプリと同じ決め方で出す（誰も牢屋にいなければ逃走者の勝ち）
    expect(participantView(game({ stage: 'result', result: null }), oni, 0, true)).toMatchObject({ outcome: 'lose', word: ['負け', 'LOSE'] });
  });

  it('主催者が時間を変えたら、段階バーの時間も変わる', () => {
    const t = startTimer([30_000, 90_000, 600_000, 60_000], 0);
    expect(participantView(game({ stage: 'timer', timer: t }), runner, 0, true).times).toEqual(['0:30', '1:30', '10:00', '1:00']);
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

  describe('牢屋と終わり方', () => {
    const t = startTimer(D, 0);
    const inGame = START_LEAD_MS + 100_000;
    const jailed: MeView = { ...runner, caught: { byNum: 1, byName: 'あ', at: 0, via: 'sound' } };

    it('牢屋に仲間がいれば、外の逃走者に「助ける」が出る。鬼には出ない', () => {
      const g = game({ stage: 'timer', timer: t, counts: { oni: 3, runner: 7, total: 10, caught: 2 } });
      expect(participantView(g, runner, inGame, true).rescue).toBe('save');
      expect(participantView(g, oni, inGame, true).rescue).toBe('none');
      const none = game({ stage: 'timer', timer: t, counts: { oni: 3, runner: 7, total: 10, caught: 0 } });
      expect(participantView(none, runner, inGame, true).rescue).toBe('none');
      // ゲームの段階の外では出ない
      expect(participantView(g, jailed, START_LEAD_MS + 30_000, true).rescue).toBe('none');
    });

    it('牢屋から出た直後は「捕まった」を出さず、残りの秒を出す', () => {
      const g = game({ stage: 'timer', timer: t, counts: { oni: 3, runner: 7, total: 10, caught: 1 } });
      const v = participantView(g, { ...runner, freeUntil: inGame + 4_200 }, inGame, true);
      expect(v).toMatchObject({ touch: 'none', label: '残り時間・捕まらない', immuneMs: 4_200 });
      expect(v.message).toContain('あと5秒');
      expect(participantView(g, { ...runner, freeUntil: inGame - 1 }, inGame, true).touch).toBe('runner');
    });

    it('全員が牢屋に入ったら、もう出られない。結果は鬼の勝ち', () => {
      const g = game({ stage: 'timer', timer: t, counts: { oni: 3, runner: 7, total: 10, caught: 7 }, allCaughtAt: inGame });
      expect(participantView(g, jailed, inGame, true)).toMatchObject({ rescue: 'none' });
      expect(participantView(g, jailed, inGame, true).message).toContain('全員が牢屋に入った');
      expect(participantView(g, oni, START_LEAD_MS + 400_000, true).message).toContain('全員が牢屋に入った');
      expect(participantView(g, oni, START_LEAD_MS + 600_000, true)).toMatchObject({ step: 6, big: '鬼の勝ち' });
      expect(hostStatus(g, START_LEAD_MS + 600_000).big).toBe('鬼の勝ち');
    });

    it('アプリが決めた結果は理由も出す。主催者が直したら、その勝ちを出す', () => {
      const auto = game({ stage: 'result', result: 'runner', resultAuto: true, counts: { oni: 3, runner: 7, total: 10, caught: 4 } });
      expect(participantView(auto, oni, 0, true).message).toContain('逃げ切った逃走者 3人');
      const host = game({ stage: 'result', result: 'oni', resultAuto: false, counts: { oni: 3, runner: 7, total: 10, caught: 4 } });
      expect(participantView(host, oni, 0, true).big).toBe('鬼の勝ち');
    });
  });
});

describe('開いてすぐの画面', () => {
  it('最初の返事が来るまでは何も描かない。返事が来たら・待っても来なければ・圏外なら描く', () => {
    expect(bootQuiet(false, 0, true)).toBe(true);
    expect(bootQuiet(false, BOOT_QUIET_MS - 1, true)).toBe(true);
    expect(bootQuiet(true, 10, true)).toBe(false);
    expect(bootQuiet(false, BOOT_QUIET_MS, true)).toBe(false);
    expect(bootQuiet(false, 0, false)).toBe(false);
  });
});
