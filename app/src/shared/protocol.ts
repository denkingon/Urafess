import type { Area } from './area';
import type { ShrinkLive, ShrinkPlan } from './shrink';
import type { Candidate, CaptureVia } from './capture';
import type { ChatCh, ChatJail, ChatMode, ChatMsg } from './chat';
import type { CastStat } from './cast';
import type { LeadRules } from './lead';
import type { MeetScope, MissionKind, PhotoStatus } from './mission';

/** 牢屋からどうやって出たか。sound＝助ける人の音を拾った、together＝同時に長押し、mission＝ミッション成功、host＝主催者が手で */
export type RescueVia = 'sound' | 'together' | 'mission' | 'host';
import type { AnnounceSettings, AnnounceSound, RevealMode, RoleId, WishMode } from './rules';
import type { Timer } from './schedule';
import type { NightPlan } from './night';
import type { Preset } from './preset';

/**
 * 全員に配る「確保」の知らせ（最後の1件）。主催者の設定（AnnounceSettings）で出してよいものだけを入れる。
 * 名前を出さない設定のときは、サーバーが名前を入れない（誰が鬼か・誰が捕まったかは配らない）
 */
export interface CaptureNews {
  /** 増え続ける番号（配役をまたいでも戻らない）。画面はこれが変わったら帯を出す */
  seq: number;
  /** capture＝確保、release＝主催者が確保を取り消した、test＝主催者が試しに出した */
  kind: 'capture' | 'release' | 'test';
  /** 帯を出して鳴らす瞬間（サーバー時刻）。全員がこの瞬間に出す */
  showAt: number;
  /** 捕まった逃走者（「捕まった人」「捕まえた鬼も」のときだけ） */
  runner: { num: number; name: string } | null;
  /** 捕まえた鬼（「捕まえた鬼も」のときで、鬼が分かっているときだけ。主催者が鬼を空欄で記録したら null） */
  oni: { num: number; name: string } | null;
  /** この知らせのあとの逃走者の残り（牢屋の外）と、配役の逃走者の数 */
  left: number;
  total: number;
  /** 誰のスマホを鳴らすか（知らせを作ったときの設定） */
  sound: AnnounceSound;
}

/** ゲーム全体の段階（サーバーが持つ正解） */
export type Stage =
  /** 配役前（入室を受け付けている） */
  | 'lobby'
  /** 役が決まった（開始前） */
  | 'assigned'
  /** タイマーが動いている／止まっている（終わったら各スマホが結果発表を出す） */
  | 'timer'
  /** 主催者が勝ちを押した */
  | 'result'
  /** 夜の最後。主催者が「夜を終える」を押した。全員の画面が SEE YOU AGAIN になる（配役で再開もできる） */
  | 'ended';

export type Winner = 'oni' | 'runner';

/** 全員に同じものを送る部分。他人の役は入れない */
export interface GameView {
  gameId: string;
  round: number;
  /** 配役するたびに増える（引き直しも含む） */
  assignId: number;
  stage: Stage;
  /** 主催者の操作の版番号。古い画面からの操作を断るために使う */
  cv: number;
  timer: Timer | null;
  /** caught＝今の配役で捕まった逃走者の数（誰かは送らない） */
  counts: { oni: number; runner: number; total: number; caught: number };
  result: Winner | null;
  durations: number[];
  /** 今の夜を始めた時刻（「新しい夜を始める」を押した時刻）。古いサーバーは送らない */
  nightAt?: number;
  /** 配役の比率（鬼：逃走者）。古いサーバーからは来ない */
  ratio?: { oni: number; runner: number };
  /**
   * ミッション：いちばん新しいミッション（配役・新しい夜を始めるで消える）。open＝写真を受け付けている。
   * 古いサーバーからは来ない
   */
  mission?: MissionView | null;
  /** ミッション：このラウンド（配役のあと）に成功した写真。成功したかどうかは全員に見せる。写真そのものは結果発表で */
  missionOk?: MissionOk[];
  /** 逃走者が全員同時に牢屋に入った時刻（その配役は鬼の勝ちで決まり）。まだなら null。古いサーバーは送らない */
  allCaughtAt?: number | null;
  /** result をアプリが決めた（true）か、主催者が押した（false）か */
  resultAuto?: boolean;
  /** 鬼のマイクの聞き方（always＝ずっと聞く／hold＝押している間だけ）。古いサーバーからは来ない（そのときは always） */
  micMode?: 'always' | 'hold';
  /** 遊ぶ範囲（主催者がゲームの前に地図に描いた多角形）。null＝範囲なし。古いサーバーからは来ない */
  area?: Area | null;
  /** 捕まったときの全員への知らせの設定（主催者が切り替える）。古いサーバーからは来ない */
  announce?: AnnounceSettings;
  /** 最後の「確保」の知らせ。配役・リセット・新しい夜で消える。古いサーバーからは来ない */
  news?: CaptureNews | null;
  /** 範囲の縮み方（主催者が試合の前に決める）。古いサーバーからは来ない */
  shrinkPlan?: ShrinkPlan;
  /** このラウンドの縮小（試合を始めると決まる。縮む先と段）。範囲が無い・始める前は null。古いサーバーからは来ない */
  shrink?: ShrinkLive | null;
  /** 牢屋の場所（遊ぶ範囲と同じく、主催者がゲームの前に地図に描いた多角形）。null＝決めていない。古いサーバーからは来ない */
  jail?: Area | null;
  /** 配役の決め方（wish＝希望を聞く／lot＝くじだけ）。古いサーバーからは来ない（そのときは希望の板を出さない） */
  wishMode?: WishMode;
  /**
   * 配役の希望：いま入室している人のうち、それぞれの役を希望している人数（誰かは送らない）。
   * 主催者が指名した人は数えない（その人の役は希望と関係なく決まるため）。古いサーバーからは来ない
   */
  wishes?: { oni: number; runner: number };
  /** チャット：仲間の回線で送れるもの・牢屋の人の決まり・場所の名前。古いサーバーからは来ない（そのときはチャットを出さない） */
  chat?: { mode: ChatMode; jail: ChatJail; places: string[] };
  /**
   * 配役の希望：いまの人数と割合での、それぞれの役の「開いている枠」（主催者の指名の分を引いたあと）。
   * 古いサーバーからは来ない（そのときは、人数と割合からスマホが出す）
   */
  wishSlots?: { oni: number; runner: number };
  /** 配役の出し方の設定（sync＝全員同時にドン／tap＝タップした人から／now＝すぐ出す）。次の配役から効く。古いサーバーからは来ない */
  revealMode?: RevealMode;
  /**
   * いまの配役の出し方（配役を押したときの設定）。hitAt は sync のとき全員の画面で役が出るサーバー時刻（ほかは null）。
   * 配役前は null。古いサーバーからは来ない（そのときはすぐ出す）
   */
  reveal?: { mode: RevealMode; hitAt: number | null } | null;
  /** 司令塔の札（本部のデッキで入れたり外したりする）。誰が司令塔かは入れない。古いサーバーからは来ない（そのときは外してある） */
  lead?: LeadRules;
}

