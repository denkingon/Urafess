import { checkArea } from './area';
import type { GameView } from './protocol';
import type { LatLon } from './run';
import { isDone, positionAt } from './schedule';

/**
 * ミッション。種類は3つ（集合写真・合流・範囲。下の「まとめて扱う層」）。ここから下は集合写真の決まり。
 * 集合写真：主催者がミッションを出す → 参加者がスマホで撮って送る →
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

// ---------- ミッションの種類（集合写真・合流・範囲）をまとめて扱う層 ----------
//
// どの種類も同じ形で出す：題・締め切り（任意）・成功で牢屋から出す人数。種類ごとに違うのは「何をもって成功か」だけ。
// - photo（集合写真）：写真を送り、主催者が見て成功を押す
// - meet（合流）：指定された逃走者どうしが、2人で同時に長押しする。重なった瞬間に成功
// - zone（範囲）：主催者が地図に描いた範囲に、締め切りの瞬間、決めた人数以上の逃走者（牢屋の外）がいれば成功
// 合流の組・範囲は、鬼の画面にも出る（鬼は待ち伏せできる）

export type MissionKind = 'photo' | 'meet' | 'zone';
export const MISSION_KINDS: readonly MissionKind[] = ['photo', 'meet', 'zone'];
export const MISSION_KIND_NAME: Record<MissionKind, string> = { photo: '集合写真', meet: '合流', zone: '範囲' };
/** 主催者が題を空のまま出したときの題（種類ごと） */
export const MISSION_DEFAULT_TITLES: Record<MissionKind, string> = {
  photo: MISSION_DEFAULT_TITLE,
  meet: '指定された仲間と合流しろ',
  zone: '指定の範囲に集まれ',
};

export function isMissionKind(v: unknown): v is MissionKind {
  return v === 'photo' || v === 'meet' || v === 'zone';
}

/** 合流の組の作り方：all＝捕まっていない逃走者を全員2人組に、one＝無作為の1組だけ */
export type MeetScope = 'all' | 'one';

/** 締め切りまでの長さ（秒）の下限・上限 */
export const MISSION_SECS_MIN = 30;
export const MISSION_SECS_MAX = 900;
/** 範囲のミッションで、集まる人数の上限 */
export const ZONE_NEED_MAX = 999;
/** 範囲の線からこれだけ外でも「中」に数える（m）。位置のぶれで、線の上に立つ人を落とさないため */
export const ZONE_EDGE_M = 5;
/** 合流の組がこれ以下なら、誰と誰の組かを全員（鬼にも）に名前で見せる。多いときは組の数だけ */
export const MEET_PUBLIC_PAIRS_MAX = 6;

/** 締め切りまでの秒を整える。空（null・undefined）は「締め切りなし」。おかしな値は false */
export function cleanMissionSecs(raw: unknown): number | null | false {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MISSION_SECS_MIN || n > MISSION_SECS_MAX) return false;
  return n;
}

/**
 * 合流の組を作る。pids は捕まっていない逃走者。rand は 0 以上 1 未満の乱数。
 * one＝無作為の2人で1組。all＝全員を2人組に（人数が奇数なら、最後の組だけ3人。3人の組は、そのうち2人が合えば成功）。
 * 2人に足りなければ空
 */
export function makeMeetGroups(pids: readonly string[], scope: MeetScope, rand: () => number): string[][] {
  const list = [...pids];
  if (list.length < 2) return [];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  if (scope === 'one') return [list.slice(0, 2)];
  const out: string[][] = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
  if (list.length % 2 === 1) out[out.length - 1].push(list[list.length - 1]);
  return out;
}

/** 範囲の中に数えるか（中、または線から ZONE_EDGE_M 以内） */
export function inZone(pts: [number, number][], p: LatLon): boolean {
  const c = checkArea(pts, p);
  return c.inside || c.edgeM <= ZONE_EDGE_M;
}

/** 範囲の中にいる人数 */
export function countInZone(pts: [number, number][], people: readonly LatLon[]): number {
  let n = 0;
  for (const p of people) if (inZone(pts, p)) n++;
  return n;
}

/**
 * 合流・範囲のミッションから見た、試合のいま。
 * live＝続けてよい（配役のあと〜ゲームの段階が終わるまで）、paused＝止めている（締め切りも止まる）、
 * over＝ゲームの段階が終わった（範囲はここで判定する）、off＝試合の外（配役前・やり直し・結果発表・夜の最後）
 */
export function missionClock(game: Pick<GameView, 'stage' | 'timer'>, now: number, gamePhase: number): 'live' | 'paused' | 'over' | 'off' {
  if (game.stage === 'assigned') return 'live';
  if (game.stage !== 'timer' || !game.timer) return 'off';
  if (game.timer.status === 'paused') return 'paused';
  const pos = positionAt(game.timer, now);
  if (pos.kind === 'done' || pos.index > gamePhase) return 'over';
  return 'live';
}
