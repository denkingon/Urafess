import type { Candidate, CaptureVia } from './capture';
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
  | 'result';

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
}

/** 本人だけに送る部分 */
export interface MeView {
  pid: string;
  num: number;
  name: string;
  /** 今の配役での役。途中で来た人・外された人は null */
  role: RoleId | null;
  assignId: number;
  removed: boolean;
  /** 今の配役での自分の3桁。逃走者が「捕まった」を長押ししている間、スマホがこれを音で鳴らす */
  code: string | null;
  /** 今の配役で捕まった（逃走者だけ） */
  caught: { byNum: number | null; byName: string | null; at: number; via: CaptureVia } | null;
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
  }[];
  oni: { pid: string; num: number; name: string; catches: number }[];
}

/** 主催者だけに送る集計 */
export interface HostSummary {
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
  dupNames: { name: string; people: { pid: string; num: number }[] }[];
  /** 配役前は null */
  capture: HostCapture | null;
}

export type HostOp =
  | 'assign'
  | 'start'
  | 'pause'
  | 'resume'
  | 'reset'
  | 'result'
  | 'durations'
  | 'remove'
  /** 部屋を空にする：参加者を全員外し、配役前に戻す（リハーサルのあと用） */
  | 'clear'
  /** 主催者が手で「捕まった」にする（pid＝逃走者、by＝鬼。by は省略できる） */
  | 'capture'
  /** 主催者が捕獲を取り消す（pid＝逃走者） */
  | 'release';

export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'resume'; pid: string; key: string }
  | { t: 'host'; token: string }
  | { t: 'ping'; id: number; a: number }
  | { t: 'ack'; assignId: number }
  | { t: 'sync'; err: number }
  | { t: 'cmd'; op: HostOp; cv: number; winner?: Winner; durations?: number[]; pid?: string; by?: string }
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
  | { t: 'cancel' };

/**
 * 本人だけに出す短い知らせ（画面の帯・振動）。状態そのものは snap の me で届く。
 * captured＝鬼「◯◯を捕まえた」、caught＝逃走者「◯◯に捕まった」、heard＝鬼「◯◯をロックオン（音を拾った）」、
 * nominated＝鬼「◯◯に選んでもらう」、released＝主催者が捕獲を取り消した、closed＝今は記録できない、already＝もう捕まっている
 */
export type NoticeKind = 'captured' | 'caught' | 'heard' | 'nominated' | 'released' | 'closed' | 'already';

/** 手動で選ぶ一覧の1人 */
export interface RosterEntry {
  pid: string;
  num: number;
  name: string;
}

export type ServerMsg =
  | { t: 'welcome'; pid: string; key: string; num: number; name: string }
  | { t: 'unknown' }
  | { t: 'denied' }
  | { t: 'snap'; now: number; game: GameView; me?: MeView; host?: HostSummary }
  | { t: 'pong'; id: number; a: number; s: number }
  | { t: 'reject'; op: HostOp; reason: string; cv: number }
  /** 試合中の合図。全員に同じ1本を送る。s はサーバーの時刻 */
  | { t: 'hb'; s: number }
  | { t: 'notice'; kind: NoticeKind; other?: { num: number; name: string }; via?: CaptureVia; at: number }
  /** 手動で選ぶ一覧（頼んだ本人にだけ。鬼には捕まっていない逃走者、逃走者には鬼） */
  | { t: 'roster'; people: RosterEntry[] };