/**
 * 司令塔：本人に送る、自分の側のいま。しくみを入れていて、今の配役で役がある人にだけ付く。
 * mine＝自分が司令塔、name＝自分の側の司令塔の名前（いなければ null）、map＝全体の地図を見られる、
 * down＝逃走者の司令塔が落ちている（どちらの側にも同じ値）、foes＝相手の全員の居場所が見えている（鬼だけ）
 */
export interface MeLead {
  mine: boolean;
  name: string | null;
  map: boolean;
  down: boolean;
  foes: boolean;
}

/** 司令塔：主催者に送る、いまの司令塔（pid が null＝その側にいない） */
export interface HostLead {
  oni: { pid: string; name: string } | null;
  runner: { pid: string; name: string } | null;
  /** 逃走者の司令塔が落ちている */
  down: boolean;
}

export interface MissionView {
  id: number;
  title: string;
  /** 出したサーバー時刻 */
  at: number;
  open: boolean;
  /** 種類（photo＝集合写真、meet＝合流、zone＝範囲）。古いサーバーからは来ない（そのときは集合写真） */
  kind?: MissionKind;
  /** 締め切り（サーバー時刻）。無ければ締め切りなし。範囲は必ずある。試合を止めている間は進まない（再開でずれる） */
  until?: number | null;
  /** 成功で牢屋から出す人数（null＝全員、0＝出さない）。合流・範囲だけ（集合写真は主催者が成功を押すときに選ぶ） */
  free?: number | null;
  /**
   * 合流：組の数と、成功した組の数。組が MEET_PUBLIC_PAIRS_MAX 以下なら、誰と誰か（pairs）も全員に見せる（鬼にも）。
   * 自分の相手は MeView.meet で届く
   */
  meet?: { scope: MeetScope; groups: number; ok: number; pairs?: MeetPairView[] };
  /** 範囲：頂点（[緯度, 経度]）・集まる人数・いま中にいる逃走者の数（締め切ったあとは null） */
  zone?: { pts: [number, number][]; need: number; now: number | null };
  /**
   * 合流・範囲の結果（まだなら null）。ok＝成功、count＝成功した組の数／締め切りの瞬間に中にいた人数、
   * freed＝この成功で牢屋から出た人数。範囲を判定しないまま締め切ったときは null のまま
   */
  done?: { ok: boolean; at: number; freed: number; count: number } | null;
}

/** 合流の1組（2人。人数が奇数のときの最後の組だけ3人） */
export interface MeetPairView {
  names: string[];
  /** 合流した時刻（まだなら null） */
  okAt: number | null;
}

export interface MissionOk {
  /** 写真の印（/api/game/<ID>/photo/<印> で取り出す） */
  id: string;
  missionId: number;
  /** 送った人の名前 */
  name: string;
  /** 送ったサーバー時刻 */
  at: number;
  /** この写真の成功で牢屋から出た人数（出していなければ 0）。古いサーバーからは来ない */
  freed?: number;
}

