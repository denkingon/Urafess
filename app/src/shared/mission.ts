import type { GameView } from './protocol';
import { isDone } from './schedule';

/**
 * ミッション（集合写真）：主催者がミッションを出す → 参加者がスマホで撮って送る →
 * 主催者が写真を見て「成功」か「やり直し」を押す → 成功は全員の画面に名前が出る →
 * 写真そのものは結果発表（試合が動いていない間）に全員の画面に出る → 写真は名簿と一緒にずっと残る。
 */

/** 主催者が題を空のまま出したときの題 */
export const MISSION_DEFAULT_TITLE = '集合写真を撮れ';
/** 題の長さの上限（文字） */
export const MISSION_TITLE_MAX = 40;

/** スマホが縮めてから送る写真の、長い辺のピクセル数 */
export const PHOTO_LONG_EDGE = 1600;
/** JPEG の質（0〜1）。大きすぎたら下げて作り直す */
export const PHOTO_QUALITY = 0.8;
/**
 * 1枚の上限（バイト）。サーバーの保存（Durable Objects の SQLite）は1行 2MB までなので、それより小さく。
 * 1600px・質0.8 でふつう 0.3〜0.6MB
 */
export const PHOTO_MAX_BYTES = 1_500_000;
/** 1つのミッションで1人が送れる枚数（「やり直し」の分も数える） */
export const PHOTO_PER_PERSON = 5;
/**
 * 写真の保存の上限（全部の夜の合計、バイト）。無料プランは1つの部屋（Durable Object）に 1GB まで。
 * 名簿・記録の分を空けておく。超えたら新しい写真を断る（主催者画面に出る）
 */
export const PHOTO_STORE_MAX_BYTES = 800_000_000;

/** 写真の状態：pending＝主催者が見る前、ok＝成功、no＝やり直し */
export type PhotoStatus = 'pending' | 'ok' | 'no';

export const PHOTO_STATUS_NAME: Record<PhotoStatus, string> = { pending: '主催者が見ている', ok: '成功', no: 'やり直し' };

/**
 * 写真そのものを全員に見せてよいか。試合が動いている間（配役〜時間が0になるまで）は見せない
 * （写真に写った場所で隠れ場所が分かるため）。結果発表・待合室・夜の最後は見せる。
 * 成功したかどうか（名前）は、いつでも全員に見える
 */
export function photosRevealed(game: Pick<GameView, 'stage' | 'timer'>, now: number): boolean {
  if (game.stage === 'assigned') return false;
  if (game.stage === 'timer') return game.timer !== null && isDone(game.timer, now);
  return true;
}

/** 主催者が入れた題を整える（前後の空白・改行・制御文字を消し、長すぎれば切る）。空なら既定の題 */
export function cleanMissionTitle(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  const t = s
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, MISSION_TITLE_MAX).join('') || MISSION_DEFAULT_TITLE;
}

/** 写真の印（推測できない長さ）。URL にそのまま使える文字だけ */
export function isPhotoId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
}
