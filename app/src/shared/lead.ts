// 司令塔（鬼の側・逃走者の側に1人ずつ）。本部のデッキで入れたり外したりする。
//
// 入れると：
// - 全体の地図（仲間の居場所）は司令塔だけが見られる。ほかの人は「近く」の光の地図だけになる
// - 司令塔は見る代わりに見られる（seen）：ゲームの段階の間、名前と場所が全員の画面にずっと光る
// - 逃走者の司令塔が捕まると「落ちる」。落ちている間：
//     dark   ＝ 司令塔の地図が消える（逃走者の側から地図が無くなる）
//     expose ＝ 鬼の全員に、逃走者の全員の居場所が見える
//     restore＝ 牢屋から司令塔を助ければ元に戻る（切ると、その配役の終わりまで落ちたまま）
// - 鬼は捕まらないので、鬼の司令塔は落ちない（代わりにずっと見られている）
// 外すと、前のまま（同じ役の仲間が全員、全体の地図を見られる）。

import type { RoleId } from './rules';

export interface LeadRules {
  /** 司令塔のしくみを入れる */
  on: boolean;
  /** 司令塔は常に相手に見える（全員の画面に光る） */
  seen: boolean;
  /** 逃走者の司令塔が落ちたら、司令塔の地図が消える */
  dark: boolean;
  /** 逃走者の司令塔が落ちたら、鬼に逃走者の全員が見える */
  expose: boolean;
  /** 司令塔を牢屋から助ければ元に戻る */
  restore: boolean;
}

export const LEAD_RULE_KEYS = ['on', 'seen', 'dark', 'expose', 'restore'] as const;
export type LeadRuleKey = (typeof LEAD_RULE_KEYS)[number];

/** はじめは外してある。入れたときの札は全部入り（本人が選んだ4枚） */
export const DEFAULT_LEAD_RULES: LeadRules = { on: false, seen: true, dark: true, expose: true, restore: true };

export function isLeadRules(r: unknown): r is LeadRules {
  if (typeof r !== 'object' || r === null) return false;
  return LEAD_RULE_KEYS.every((k) => typeof (r as Record<string, unknown>)[k] === 'boolean');
}

/** 主催者が送ってきた変え方（一部だけでいい）を、いまの札に重ねる。形がおかしければ null */
export function patchLeadRules(base: LeadRules, patch: unknown): LeadRules | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return null;
  const next = { ...base };
  let touched = false;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(LEAD_RULE_KEYS as readonly string[]).includes(k) || typeof v !== 'boolean') return null;
    next[k as LeadRuleKey] = v;
    touched = true;
  }
  return touched ? next : null;
}

/**
 * 逃走者の司令塔が「落ちている」か。
 * caughtNow＝いま牢屋にいる、fellAt＝この配役で初めて捕まった時刻（まだなら null）。
 * 助ければ戻る札が入っていれば牢屋にいる間だけ、切ってあれば一度落ちたらその配役の終わりまで
 */
export function leadDown(rules: LeadRules, caughtNow: boolean, fellAt: number | null): boolean {
  if (!rules.on) return false;
  return rules.restore ? caughtNow : fellAt !== null || caughtNow;
}

export interface LeadSight {
  /** 同じ役の仲間の居場所が見える */
  mates: boolean;
  /** 相手（逃走者）の全員の居場所が見える。鬼の側だけ */
  foes: boolean;
  /** 全体の地図を出す（mates か foes のどちらかが見える） */
  map: boolean;
}

/**
 * その人に何が見えるか。role＝その人の役、isLead＝その人が自分の側の司令塔、down＝逃走者の司令塔が落ちている。
 * しくみを外してあれば、前のまま（仲間は全員見える・相手は見えない）
 */
export function leadSight(rules: LeadRules, role: RoleId, isLead: boolean, down: boolean): LeadSight {
  if (!rules.on) return { mates: true, foes: false, map: true };
  const foes = role === 'oni' && down && rules.expose;
  const mates = isLead && !(role === 'runner' && down && rules.dark);
  return { mates, foes, map: mates || foes };
}