/** 主催者が見る写真1枚 */
export interface HostPhoto {
  id: string;
  missionId: number;
  name: string;
  at: number;
  status: PhotoStatus;
  bytes: number;
  /** この写真の成功で牢屋から出た人数 */
  freed?: number;
}

/** 本人だけに送る部分 */
export interface MeView {
  pid: string;
  /** 名簿に入った順。画面には出さない（記録と並び順だけに使う） */
  num: number;
  name: string;
  /** 今の配役での役。途中で来た人・外された人は null */
  role: RoleId | null;
  assignId: number;
  removed: boolean;
  /** 今の配役での自分の3桁。逃走者が「捕まった」を長押ししている間、スマホがこれを音で鳴らす */
  code: string | null;
  /** いま牢屋にいる（逃走者だけ）。解放されると null に戻る。また捕まれば入り直す */
  caught: { byNum: number | null; byName: string | null; at: number; via: CaptureVia } | null;
  /** 今の配役での「助ける番号」。牢屋の人を助けるとき、スマホがこれを最大音量で鳴らす（捕まったときの code とは別） */
  rcode?: string | null;
  /** 解放されたあと、この時刻（サーバー時刻）までは捕まらない。無ければ null */
  freeUntil?: number | null;
  /** 今の配役で牢屋から出した人数（逃走者だけ） */
  rescues?: number;
  /** 今の配役で捕まえた人数（鬼だけ） */
  catches: number;
  /** 救護の呼び出し：自分のいちばん新しい呼び出し（今夜のうち）。無ければ null。古いサーバーからは来ない */
  sos?: MeSos | null;
  /** 逃走者の「捕まった」（選ぶまで開いている）。at は最初に長押しを始めたサーバー時刻。cands は並べる候補 */
  claim: { at: number; cands: Candidate[] } | null;
  /** ミッション：このラウンドに自分が送った写真（古い順）。古いサーバーからは来ない */
  sent?: { id: string; missionId: number; status: PhotoStatus; at: number }[];
  /**
   * 最後の知らせ（game.news）が自分のこと（捕まった本人・捕まえた鬼）なら、その seq。
   * 本人には自分の知らせ（「捕まった」「捕まえた」）が出るので、全員向けの帯は重ねない。古いサーバーからは来ない
   */
  newsAbout?: number | null;
  /**
   * ミッション（合流）：自分の組。with＝合流する相手（jailed＝いま牢屋にいる）、okAt＝合流した時刻。
   * 組に入っていない（鬼・出したときに牢屋にいた・あとから来た）なら null。古いサーバーからは来ない
   */
  meet?: { missionId: number; with: { name: string; jailed: boolean }[]; okAt: number | null } | null;
  /** 配役の希望：自分がなりたい役（null＝どちらでも）。古いサーバーからは来ない */
  wish?: RoleId | null;
  /** 配役の希望：続けて希望が通らなかった回数（1以上なら、次の配役で先に通る） */
  wishMiss?: number;
  /** 配役の希望：いまの配役で、希望を出したのに通らなかった（希望が枠より多かった・主催者が決めた） */
  wishMissed?: boolean;
  /**
   * 主催者がこの人の役を決めている（配役の前の指名、または配役のあとに主催者が動かした）。開始で消える。
   * 本人の画面の文を合わせるために送る（配役の前は、板のひとことを「配役を待つ」にする。配役のあとは「主催者が決めた」）
   */
  hostCast?: boolean;
  /** 司令塔：自分の側のいま（しくみを外してある・役が無いときは付かない） */
  lead?: MeLead | null;
}

/** 主催者が見る、今の配役の捕獲 */
export interface HostCapture {
  runners: {
    pid: string;
    num: number;
    name: string;
    caught: boolean;
    byNum: number | null;
    byName: string | null;
    via: CaptureVia | null;
    at: number | null;
    /** 「捕まった」を押して答え待ち */
    open: boolean;
    /** 牢屋から出た直後で、この時刻まで捕まらない（古いサーバーは送らない） */
    freeUntil?: number | null;
    /** この配役で牢屋から出した人数 */
    rescues?: number;
  }[];
  oni: { pid: string; num: number; name: string; catches: number }[];
}

/** 主催者だけに送る集計 */
/** 救護の呼び出しの状態。open＝本部がまだ見ていない、ack＝本部が見た（向かう）、done＝終わった、cancel＝本人が取り消した */
export type SosStatus = 'open' | 'ack' | 'done' | 'cancel';

/** 救護：押した本人に返す、自分の呼び出し */
export interface MeSos {
  cid: string;
  id: number;
  status: SosStatus;
  at: number;
  ackAt: number | null;
}

