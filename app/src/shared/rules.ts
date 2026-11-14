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

export const isRoleId = (r: unknown): r is RoleId => r === 'oni' || r === 'runner';

// ---------- 配役の希望 ----------
//
// 配役の前（待合室・結果発表）に、参加者が「逃走者がいい」「鬼がいい」を選べる。選ばなければ「どちらでも」。
// 人数は主催者の割合のまま変えない。希望が枠より多い役は、その中からくじで枠の人数だけ通し、外れた人はもう一方の役になる。
// 外れた人は、次の配役で先に通る（続けて外れた回数が多い人ほど先。通ったら 0 に戻る）。
// 希望は今夜のあいだ残る（毎回選び直さなくていい）。新しい夜を始めると消える。

/**
 * 配役の決め方。主催者が切り替える（次の配役から効く）
 * - wish：希望を聞く（割合は守る。枠より多い希望はくじ）
 * - lot：くじだけ（希望を聞かない。前の版と同じ）
 */
export type WishMode = 'wish' | 'lot';
export const DEFAULT_WISH_MODE: WishMode = 'wish';
export const isWishMode = (m: unknown): m is WishMode => m === 'wish' || m === 'lot';

/** 続けて外れた回数は、ここまで数える（これより上は同じ強さ） */
export const WISH_MISS_MAX = 99;

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

// ---------- 走ると光る ----------
//
// 走っている人は、全員の画面に名前と場所が光る。止まると消える（走りは見せつける行為。走る奴は囮であり勇者）。
// 走っているかは、スマホが自分で決める：動きのセンサーの揺れ（1歩ごとの強い揺れと、そのテンポ）。
// 動きのセンサーが使えないスマホは、スマホが出す速さで決める（位置の差からは出さない。止まっていても位置は飛ぶので）。
// 光るのはゲームの段階（追跡が始まってから終わるまで）だけ。逃げて散る間に光ると、隠れた場所が全部ばれるため。
// 光るための位置は光っている間だけ1秒ごとに送る。それとは別に「全体の地図」のため、ゲームの段階の間だけ全員が5秒ごとに位置を送る（下の MATES_*）。

/** 光っている間、位置を送り直す間隔 */
export const RUN_SEND_EVERY_MS = 1_000;

/** 走りとみなしてから、これだけ続いたら光る（跳ねた・つまずいた一瞬では光らない） */
export const RUN_START_MS = 600;

/** 走りでなくなってから、これだけたったら消える（角を曲がる・段差の一瞬の止まりでは消えない） */
export const RUN_STOP_MS = 2_000;

/** 光っている人の位置がこれだけ届かなければ消す（電波が切れた・画面を消した） */
export const RUN_STALE_MS = 5_000;

/** 揺れを見る長さ。この間の「1歩」の数とテンポで決める */
export const RUN_WINDOW_MS = 2_500;

/** この間に、これだけの「1歩」が要る */
export const RUN_STEPS_MIN = 4;

/** 1歩のテンポ（1秒あたりの歩数）。歩きは 1.6〜2.0、走りは 2.4〜3.2 */
export const RUN_CADENCE_MIN = 2.2;

/**
 * 1歩とみなす揺れの強さ（m/s²、重力込みの大きさ。止まっていると約 9.8）。
 * 歩きは 11〜14、走りは 18〜30（ポケットでも手でも）。揺れがこれを超えて RUN_PEAK_RELEASE を下回るまでを1歩と数える
 */
export const RUN_PEAK_MIN = 16;
export const RUN_PEAK_RELEASE = 11;

/** 動きのセンサーが使えないスマホは、スマホが出す速さで決める（m/s。2.8＝時速10km）。続けて2回この速さで走り */
export const RUN_SPEED_MIN = 2.8;

/** 位置の速さを使うのは、位置の誤差がこれ以下のときだけ（m） */
export const RUN_ACCURACY_MAX = 25;

