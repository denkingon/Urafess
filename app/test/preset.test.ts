import { describe, expect, it } from 'vitest';
import { basePreset, cleanPreset, cleanPresets, defaultPresets, presetSummary } from '../src/shared/preset';
import { blockSecs, defaultNightPlan, hhmm, nightIssues, placeNight } from '../src/shared/night';

describe('プリセット', () => {
  it('最初のプリセットは確かめを通る', () => {
    expect(cleanPresets(defaultPresets())).toEqual(defaultPresets());
  });

  it('足りない札は最初の値で埋める（Claude が名前と一部だけ書いたものでも入る）', () => {
    const p = cleanPreset({ id: 'x1', name: '雨の夜', round: { cast: 30, phases: [20, 30, 240, 60], result: 120 }, ratio: { oni: 2, runner: 8 } });
    expect(p).not.toBeNull();
    expect(p!.mic).toBe(basePreset('a', 'a').mic);
    expect(p!.ratio).toEqual({ oni: 2, runner: 8 });
  });

  it('おかしな中身は受け取らない', () => {
    expect(cleanPreset({ id: 'x', name: '' })).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', mode: 'tag' })).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', round: { cast: 0, phases: [0, 1, 1, 1], result: 0 } })).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', shrink: { times: 1, finalArea: 0.25, to: 'pick', pick: [35, 139], mission: false } })).toBeNull();
    expect(cleanPresets([{ id: 'a', name: 'a' }, { id: 'a', name: 'b' }])).toBeNull();
  });

  it('遊ぶ範囲：そのまま（null）・範囲なし・形。前の版のプリセット（area が無い）はそのまま', () => {
    const sq: [number, number][] = [[35.39, 139.4253], [35.39, 139.4292], [35.3864, 139.4292], [35.3864, 139.4253]];
    expect(cleanPreset({ id: 'x', name: 'a' })!.area).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', area: null })!.area).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', area: 'none' })!.area).toBe('none');
    expect(cleanPreset({ id: 'x', name: 'a', area: sq })!.area).toEqual(sq);
    // 小数6桁にそろえる
    expect(cleanPreset({ id: 'x', name: 'a', area: [[35.3900001234, 139.4253], sq[1], sq[2]] })!.area![0]).toEqual([35.39, 139.4253]);
    // 2点・遠すぎる点・形でないものは受け取らない
    expect(cleanPreset({ id: 'x', name: 'a', area: sq.slice(0, 2) })).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', area: [...sq, [35.0, 135.0]] })).toBeNull();
    expect(cleanPreset({ id: 'x', name: 'a', area: 'all' })).toBeNull();
    expect(presetSummary(cleanPreset({ id: 'x', name: 'a', area: sq })!)).toMatch(/範囲つき$/);
    expect(presetSummary(cleanPreset({ id: 'x', name: 'a', area: 'none' })!)).toMatch(/範囲なし$/);
  });

  it('要約', () => {
    expect(presetSummary(defaultPresets()[2])).toBe('ドロケイ・ゲーム7:00・鬼3:逃7・希望を聞く・全員同時・マイクずっと・司令塔・縮む2回・ミッション・チャット札');
  });

  it('夜の予定：プレ・本番の長さはプリセットの時間。このブロックだけの時間があればそちら。詳細なしは分', () => {
    const presets = defaultPresets();
    const plan = defaultNightPlan();
    expect(blockSecs(plan.blocks[1], presets)).toBe(8 * 60);
    expect(blockSecs(plan.blocks[2], presets)).toBe(12 * 60 + 20);
    expect(hhmm(placeNight(plan, presets).end)).toBe('22:22');
    plan.blocks[4].round = { cast: 60, phases: [20, 60, 420, 120], result: 180 };
    expect(blockSecs(plan.blocks[4], presets)).toBe(14 * 60 + 20);
    plan.blocks[2].preset = null;
    expect(blockSecs(plan.blocks[2], presets)).toBe(13 * 60);
    plan.blocks[1].preset = 'gone';
    expect(nightIssues(plan, presets).map((i) => i.text)).toContain('「プレ」のプリセットが消えている');
  });
});
