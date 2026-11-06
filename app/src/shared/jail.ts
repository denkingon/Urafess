import type { GameView, Winner } from './protocol';

/**
 * 牢屋と終わり方の決まり。サーバーとスマホが同じものを使う（どちらで計算しても同じ答えになる）。
 *
 * - counts.caught は「いま牢屋にいる逃走者の数」（解放されると減る）
 * - allCaughtAt は、逃走者が全員同時に牢屋に入った時刻。入ったら、その配役はもう鬼の勝ちで決まり（あとで出る人がいても変わらない）
 */

/** 牢屋の外にいる逃走者の数 */
export function freeRunners(counts: GameView['counts']): number {
  return Math.max(0, counts.runner - (counts.caught ?? 0));
}

/** 逃走者が全員、いま牢屋にいる（逃走者が0人の配役では起きない） */
export function everyoneJailed(counts: GameView['counts']): boolean {
  return counts.runner > 0 && freeRunners(counts) === 0;
}

/** アプリが決める勝ち：全員が同時に牢屋に入ったことがあれば鬼、時間切れのとき1人でも外にいれば逃走者 */
export function decideWinner(game: Pick<GameView, 'counts' | 'allCaughtAt'>): Winner {
  if (game.allCaughtAt != null) return 'oni';
  return everyoneJailed(game.counts) ? 'oni' : 'runner';
}

/** 結果の理由（画面に出す一言） */
export function endReason(game: Pick<GameView, 'counts' | 'allCaughtAt'>): string {
  if (decideWinner(game) === 'oni') return '全員が牢屋に入った。';
  const free = freeRunners(game.counts);
  return `時間切れ。逃げ切った逃走者 ${free}人。`;
}
