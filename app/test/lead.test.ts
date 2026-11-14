import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_RULES, isLeadRules, leadDown, leadSight, patchLeadRules, type LeadRules } from '../src/shared/lead';

const on: LeadRules = { ...DEFAULT_LEAD_RULES, on: true };

describe('司令塔の札', () => {
  it('はじめは外してあり、入れたときの札は全部入り', () => {
    expect(DEFAULT_LEAD_RULES).toEqual({ on: false, seen: true, dark: true, expose: true, restore: true });
    expect(isLeadRules(DEFAULT_LEAD_RULES)).toBe(true);
    expect(isLeadRules({ on: true })).toBe(false);
    expect(isLeadRules(null)).toBe(false);
  });

  it('変える札だけを重ねる。知らない札・真偽でない値・空は断る', () => {
    expect(patchLeadRules(DEFAULT_LEAD_RULES, { on: true })).toEqual(on);
    expect(patchLeadRules(on, { dark: false, expose: false })).toEqual({ ...on, dark: false, expose: false });
    expect(patchLeadRules(on, {})).toBeNull();
    expect(patchLeadRules(on, { nope: true })).toBeNull();
    expect(patchLeadRules(on, { on: 1 })).toBeNull();
    expect(patchLeadRules(on, [true])).toBeNull();
    expect(patchLeadRules(on, null)).toBeNull();
  });

  it('落ちている：助ければ戻る札なら牢屋にいる間だけ、切ってあれば一度落ちたらずっと', () => {
    expect(leadDown(on, true, 100)).toBe(true);
    expect(leadDown(on, false, 100)).toBe(false);
    expect(leadDown({ ...on, restore: false }, false, 100)).toBe(true);
    expect(leadDown({ ...on, restore: false }, false, null)).toBe(false);
    expect(leadDown({ ...on, restore: false }, true, null)).toBe(true);
    expect(leadDown(DEFAULT_LEAD_RULES, true, 100)).toBe(false);
  });
});

describe('司令塔：誰に何が見えるか', () => {
  it('外してあれば前のまま（仲間は全員・相手は見えない）', () => {
    for (const role of ['oni', 'runner'] as const) {
      for (const lead of [true, false]) expect(leadSight(DEFAULT_LEAD_RULES, role, lead, true)).toEqual({ mates: true, foes: false, map: true });
    }
  });

  it('入れると、仲間が見えるのは司令塔だけ', () => {
    for (const role of ['oni', 'runner'] as const) {
      expect(leadSight(on, role, true, false)).toEqual({ mates: true, foes: false, map: true });
      expect(leadSight(on, role, false, false)).toEqual({ mates: false, foes: false, map: false });
    }
  });

  it('逃走者の司令塔が落ちると：司令塔の地図が消え、鬼の全員に逃走者が見える', () => {
    expect(leadSight(on, 'runner', true, true)).toEqual({ mates: false, foes: false, map: false });
    expect(leadSight(on, 'runner', false, true)).toEqual({ mates: false, foes: false, map: false });
    expect(leadSight(on, 'oni', true, true)).toEqual({ mates: true, foes: true, map: true });
    expect(leadSight(on, 'oni', false, true)).toEqual({ mates: false, foes: true, map: true });
  });

  it('札を1枚ずつ外せる', () => {
    expect(leadSight({ ...on, dark: false }, 'runner', true, true)).toEqual({ mates: true, foes: false, map: true });
    expect(leadSight({ ...on, expose: false }, 'oni', false, true)).toEqual({ mates: false, foes: false, map: false });
    expect(leadSight({ ...on, expose: false }, 'oni', true, true)).toEqual({ mates: true, foes: false, map: true });
  });
});