/** 救護：主催者に送る、まだ終わっていない呼び出し（古い順） */
export interface HostSos {
  id: number;
  name: string;
  status: 'open' | 'ack';
  at: number;
  ackAt: number | null;
  /** いまの配役での役と、牢屋にいるか（探すときの手がかり） */
  role: RoleId | null;
  caught: boolean;
  /** 押した人の位置（取れていれば）。at＝その位置を受け取った時刻 */
  pos: { lat: number; lon: number; acc: number; at: number } | null;
  /** 押した人のスマホがいまつながっているか */
  online: boolean;
}

export interface HostSummary {
  /** 救護の呼び出し（まだ終わっていないもの）。古いサーバーからは来ない */
  sos?: HostSos[];
  /** 入室していて外されていない人 */
  total: number;
  /** 今つながっている人 */
  connected: number;
  /** 今の配役に入っている人 */
  assigned: number;
  /** 今の配役の役を受け取った人 */
  received: number;
  /** 時計の誤差が小さい（往復の半分が SYNC_OK_MS 以下）と報告してきた、つながっている人 */
  synced: number;
  /** 今の配役の後に来た人（次の配役から入る） */
  waiting: number;
  /** 同じ名前の人（名簿で名前を1人1つにする前に入った人だけ。ふつうは空） */
  dupNames: { name: string; people: { pid: string; num: number; joinedAt: number }[] }[];
  /** 配役前は null */
  capture: HostCapture | null;
  /**
   * 「前の◯◯に戻りたい」と待っている人（合い鍵のないスマホで、名簿にある名前を入れて「そう」を押した）。
   * rid＝その頼みの印、name＝戻りたい先の名前、here＝その人がいま別のスマホでつながっている
   */
  reclaims: { rid: string; name: string; at: number; here: boolean }[];
  /** 名簿の人数（今夜いない人も含む） */
  registry: number;
  /**
   * 走ると光る：今の配役に入っていてつながっている人（total）のうち、動きのセンサーが使える人・位置が使える人・いま光っている人。
   * 古いサーバーは送らない
   */
  glow?: { total: number; motion: number; geo: number; lit: number };
  /**
   * スマホの許可：いまつながっている今夜の人（total）のうち、全部入った人（ok）・まだ知らせが無い人（unknown＝古い版の画面か、開いた直後）と、
   * 入っていない人の名前と入っていないもの（名前順、多ければ PERM_LIST_MAX 人まで）。古いサーバーは送らない
   */
  perms?: { total: number; ok: number; unknown: number; missing: { name: string; need: PermItem[] }[] };
  /** ミッション：このラウンドに届いた写真（古い順）と、写真の保存の使った量（バイト）。古いサーバーは送らない */
  photos?: HostPhoto[];
  photoBytes?: number;
  /** ミッション（合流）：全部の組（主催者には組が多くても名前で届く）。jailed＝いま牢屋にいる人の名前 */
  meets?: { names: string[]; okAt: number | null; jailed: string[] }[];
  /** ミッション（範囲）：いま範囲の中にいる逃走者の名前 */
  zoneIn?: string[];
  /**
   * 配役の希望：いまの配役を決めたときの数（希望した人数と、通らなかった人数）。くじだけで決めた配役・配役前は null。
   * 古いサーバーは送らない
   */
  wishStat?: { oni: number; runner: number; none: number; missed: number } | null;
  /** 夜の予定（本部で組む。まだ組んでいなければ null）。古いサーバーは送らない */
  nightPlan?: NightPlan | null;
  /** ルールのプリセット。古いサーバーは送らない */
  presets?: Preset[];
  /** 配役の希望：次の配役で先に通る人（前に外れた人）の数 */
  wishPrio?: number;
  /** 配役の出し方：今の配役で、役が画面に出た人（tap なら、カードを止めた人）。古いサーバーは送らない */
  seen?: number;
  /**
   * 配役をいじる：今夜の参加者の1人ずつ（名簿に入った順）。主催者が指名する・配役のあとに動かすための一覧。
   * 古いサーバーは送らない
   */
  cast?: HostCastEntry[];
  /**
   * 名前の見張り：今夜の人と、使えない言葉に引っかかる・主催者が手を入れた名簿の人。
   * hit＝引っかかった言葉、state＝名前の状態、tonight＝今夜に入っている。古いサーバーは送らない
   */
  names?: { pid: string; num: number; name: string; hit: string | null; state: 'ok' | 'due' | 'shamed'; tonight: boolean }[];
  /** 名前に使えない言葉：主催者が足した言葉と、最初から入っている言葉の数 */
  bans?: { custom: string[]; builtin: number };
  /** 司令塔：いまの司令塔（しくみを外してある・配役前は null）。古いサーバーは送らない */
  lead?: HostLead | null;
}

/** 主催者が配役をいじるための1人 */
export interface HostCastEntry {
  pid: string;
  num: number;
  name: string;
  /** 本人の希望（null＝どちらでも） */
  wish: RoleId | null;
  /** 主催者の指名（null＝指名していない。開始で消える） */
  pin: RoleId | null;
  /** いまの配役での役（配役前・途中で来た人は null） */
  role: RoleId | null;
  /** 前に希望が外れていて、次の配役で優先される */
  prio: boolean;
  /** いまつながっている */
  on: boolean;
  /** 主催者が付けた印（男・女・速い…）。名簿に残る */
  tags?: string[];
  /** 今までの記録から出した数字（記録が無い人には付かない） */
  stat?: CastStat;
}

