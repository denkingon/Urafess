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

/** 鬼：逃走者の比率の重み。主催者が配役の前に変えられる（初期値は ROLES の重み） */
export type Ratio = Record<RoleId, number>;
export const DEFAULT_RATIO: Ratio = { oni: 3, runner: 7 };
export const RATIO_MIN = 1;
export const RATIO_MAX = 99;
export function isValidRatio(r: unknown): r is Ratio {
  if (typeof r !== 'object' || r === null) return false;
  const { oni, runner } = r as Record<string, unknown>;
  return [oni, runner].every((x) => Number.isInteger(x) && (x as number) >= RATIO_MIN && (x as number) <= RATIO_MAX);
}

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
 * 試合中（配役〜タイマー）は、サーバーがこの間隔で短い合図（hb）を全員に送る。
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

// ---------- 捕獲の記録 ----------
//
// 体で捕まえたあと、鬼は「捕まえた」、逃走者は「捕まった」を長押しする。
// 逃走者のスマホは長押しの間、自分のその回の3桁を音で鳴らし、鬼のスマホは長押しの間マイクで聞く。
// 鬼のスマホが音を拾うと「◯◯をロックオン」と出て、鬼は離して次を追える。
// サーバーは「音を拾った鬼」「同じ時間に長押ししていた鬼」「前後に長押しした鬼」「手動で選んだ鬼」を
// 逃走者の画面に同じ大きさで並べ、逃走者本人がどれか1人を選んだら記録する。

/** 長押しとみなすまでの時間。これより短く離したら何もしない（押し間違い・ポケットの中） */
export const HOLD_MIN_MS = 500;

/**
 * 0.5秒押したら離していい。押し始めからこの長さまでは、離しても音を出し続ける（鬼は聞き続ける）。
 * 3桁の音（超音波・速い）は1回およそ1.2秒なので、2回は鳴る。長押しを続ければ離すまで続く
 */
export const HOLD_LATCH_MS = 3_000;

/** 逃走者の長押しが終わったあと、鬼のスマホが拾った知らせを「その長押しの間の音」として待つ長さ（回線の遅れの分） */
export const HEARD_SLACK_MS = 2_000;

/**
 * 鬼のマイクの聞き方。主催者が切り替える（どちらがいいか、本番で比べるため。記録にも残す）
 * - always：マイクをオンにしたら、ゲームの段階の間ずっと聞く（鬼は押さなくていい）
 * - hold：「捕まえた」を押している間だけ聞く（前の版と同じ）
 */
export type MicMode = 'always' | 'hold';
export const DEFAULT_MIC_MODE: MicMode = 'always';
export const isMicMode = (m: unknown): m is MicMode => m === 'always' || m === 'hold';

/** 長押しの長さの上限。押しっぱなしのまま「離した」が届かない長押しも、ここで離したとみなす */
export const HOLD_MAX_MS = 30_000;

/** 離した瞬間が分からない長押し（切断・「離した」が届かなかった）は、押し始めからこの長さで離したとみなす */
export const HOLD_UNKNOWN_END_MS = 8_000;

/** 重なっていなくても、前後この時間に長押しした鬼は候補に出す */
export const CLAIM_PAIR_WINDOW_MS = 20_000;

/** 逃走者の「捕まった」は、この時間選ばないままなら閉じる。ゲームが終わったあとも、この間は選べる（終了間際の捕獲のため） */
export const CLAIM_OPEN_MS = 90_000;

/** ゲームの段階が終わった直後も、この時間は長押しを受け付ける（終了間際に体で捕まえた分） */
export const CLAIM_GRACE_MS = 10_000;

/** 鬼のスマホが逃走者の音を拾った記録・鬼が手動で選んだ記録を、候補として使う時間 */
export const EVIDENCE_VALID_MS = 60_000;

/**
 * 番号を運ぶ音の送り方。ultrasound は 15kHz より上でほとんど聞こえず、話し声と重ならないので強い。
 * audible は 1.9〜6.4kHz でピロピロ聞こえるが、話し声と重なって読み落としやすい（test/sound.test.ts の表）。
 * 聞こえる音は、別に重ねる3音のフレーズ（SOUND_MELODY）で出す
 */
export type SoundProtocol =
  | 'ultrasound-fastest'
  | 'ultrasound-fast'
  | 'ultrasound-normal'
  | 'audible-fastest'
  | 'audible-fast'
  | 'audible-normal';

export const SOUND_PROTOCOL: SoundProtocol = 'ultrasound-fast';

/** 長押しの間、番号の超音波に「その人だけの3音のフレーズ」（聞こえる音）を重ねる。0 で重ねない */
export const SOUND_MELODY_GAIN = 0.3;

/** 音の大きさ（ggwave の 1〜100） */
export const SOUND_VOLUME = 50;

/** 鳴らす合間（長押しの間、3桁を繰り返す） */
export const SOUND_GAP_MS = 250;
