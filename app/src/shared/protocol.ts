import type { Candidate, CaptureVia } from './capture';

/** 牢屋からどうやって出たか。sound＝助ける人の音を拾った、together＝同時に長押し、mission＝ミッション成功、host＝主催者が手で */
export type RescueVia = 'sound' | 'together' | 'mission' | 'host';
import type { RoleId } from './rules';
import type { Timer } from './schedule';

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
  /** 逃走者が全員同時に牢屋に入った時刻（その配役は鬼の勝ちで決まり）。まだなら null。古いサーバーは送らない */
  allCaughtAt?: number | null;
  /** result をアプリが決めた（true）か、主催者が押した（false）か */
  resultAuto?: boolean;
  /** 鬼のマイクの聞き方（always＝ずっと聞く／hold＝押している間だけ）。古いサーバーからは来ない（そのときは always） */
  micMode?: 'always' | 'hold';
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
  /** 逃走者の「捕まった」（選ぶまで開いている）。at は最初に長押しを始めたサーバー時刻。cands は並べる候補 */
  claim: { at: number; cands: Candidate[] } | null;
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
export interface HostSummary {
  /** 入室していて外されていない人 */
  total: number;
  /** 配役の選択用。主催者だけに送る（合い鍵などは含めない） */
  participants?: { pid: string; num: number; name: string; role: RoleId | null }[];
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
  | 'end';

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
  | { t: 'sync'; err: number }
  | {
      t: 'cmd';
      op: HostOp;
      cv: number;
      /** 指定した場合は全参加者の役をこの通りに確定する。省略時は自動抽選 */
      roles?: { pid: string; role: RoleId }[];
      winner?: Winner;
      durations?: number[];
      ratio?: { oni: number; runner: number };
      mic?: 'always' | 'hold';
      pid?: string;
      by?: string;
      rid?: string;
      ok?: boolean;
      /** ミッション成功で出す人数（省くと全員） */
      n?: number;
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
   * 走ると光る。on=true は「走っている」（光っている間 RUN_SEND_EVERY_MS ごとに送り直す）、false は「止まった」。
   * 位置が取れていれば付ける（緯度・経度・誤差の半径 m）。ゲームの段階の外・捕まった人の分は、サーバーが捨てる
   */
  | { t: 'run'; on: boolean; lat?: number; lon?: number; acc?: number }
  /** このスマホで、動きのセンサーと位置が使えるか（変わったときと、つなぎ直したときに送る。主催者画面に数が出る） */
  | { t: 'sense'; motion: SenseState; geo: SenseState }
  /** 全体の地図：自分の位置（ゲームの段階の間だけ MATES_SEND_EVERY_MS ごとに送る。段階の外・捕まった人の分は、サーバーが捨てる） */
  | { t: 'pos'; lat: number; lon: number; acc: number };

/**
 * 本人だけに出す短い知らせ（画面の帯・振動）。状態そのものは snap の me で届く。
 * captured＝鬼「◯◯を捕まえた」、caught＝逃走者「◯◯に捕まった」、heard＝鬼「◯◯をロックオン（音を拾った）」、
 * nominated＝鬼「◯◯に選んでもらう」、released＝主催者が捕獲を取り消した、closed＝今は記録できない、already＝もう捕まっている。
 * 牢屋：freed＝牢屋の人「◯◯が助けてくれた」（other が無ければミッション・主催者）、saved＝助けた人「◯◯を牢屋から出した」、
 * immune＝その逃走者は解放された直後で、まだ捕まらない
 */
export type NoticeKind = 'captured' | 'caught' | 'heard' | 'nominated' | 'released' | 'closed' | 'already' | 'freed' | 'saved' | 'immune';

/** 手動で選ぶ一覧の1人 */
export interface RosterEntry {
  pid: string;
  num: number;
  name: string;
}

export type ServerMsg =
  | { t: 'welcome'; pid: string; key: string; num: number; name: string }
  /** この合い鍵の人は名簿にいるが、今夜にはまだ入っていない（名前のボタンを出す） */
  | { t: 'known'; name: string }
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
  | { t: 'mates'; s: number; scope: MatesScope; people: MateEntry[] };