/**
 * 走ると光る：いま光っている1人。役は入れない（走っているのが鬼か逃走者かは、動きを見て決めること）。
 * 位置は取れていなければ null。緯度・経度は小数5桁（約1m）、acc は位置の誤差の半径（m）
 */
export interface GlowEntry {
  num: number;
  name: string;
  lat: number | null;
  lon: number | null;
  acc: number | null;
  /** 光り始めたサーバー時刻 */
  since: number;
  /** 最後に届いたサーバー時刻 */
  at: number;
  /**
   * 司令塔（どちらの側か）。司令塔は走っていなくても、ゲームの段階の間ずっとここに入る（見る代わりに見られる）。
   * 走っていない司令塔の位置は MATES_SEND_EVERY_MS ごとにしか届かないので、消すまでの長さは MATES_STALE_MS で見る
   */
  lead?: RoleId;
}

/**
 * 全体の地図：見えている1人。role は主催者に送るときだけ入る（参加者には同じ役の人しか送らないので要らない）。
 * at は最後に届いたサーバー時刻
 */
export interface MateEntry {
  num: number;
  name: string;
  role?: RoleId;
  lat: number;
  lon: number;
  acc: number;
  at: number;
}

/** 全体の地図で、誰の位置が届くか。oni＝鬼どうし、runner＝逃走者どうし、all＝全員（主催者）、none＝誰も（見学・段階の外） */
export type MatesScope = 'oni' | 'runner' | 'all' | 'none';

/**
 * スマホのセンサーが使えるか。off＝まだ聞いていない、ok＝使える、denied＝許可されていない、
 * unsupported＝このスマホには無い、error＝開けない・位置が取れない
 */
export type SenseState = 'off' | 'ok' | 'denied' | 'unsupported' | 'error';

/** スマホの許可の種類（最初のバナーでまとめてもらう） */
export type PermItem = 'motion' | 'geo' | 'mic';

export type HostOp =
  | 'assign'
  | 'start'
  | 'pause'
  | 'resume'
  | 'reset'
  | 'result'
  | 'durations'
  /** 鬼：逃走者の比率を変える（配役の前だけ） */
  | 'ratio'
  /** 鬼のマイクの聞き方を切り替える（いつでも。試合中に変えても、そのときから全員に効く） */
  | 'mic'
  /** 配役の決め方を切り替える（wish＝希望を聞く／lot＝くじだけ）。次の配役から効く */
  | 'wish-mode'
  /**
   * 配役をいじる：pids の人たちをまとめて role に指名する（role=null で指名を外す＝くじ・希望に戻す）。
   * 配役の前は指名だけ。配役済み（開始の前）なら、役がちがう人をその場で動かす。試合中はできない。指名は開始で消える
   */
  | 'cast'
  | 'tag'
  /** 配役の出し方を切り替える（sync＝全員同時にドン／tap＝タップした人から／now＝すぐ出す）。次の配役から効く */
  | 'reveal'
  /** 遊ぶ範囲を決める（area＝頂点の並び、null で範囲なし）。試合中（時間が0になる前）は変えられない */
  /** 遊ぶ範囲・牢屋の場所を決める（layer で選ぶ。area＝頂点の並び、null でなし）。試合中（時間が0になる前）は変えられない */
  | 'area'
  /** 範囲の縮み方を決める（plan）。試合中（時間が0になる前）は変えられない */
  | 'shrink-plan'
  /** 範囲を今すぐ1段縮める（予告のあと縮む）。逃げ始めてからゲームの終わりまで */
  | 'shrink-now'
  | 'remove'
  /** 新しい夜を始める（部屋を空にする）：今夜の参加者を全員外し、配役前に戻す。名簿は残る */
  | 'clear'
  /** 「前の◯◯に戻りたい」人をつなぐ（ok=true）か断る（ok=false）。rid＝頼みの印 */
  | 'link'
  /** 主催者が手で「捕まった」にする（pid＝逃走者、by＝鬼。by は省略できる） */
  | 'capture'
  /** 主催者が捕獲を取り消す（pid＝逃走者） */
  | 'release'
  /** ミッション成功：牢屋の人を出す（n＝人数。省くと全員。牢屋に入ったのが古い順） */
  | 'mission-free'
  /** 次に進む：走っているタイマーの、いまの段階を2秒後に終わらせて次の段階へ */
  | 'skip'
  /** 夜を終える：全員の画面を SEE YOU AGAIN にする。試合中（時間が0になる前）はできない */
  | 'end'
  /** チャット：仲間の回線で送れるもの（chatMode）・牢屋の人の決まり（chatJail）を切り替える。いつでも */
  | 'chat-mode'
  /** チャット：札に代入する場所の名前を変える（places） */
  | 'chat-places'
  /**
   * ミッションを出す（title＝題。空なら種類ごとの既定の題）。前のミッションが開いていれば締め切ってから出す。
   * kind＝種類（省くと集合写真）。合流は scope（all＝全員を2人組／one＝1組だけ）、範囲は zone（頂点）と need（人数）と secs（締め切りまでの秒）。
   * 合流・範囲は free・n で、成功で牢屋から出す人数を決めておく（free=false で出さない、n を省くと全員）
   */
  | 'mission'
  /** ミッションを締め切る（写真をもう受け付けない。成功した写真はそのまま） */
  | 'mission-close'
  /**
   * 写真を見て決める（photo＝写真の印、ok=true で成功・false でやり直し）。決め直してもいい。
   * 成功のとき free=true なら牢屋の人も出す（n＝人数、省くと全員）。1枚の写真で出すのは最初の成功の1回だけ
   */
  | 'judge'
  /** 捕まったときの全員への知らせの設定を変える（announce＝新しい設定。いつでも変えられる） */
  | 'announce'
  /** 全員のスマホで知らせを試す（帯と音）。試合中（時間が0になる前）はできない */
  | 'announce-test'
  /** 名前を付け直させる（pid＝名簿の人）。付け直すまで名前は「名前を付け直し中」 */
  | 'name-redo'
  /** 名前を SHAME_NAME に切り替える（pid＝名簿の人）。本人は変えられない */
  | 'name-shame'
  /** 名前に使えない言葉を足す・消す（word） */
  | 'ban-add'
  | 'ban-remove'
  /** 司令塔の札を変える（lead＝変える札だけ。on で入れる・外す）。いつでも */
  | 'lead'
  /** 夜の予定を置きかえる（night＝予定の全部）。いつでも。ほかの操作とぶつからないので版番号を見ない */
  | 'night-plan'
  /** プリセットの並びを置きかえる（presets＝全部）。いつでも。版番号を見ない */
  | 'presets'
  /**
   * プリセットをデッキ全部に入れる（preset＝プリセットの印）。durations があればその時間で（夜の予定の「このブロックだけ」）。
   * 待合室・配役のあと・結果発表の間だけ
   */
  | 'preset-apply'
  /** 司令塔を指名する（pid＝今の配役で役がある人。その人の側の司令塔になる） */
  | 'lead-pick'
  /** 司令塔をくじで引き直す（role＝どちらの側か） */
  | 'lead-draw'
  /** 救護の呼び出しを「見た（向かう）」にする（rid＝呼び出しの番号）。押した本人の画面に「本部が見た」と出る。版番号を見ない */
  | 'sos-ack'
  /** 救護の呼び出しを「終わった」にする（rid＝呼び出しの番号）。版番号を見ない */
  | 'sos-done';