// ---------- 全体の地図（仲間の居場所） ----------
// ゲームの段階（追跡が始まってから終わるまで）の間だけ、全員のスマホが MATES_SEND_EVERY_MS ごとに位置を送る。
// 見えるのは役ごと：鬼には鬼どうし、逃走者には（捕まっていない）逃走者どうし、主催者には全員。見学の人には誰も見えない。
// 相手の役の位置は配らない（隠れる意味を残すため）。相手の役が見えるのは、走って光ったときだけ。
// 捕まった逃走者は送らない（地図から消える）。位置は記録（CSV）に残さない（1晩で数万行になり、保存の無料枠を食うため）。
// リクエスト：50人・5秒ごとで1分に600。ゲームの段階が1晩で計30分なら約1.8万（無料枠1日10万の中）

/** 位置を送る間隔 */
export const MATES_SEND_EVERY_MS = 5_000;

/**
 * 送る位置の古さの上限。止まっているスマホは位置を出し直さないことがある（隠れてじっとしている人）。
 * 止まっているなら古い位置のままで合っているので、少し古くても送る
 */
export const MATES_FIX_MAX_AGE_MS = 5 * 60_000;

/** 送る位置は、誤差がこれ以下のものだけ（m）。建物の中で 100m 飛んだ位置は仲間を迷わせる */
export const MATES_ACC_MAX = 80;

/** 仲間の位置がこれだけ届かなければ地図から消す（3回続けて届かなかった） */
export const MATES_STALE_MS = 16_000;

/** サーバーが全員へ配る間隔（何人送ってきても、最大でこの間隔に1回まとめて） */
export const MATES_BROADCAST_MS = 1_000;

/**
 * 全体の地図の最初の枠（SFC のキャンパス：北西の角・南東の角）。人がこの外にいれば、そこまで広げる。
 * キャンパスから MATES_FAR_M より遠い位置（家で開いた人など）は枠を広げるのに使わない
 */
export const CAMPUS_BOX = { north: 35.3919, west: 139.4246, south: 35.3835, east: 139.4323 } as const;
export const MATES_FAR_M = 2_000;

// ---------- 牢屋と解放 ----------
//
// 捕まった逃走者は、決めた牢屋へ歩いて行って待つ。出る道は2つ。
//   1. 仲間が牢屋に来て触れる：助ける人が「助ける」を長押しすると、そのスマホが最大音量の超音波で「助ける番号」を鳴らす。
//      牢屋の人のスマホは、牢屋に入ったときからずっと聞いていて、拾った瞬間に解放に切り替わる（選ぶ画面は出さない）。
//      音が届かないときの予備：牢屋の人が「助けて」、助ける人が「助ける」を同時に長押しすると、重なった瞬間に解放。
//      1回の長押しで出せるのは1人（そばに牢屋の人が何人いても、最初に拾った1人）。
//   2. 仲間がミッションをクリアする：主催者が「ミッション成功」を押す。全員・1人・人数を決めて、の3つの版がある（牢屋に入ったのが古い順）。
// 解放された人は、RESCUE_IMMUNE_MS の間は捕まらない。また捕まることもある（何回でも）。
// 逃走者が全員同時に牢屋に入ったら、2秒後（START_LEAD_MS）に全員の画面でゲームの段階が終わり、鬼の勝ち。
// 時間切れのとき1人でも牢屋の外にいたら、逃走者の勝ち。結果はアプリが出す（主催者は直すときだけ押す）。

/** 解放された直後、捕まらない時間 */
export const RESCUE_IMMUNE_MS = 10_000;

/** 助ける人のスマホが鳴らす音の大きさ（ggwave の 1〜100。最大） */
export const RESCUE_VOLUME = 100;

/** 助ける人は、1人出したらこの間は次の人を出せない（1回の長押しで1人） */
export const RESCUE_GAP_MS = 3_000;

/** 「助けて」「助ける」の長押しが重なったかを見るために、離した長押しを覚えておく時間 */
export const RESCUE_HOLD_KEEP_MS = 10_000;

/** キャンパスの真ん中（範囲の頂点の打ち間違いを見分ける基準） */
export const CAMPUS_CENTER = { lat: (CAMPUS_BOX.north + CAMPUS_BOX.south) / 2, lon: (CAMPUS_BOX.west + CAMPUS_BOX.east) / 2 } as const;
