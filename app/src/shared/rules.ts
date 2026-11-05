// ゲームの決まりごと。数字を変えたいときはここだけ直す。

export type RoleId = 'oni' | 'runner';

export interface RoleRule {
  id: RoleId;
  /** 画面に出す名前 */
  name: string;
  /** 比率の重み（鬼3：逃走者7） */
  weight: number;
  /** 2人以上いるときの最低人数 */
  min: number;
  /** ちょうど半分で並んだとき、小さい方が端数をもらう（逃走者が先＝鬼が少なくなる） */
  tiePriority: number;
}

export const ROLES: readonly RoleRule[] = [
  { id: 'oni', name: '鬼', weight: 3, min: 1, tiePriority: 1 },
  { id: 'runner', name: '逃走者', weight: 7, min: 1, tiePriority: 0 },
];

export const ROLE_NAME: Record<RoleId, string> = { oni: '鬼', runner: '逃走者' };

/** 1ラウンドの時間で区切られた段階（配役と結果発表は主催者が進める） */
export const PHASES = [
  { id: 'escape', label: '逃走開始まで' },
  { id: 'chase', label: '追跡開始まで' },
  { id: 'game', label: '残り時間' },
  { id: 'return', label: '広場に戻るまで' },
] as const;

export type PhaseId = (typeof PHASES)[number]['id'];

/** 逃走開始まで20秒 → 追跡開始まで1分 → ゲーム5分 → 広場に戻る2分 */
export const DEFAULT_DURATIONS_MS: readonly number[] = [20_000, 60_000, 300_000, 120_000];

/** 開始・再開は押した2秒後を予約する（その間に全員へ届く） */
export const START_LEAD_MS = 2_000;

/** 往復の半分がこれ以下なら「時計が合っている」と数える */
export const SYNC_OK_MS = 100;

/**
 * 試合中（配役〜タイマーが0になるまで。matchLive）は、サーバーがこの間隔で短い合図（hb）を全員に送る。
 * 送る側（サーバー→スマホ）は無料で、携帯の電波が待機に落ちる（5〜10秒）より短いので、
 * 「捕まった」などの知らせが電波の寝起き（約1〜2秒）を待たずに届く
 */
export const HEARTBEAT_EVERY_MS = 2_000;

/** 試合中に合図がこれだけ届かなければ、見えない切断とみなしてつなぎ直す（回線の詰まり1.5〜3秒では切らない長さ） */
export const SILENCE_LIMIT_MS = 6_000;

/** 段階ごとの長さの上下限（主催者が変えるとき） */
export const DURATION_MIN_MS = 1_000;
export const DURATION_MAX_MS = 60 * 60_000;

export const NAME_MAX_LENGTH = 20;