export type ClientMsg =
  /** 新しく名簿に入って、今夜に入る（名前が名簿にあれば taken が返る） */
  | { t: 'join'; name: string }
  /** スマホに残っている合い鍵で戻る。今夜に入っていれば状態が、名簿にだけいれば known が返る */
  | { t: 'resume'; pid: string; key: string }
  /** 名簿にいる人が、今夜に入る（known を受け取ったあと、名前のボタンを押した） */
  | { t: 'enter' }
  /** 合い鍵のないスマホで「前の◯◯に戻る」。主催者がつなぐまで待つ */
  | { t: 'reclaim'; name: string }
  /** 「前の◯◯に戻る」をやめる */
  | { t: 'reclaim-stop' }
  | { t: 'host'; token: string }
  | { t: 'ping'; id: number; a: number }
  | { t: 'ack'; assignId: number }
  /** 役が画面に出た（ドラムロールが止まった。tap なら、本人がカードを止めた）。主催者画面の「役が出た」と記録に使う */
  | { t: 'seen'; assignId: number }
  | { t: 'sync'; err: number }
  | {
      t: 'cmd';
      op: HostOp;
      cv: number;
      winner?: Winner;
      durations?: number[];
      ratio?: { oni: number; runner: number };
      mic?: 'always' | 'hold';
      /** 捕まったときの全員への知らせの設定 */
      announce?: AnnounceSettings;
      wishMode?: WishMode;
      /** 配役をいじる：動かす人たち */
      pids?: string[];
      /** 配役をいじる：指名する役（null で指名を外す） */
      role?: RoleId | null;
      /** 印を付ける・外す（op: 'tag'。pids の人たちに） */
      tag?: string;
      on?: boolean;
      reveal?: RevealMode;
      /** 遊ぶ範囲の頂点（[緯度, 経度] の並び）。null で範囲なし */
      area?: [number, number][] | null;
      /** 範囲の縮み方 */
      plan?: ShrinkPlan;
      /** area で決めるのはどれか（既定は遊ぶ範囲） */
      layer?: 'area' | 'jail';
      pid?: string;
      by?: string;
      rid?: string;
      ok?: boolean;
      title?: string;
      /** 名前に使えない言葉（ban-add・ban-remove） */
      word?: string;
      photo?: string;
      free?: boolean;
      /** ミッション成功で出す人数（省くと全員） */
      n?: number;
      /** 司令塔の札（op: 'lead'。変える札だけ） */
      lead?: Partial<LeadRules>;
      /** 夜の予定（op: 'night-plan'。全部） */
      night?: NightPlan;
      /** プリセットの並び（op: 'presets'。全部） */
      presets?: Preset[];
      /** 入れるプリセットの印（op: 'preset-apply'） */
      preset?: string;
      chatMode?: ChatMode;
      chatJail?: ChatJail;
      places?: string[];
      /** ミッションの種類（省くと集合写真） */
      kind?: MissionKind;
      /** 合流：組の作り方 */
      scope?: MeetScope;
      /** 範囲：頂点（[緯度, 経度] の並び） */
      zone?: [number, number][];
      /** 範囲：集まる人数 */
      need?: number;
      /** 締め切りまでの秒（合流は省ける。範囲は要る） */
      secs?: number | null;
    }
  /**
   * 長押し。on=true は押し始め（HOLD_MIN_MS 押し続けたら送る）、false は離した。
   * at はその瞬間のサーバー時刻の見積もり（押し始めは、指を置いた瞬間）。
   * 離したときの start は、どの長押しを離したか（押し始めの at）。resume は、つなぎ直したときに「押していない」と知らせるもの。
   * replay は、切れていて届いたか分からない長押しの送り直し（サーバーは同じ押し始めを2回数えない。知らせも出さない）
   */
  | { t: 'hold'; on: boolean; at?: number; start?: number; resume?: boolean; replay?: boolean }
  /** 鬼のマイクが、誰かの3桁を拾った */
  | { t: 'heard'; code: string }
  /** 逃走者が「捕まえたのは◯◯」を選んだ。manual＝並んだ候補ではなく、手動の一覧から選んだ */
  | { t: 'answer'; pid: string; manual?: boolean }
  /** 鬼が、手動の一覧から「捕まえたのは◯◯」を選んだ（その逃走者の候補に出る） */
  | { t: 'nominate'; pid: string }
  /** 手動で選ぶための一覧がほしい（鬼には捕まっていない逃走者、逃走者には鬼が届く） */
  | { t: 'roster' }
  /** 逃走者が「捕まった」を取り下げた（押し間違い） */
  | { t: 'cancel' }
  /**
   * 牢屋から出す長押し。牢屋の人は「助けて」、外の逃走者は「助ける」（どちらも同じ形）。
   * on=true は押し始め（HOLD_MIN_MS 押し続けたら送る。at は指を置いた瞬間）、false は離した（start はどの長押しか）。
   * 2人の長押しが重なった瞬間に、牢屋の人が出る。音で出るときは heard（牢屋の人のスマホが「助ける番号」を拾った）が来る
   */
  | { t: 'rescue'; on: boolean; at?: number; start?: number }
  /**
   * ミッション（合流）の長押し。指定された相手と2人で同時に長押しすると、重なった瞬間に成功（牢屋の「助ける」と同じ形）。
   * on=true は押し始め（HOLD_MIN_MS 押し続けたら送る。at は指を置いた瞬間）、false は離した（start はどの長押しか）
   */
  | { t: 'meet'; on: boolean; at?: number; start?: number }
  /**
   * 走ると光る。on=true は「走っている」（光っている間 RUN_SEND_EVERY_MS ごとに送り直す）、false は「止まった」。
   * 位置が取れていれば付ける（緯度・経度・誤差の半径 m）。ゲームの段階の外・捕まった人の分は、サーバーが捨てる
   */
  | { t: 'run'; on: boolean; lat?: number; lon?: number; acc?: number }
  /** このスマホで、動きのセンサーと位置が使えるか（変わったときと、つなぎ直したときに送る。主催者画面に数が出る） */
  | { t: 'sense'; motion: SenseState; geo: SenseState }
  /** スマホの許可：まだ入っていないもの（空＝全部入った）。変わったときだけ送る。主催者の「許可がまだの人」に使う */
  | { t: 'perm'; need: PermItem[] }
  /** 全体の地図：自分の位置（ゲームの段階の間だけ MATES_SEND_EVERY_MS ごとに送る。段階の外・捕まった人の分は、サーバーが捨てる） */
  | { t: 'pos'; lat: number; lon: number; acc: number }
  /**
   * 遊ぶ範囲の外に20秒いて失格になった（スマホが自分で決める）。逃走者は「捕まった」扱いで牢屋の助けでは出られず、鬼は記録だけ。
   * 同じ配役のうちは何度送っても1回だけ数える（つなぎ直しの送り直し用）
   */
  | { t: 'dq' }
  /**
   * 失格したあと、牢屋に出頭した（本人が長押しで伝える）。逃走者は「捕まった」のまま、ふつうの牢屋の人になる（仲間の助けで出られる）。
   * 同じ配役のうちに失格していなければ無視する
   */
  | { t: 'dq-ok' }
  /**
   * 救護の呼び出し（緊急ボタンを3秒長押し）。on=true で呼ぶ（位置が取れていれば付ける。あとから位置だけ送り直してもいい）、
   * false で本人が取り消す。cid＝このスマホが決めた呼び出しの印（送り直しで2件にならないように）。試合の段階に関係なくいつでも
   */
  | { t: 'sos'; on: boolean; cid: string; lat?: number; lon?: number; acc?: number }
  /**
   * 配役の希望：次の配役でなりたい役（null＝どちらでも）。配役の前（待合室・結果発表）と、見学の人だけ変えられる。
   * 役が決まってからゲームが終わるまでの分は、サーバーが捨てて今の状態を送り直す
   */
  | { t: 'wish'; role: RoleId | null }
  /**
   * チャットを送る。参加者：card＝札の id（person＝仲間の番号、place＝場所の名前、位置は取れていれば付ける）、
   * emoji＝絵文字の札の番号の並び、digit＝数字。どれを送れるかはサーバーが決め、合わない分は捨てる。
   * 主催者：ch は hq、text＝文、to＝all（全員）・oni・runner・pid:<その人>（1人への返事）
   */
  | {
      t: 'chat';
      ch: ChatCh;
      card?: string;
      person?: number;
      place?: string;
      emoji?: number[];
      digit?: string;
      text?: string;
      to?: string;
      lat?: number;
      lon?: number;
      acc?: number;
    };

