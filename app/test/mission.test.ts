import { describe, expect, it } from 'vitest';
import { meetCard, zoneCard } from '../src/client/views/mission';
import {
  cleanMissionSecs,
  cleanMissionTitle,
  countInZone,
  inZone,
  isMissionKind,
  isPhotoId,
  makeMeetGroups,
  MISSION_DEFAULT_TITLE,
  MISSION_DEFAULT_TITLES,
  MISSION_TITLE_MAX,
  missionClock,
  photosRevealed,
} from '../src/shared/mission';
import type { GameView, MeView, MissionView } from '../src/shared/protocol';
import { pauseTimer, startTimer } from '../src/shared/schedule';

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

describe('ミッションの種類（合流・範囲）', () => {
  /** 決まった並びの乱数（試験が毎回同じになるように） */
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  it('合流の組：1組だけは2人、全員は2人組（奇数なら最後の組だけ3人）。誰も2回は出ない', () => {
    expect(makeMeetGroups(ids(1), 'all', seeded(1))).toEqual([]);
    expect(makeMeetGroups(ids(0), 'one', seeded(1))).toEqual([]);
    for (const n of [2, 3, 4, 7, 10, 151]) {
      const one = makeMeetGroups(ids(n), 'one', seeded(n));
      expect(one.length).toBe(1);
      expect(new Set(one[0]).size).toBe(2);
      const all = makeMeetGroups(ids(n), 'all', seeded(n));
      expect(all.length).toBe(Math.floor(n / 2));
      expect(all.flat().sort()).toEqual(ids(n).sort());
      expect(all.slice(0, -1).every((g) => g.length === 2)).toBe(true);
      expect(all[all.length - 1].length).toBe(n % 2 === 1 ? 3 : 2);
    }
  });
  it('合流の組は、乱数で変わる', () => {
    const seen = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(makeMeetGroups(ids(6), 'one', seeded(i + 1))[0].sort())));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('範囲：中と、線から5m以内は数える。それより外は数えない', () => {
    // 約111m 四方（緯度 0.001 度）
    const sq: [number, number][] = [[35.0, 139.0], [35.0, 139.0012], [35.001, 139.0012], [35.001, 139.0]];
    expect(inZone(sq, { lat: 35.0005, lon: 139.0006 })).toBe(true);
    // 北の線から約3m 外
    expect(inZone(sq, { lat: 35.001 + 3 / 111_195, lon: 139.0006 })).toBe(true);
    // 北の線から約12m 外
    expect(inZone(sq, { lat: 35.001 + 12 / 111_195, lon: 139.0006 })).toBe(false);
    expect(countInZone(sq, [{ lat: 35.0005, lon: 139.0006 }, { lat: 35.01, lon: 139.0006 }, { lat: 35.0001, lon: 139.0001 }])).toBe(2);
  });

  it('締め切りまでの秒：空は「なし」、30〜900 の整数だけ', () => {
    expect(cleanMissionSecs(undefined)).toBeNull();
    expect(cleanMissionSecs(null)).toBeNull();
    expect(cleanMissionSecs(180)).toBe(180);
    expect(cleanMissionSecs(29)).toBe(false);
    expect(cleanMissionSecs(901)).toBe(false);
    expect(cleanMissionSecs(60.5)).toBe(false);
    expect(cleanMissionSecs('abc')).toBe(false);
  });

  it('試合のいま：配役のあと〜ゲームの段階は続ける、止めている間は止まる、ゲームの段階のあとは終わり、試合の外は外', () => {
    const d = [1000, 1000, 5000, 1000];
    const GAME = 2;
    expect(missionClock({ stage: 'lobby', timer: null }, 0, GAME)).toBe('off');
    expect(missionClock({ stage: 'assigned', timer: null }, 0, GAME)).toBe('live');
    const timer = startTimer(d, 10_000);
    const t0 = timer.t0;
    expect(missionClock({ stage: 'timer', timer }, t0 + 500, GAME)).toBe('live');
    expect(missionClock({ stage: 'timer', timer }, t0 + 3_000, GAME)).toBe('live');
    expect(missionClock({ stage: 'timer', timer }, t0 + 7_100, GAME)).toBe('over');
    expect(missionClock({ stage: 'timer', timer }, t0 + 60_000, GAME)).toBe('over');
    expect(missionClock({ stage: 'timer', timer: pauseTimer(timer, t0 + 3_000) }, t0 + 99_000, GAME)).toBe('paused');
    expect(missionClock({ stage: 'result', timer }, t0 + 3_000, GAME)).toBe('off');
    expect(missionClock({ stage: 'ended', timer: null }, 0, GAME)).toBe('off');
  });

  it('種類の名前と既定の題', () => {
    expect(isMissionKind('meet') && isMissionKind('zone') && isMissionKind('photo')).toBe(true);
    expect(isMissionKind('x')).toBe(false);
    expect(MISSION_DEFAULT_TITLES.photo).toBe(MISSION_DEFAULT_TITLE);
  });
});

describe('ミッションの札（参加者の画面の言葉）', () => {
  const game = { stage: 'timer', timer: startTimer([1000, 1000, 300_000, 1000], 0) } as unknown as GameView;
  const meBase = { pid: 'p', num: 1, name: 'あお', role: 'runner', caught: null, removed: false } as unknown as MeView;
  const meet = (over: Partial<MissionView> = {}): MissionView => ({
    id: 7,
    title: '指定された仲間と合流しろ',
    at: 10_000,
    open: true,
    kind: 'meet',
    until: 190_000,
    free: null,
    meet: { scope: 'all', groups: 2, ok: 0, pairs: [{ names: ['あお', 'みどり'], okAt: null }, { names: ['あか', 'きい'], okAt: null }] },
    done: null,
    ...over,
  });

  it('合流：逃走者には相手の名前と長押し。残り時間も出る', () => {
    const me = { ...meBase, meet: { missionId: 7, with: [{ name: 'みどり', jailed: false }], okAt: null } } as MeView;
    const c = meetCard(meet(), game, me, 70_000, false);
    expect(c.title).toBe('みどりと合流しろ');
    expect(c.action).toBe('meet');
    expect(c.mine).toBe('2人で同時に長押し（残り 2:00）');
    expect(c.ok).toBe('合流した組 0/2');
    expect(meetCard(meet(), game, me, 70_000, true).mine).toBe('みどりも同時に長押し。');
  });
  it('合流：相手が牢屋・自分が牢屋・合流したあとは、長押しを出さない', () => {
    const jailed = { ...meBase, meet: { missionId: 7, with: [{ name: 'みどり', jailed: true }], okAt: null } } as MeView;
    expect(meetCard(meet(), game, jailed, 70_000, false)).toMatchObject({ action: 'none', mine: 'みどりは牢屋にいる。先に助ける。（残り 2:00）' });
    const inJail = { ...meBase, caught: { byNum: 2, byName: 'しろ', at: 1, via: 'host' }, meet: { missionId: 7, with: [{ name: 'みどり', jailed: false }], okAt: null } } as MeView;
    expect(meetCard(meet(), game, inJail, 70_000, false)).toMatchObject({ action: 'none', mine: '牢屋にいる間は合流できない。' });
    const met = { ...meBase, meet: { missionId: 7, with: [{ name: 'みどり', jailed: false }], okAt: 50_000 } } as MeView;
    expect(meetCard(meet(), game, met, 70_000, false)).toMatchObject({ action: 'none', mine: '合流した。成功。', mineState: 'ok' });
  });
  it('合流：3人の組は「どちらかと」', () => {
    const me = { ...meBase, meet: { missionId: 7, with: [{ name: 'みどり', jailed: false }, { name: 'あか', jailed: true }], okAt: null } } as MeView;
    const c = meetCard(meet({ until: null }), game, me, 70_000, false);
    expect(c.title).toBe('みどり・あかと合流しろ');
    expect(c.mine).toBe('どちらかと2人で同時に長押し');
  });
  it('合流：鬼には、誰と誰が合流しようとしているかが見える', () => {
    const oni = { ...meBase, role: 'oni', meet: null } as MeView;
    const all = meetCard(meet(), game, oni, 70_000, false);
    expect(all.title).toBe('合流を止めろ（2組）');
    expect(all.action).toBe('clock');
    expect(all.clock).toBe('2:00');
    expect(all.mine).toBe('あお×みどり、あか×きい');
    const one = meetCard(meet({ meet: { scope: 'one', groups: 1, ok: 0, pairs: [{ names: ['あお', 'みどり'], okAt: null }] } }), game, oni, 70_000, false);
    expect(one.title).toBe('あお×みどりの合流を止めろ');
    expect(one.mine).toBe('2人が会う前に捕まえる。');
    const helper = meetCard(meet({ meet: { scope: 'one', groups: 1, ok: 0, pairs: [{ names: ['あお', 'みどり'], okAt: null }] } }), game, { ...meBase, name: 'あか', meet: null } as MeView, 70_000, false);
    expect(helper).toMatchObject({ title: 'あお×みどりを合流させろ', mine: '2人が会えるように助ける。', action: 'clock' });
    const failed = meetCard(
      meet({ open: false, done: { ok: false, at: 1, freed: 0, count: 0 }, meet: { scope: 'one', groups: 1, ok: 0, pairs: [{ names: ['あお', 'みどり'], okAt: null }] } }),
      game,
      oni,
      70_000,
      false,
    );
    expect(failed.ok).toBe('失敗：あおとみどりは合流できなかった');
  });

  const sq: [number, number][] = [[35.0, 139.0], [35.0, 139.0012], [35.001, 139.0012], [35.001, 139.0]];
  const zone = (over: Partial<MissionView> = {}): MissionView => ({
    id: 8,
    title: '指定の範囲に集まれ',
    at: 10_000,
    open: true,
    kind: 'zone',
    until: 100_000,
    free: null,
    zone: { pts: sq, need: 5, now: 3 },
    done: null,
    ...over,
  });
  it('範囲：人数・残り時間・自分が中か外か（外なら向きと距離）', () => {
    const me = { ...meBase, meet: null } as MeView;
    const inside = zoneCard(zone(), game, me, 40_000, { lat: 35.0005, lon: 139.0006 });
    expect(inside).toMatchObject({ title: '範囲に5人集まれ', action: 'clock', clock: '1:00', mine: 'いま中に 3/5人・自分は中' });
    const outside = zoneCard(zone(), game, me, 40_000, { lat: 35.0005, lon: 139.0023 });
    expect(outside.mine).toMatch(/^いま中に 3\/5人・自分は外（西 /);
    expect(zoneCard(zone(), game, me, 40_000, null).mine).toBe('いま中に 3/5人・地図の光る枠へ');
    const oni = { ...meBase, role: 'oni', meet: null } as MeView;
    expect(zoneCard(zone(), game, oni, 40_000, null).mine).toBe('いま中に 3/5人・地図の光る枠');
  });
  it('範囲：結果', () => {
    const me = { ...meBase, meet: null } as MeView;
    const ok = zoneCard(zone({ open: false, zone: { pts: sq, need: 5, now: null }, done: { ok: true, at: 1, freed: 2, count: 6 } }), game, me, 0, null);
    expect(ok).toMatchObject({ action: 'none', mine: '成功：6人が集まった。牢屋から2人出た', mineState: 'ok' });
    const no = zoneCard(zone({ open: false, zone: { pts: sq, need: 5, now: null }, done: { ok: false, at: 1, freed: 0, count: 2 } }), game, me, 0, null);
    expect(no).toMatchObject({ mine: '失敗：集まったのは2/5人', mineState: 'no' });
    const none = zoneCard(zone({ open: false, zone: { pts: sq, need: 5, now: null }, done: null }), game, me, 0, null);
    expect(none.ok).toBe('締め切った（判定なし）。');
  });
  it('止めている間は、残り時間が止まる', () => {
    const paused = { stage: 'timer', timer: pauseTimer(game.timer!, 5_000) } as unknown as GameView;
    expect(zoneCard(zone(), paused, { ...meBase, meet: null } as MeView, 40_000, null).clock).toBe('止');
  });
});