/**
 * 本人だけに出す短い知らせ（画面の帯・振動）。状態そのものは snap の me で届く。
 * captured＝鬼「◯◯を捕まえた」、caught＝逃走者「◯◯に捕まった」、heard＝鬼「◯◯をロックオン（音を拾った）」、
 * nominated＝鬼「◯◯に選んでもらう」、released＝主催者が捕獲を取り消した、closed＝今は記録できない、already＝もう捕まっている。
 * 牢屋：freed＝牢屋の人「◯◯が助けてくれた」（other が無ければミッション・主催者）、saved＝助けた人「◯◯を牢屋から出した」、
 * immune＝その逃走者は解放された直後で、まだ捕まらない。
 * ミッション（合流）：met＝「◯◯と合流した」
 */
export type NoticeKind = 'captured' | 'caught' | 'heard' | 'nominated' | 'released' | 'closed' | 'already' | 'freed' | 'saved' | 'immune' | 'met';

/** 手動で選ぶ一覧の1人 */
export interface RosterEntry {
  pid: string;
  num: number;
  name: string;
}

export type ServerMsg =
  /** ns＝名前の状態（due＝主催者に付け直すよう言われた・shamed＝主催者が名前を変えた）。ふつうは付かない */
  | { t: 'welcome'; pid: string; key: string; num: number; name: string; ns?: 'due' | 'shamed' }
  /** この合い鍵の人は名簿にいるが、今夜にはまだ入っていない（名前のボタンを出す） */
  | { t: 'known'; name: string; ns?: 'due' | 'shamed' }
  /** 入れた名前に使えない言葉が入っている（名前の入力に戻す） */
  | { t: 'bad-name' }
  /** その名前は名簿のほかの人のもの（「前の◯◯？」と聞く） */
  | { t: 'taken'; name: string }
  /** 「前の◯◯に戻る」の行方。waiting＝主催者がつなぐのを待っている、denied＝主催者が断った */
  | { t: 'reclaim'; status: 'waiting' | 'denied'; name: string }
  | { t: 'unknown' }
  | { t: 'denied' }
  | { t: 'snap'; now: number; game: GameView; me?: MeView; host?: HostSummary }
  | { t: 'pong'; id: number; a: number; s: number }
  | { t: 'reject'; op: HostOp; reason: string; cv: number }
  /** 試合中の合図。全員に同じ1本を送る。s はサーバーの時刻 */
  | { t: 'hb'; s: number }
  | { t: 'notice'; kind: NoticeKind; other?: { num: number; name: string }; via?: CaptureVia | RescueVia; at: number }
  /** 手動で選ぶ一覧（頼んだ本人にだけ。鬼には捕まっていない逃走者、逃走者には鬼） */
  | { t: 'roster'; people: RosterEntry[] }
  /** 走ると光る：いま光っている全員（全員に同じものを送る。変わるたびに、まとめて）。s はサーバーの時刻 */
  | { t: 'glow'; s: number; runs: GlowEntry[] }
  /** 全体の地図：見えてよい人の位置（その人の役で中身が変わる）。s はサーバーの時刻 */
  | { t: 'mates'; s: number; scope: MatesScope; people: MateEntry[] }
  /**
   * チャット。reset＝true は「いま見えてよい全部」（つないだとき・配役が変わったとき。手元の分を入れ替える）、無ければ足す分。
   * team は同じ役の仲間（「◯◯、一緒に来て！」で選ぶ相手。自分は入らない）。reset のときだけ付く
   */
  | { t: 'chat'; s: number; reset?: boolean; msgs: ChatMsg[]; team?: { num: number; name: string }[] };
