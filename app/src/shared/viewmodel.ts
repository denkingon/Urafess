import { CAPTURE_PHASE_INDEX, captureOpenAt } from './capture';
import { decideWinner, endReason, everyoneJailed } from './jail';
import type { GameView, MeView, Winner } from './protocol';
import { CLAIM_GRACE_MS, PHASES, ROLE_NAME } from './rules';
import { formatClock, positionAt } from './schedule';

/**
 * 参加者の画面に渡す中身。Claude Design のキャンバス「Urafess アプリ画面」の共通部品 Phone の props と同じ形。
 * 見た目（UI）はこれを受け取って描くだけにする。
 */
export interface PhoneView {
  round: string;
  role: '逃走者' | '鬼' | 'なし';
  /** 0＝配役前、1＝配役 … 6＝結果発表（Phone の段階バー） */
  step: number;
  label: string;
  big: string;
  message: string;
  oni: string;
  runners: string;
  offline: boolean;
  /** 捕獲の長押しボタン：oni＝「捕まえた」、runner＝「捕まった」、none＝出さない（ゲームの段階だけ出す） */
  touch: 'oni' | 'runner' | 'none';
  /** 自分が今の配役で捕まった */
  caught: boolean;
  /** 夜が終わった（SEE YOU AGAIN の画面）。古い呼び出し側は省略できる */
  ended?: boolean;
  /**
   * 走ると光る：live＝ゲームの段階（光った人が地図に出る）、prep＝その前（配役〜追跡開始まで。センサーの準備をする）、none＝出さない。
   * 見学の人・捕まった人にも出す（光らないが、光った人は見える）
   */
  glow: 'none' | 'prep' | 'live';
  /** 走ると光る：いま走ったら光る（配役に入っていて、捕まっておらず、ゲームの段階が動いている） */
  lightable: boolean;
  /**
   * 牢屋：help＝自分が牢屋にいて、出られる時間（マイクで「助ける」の音を聞く・「助けて」を長押しできる）、
   * save＝自分は外にいて、牢屋に仲間がいる（「助ける」を長押しできる）、none＝どちらでもない。古い呼び出し側は省略できる
   */
  rescue?: 'none' | 'help' | 'save';
  /** 解放された直後で、まだ捕まらない残りの時間（ms）。0 ならふつう */
  immuneMs?: number;
}

/** 夜の最後の画面に出す言葉 */
export const FAREWELL = 'SEE YOU AGAIN';

const MESSAGES: Record<'oni' | 'runner', string[]> = {
  // 配役, 逃走開始まで, 追跡開始まで, ゲーム, 広場に戻る
  runner: [
    '鬼から逃げ切れ。合図まで、その場で待つ。',
    '0になったら一斉に逃げる。',
    '今のうちに遠くへ逃げる。',
    '逃げ切れ。',
    'ゲーム終了。広場に戻る。',
  ],
  oni: [
    '逃走者を捕まえろ。合図まで、その場で待つ。',
    'その場で待つ。逃走者が散るのを見送る。',
    '広場で待つ。0になったら追いかける。',
    '捕まえろ。',
    'ゲーム終了。広場に戻る。',
  ],
};

const WINNER_TEXT: Record<Winner, string> = { oni: '鬼の勝ち', runner: '逃走者の勝ち' };

export function participantView(
  game: GameView,
  me: MeView,
  serverNow: number,
  online: boolean,
): PhoneView {
  const inRound = me.role !== null && me.assignId === game.assignId && !me.removed;
  const roleName = inRound && me.role ? (ROLE_NAME[me.role] as '鬼' | '逃走者') : 'なし';
  const assigned = game.stage !== 'lobby';
  const base: PhoneView = {
    round: String(Math.max(game.round, 1)),
    role: roleName,
    step: 0,
    label: '',
    big: '',
    message: '',
    oni: assigned ? String(game.counts.oni) : '?',
    runners: !assigned
      ? '?'
      : game.stage === 'timer' || game.stage === 'result'
        ? `残り${game.counts.runner - (game.counts.caught ?? 0)}/${game.counts.runner}`
        : String(game.counts.runner),
    offline: !online,
    touch: 'none',
    caught: false,
    glow: 'none',
    lightable: false,
  };

  // 夜の最後：入室している人にも、途中で外された人にも、同じ言葉を出す
  if (game.stage === 'ended') {
    return { ...base, step: 6, label: '', big: FAREWELL, message: '', ended: true };
  }

  if (me.removed) {
    return { ...base, label: '参加していない', big: '—', message: '主催者に確認する。' };
  }

  if (game.stage === 'lobby') {
    return {
      ...base,
      label: '配役を待っている',
      big: `${game.counts.total}人`,
      message: '主催者が配役を始めるまで、そのまま待つ。',
    };
  }

  const step = stepOf(game, serverNow);
  const glow = glowPhase(game, serverNow);

  if (!inRound) {
    // 配役のあとに来た人は、このラウンドは見ているだけ（光った人は見える）
    return {
      ...base,
      step,
      label: '次の配役から参加',
      big: game.timer && step >= 2 && step <= 5 ? bigClock(game, serverNow) : '待機',
      message: 'このラウンドは見学。次の配役で役が決まる。',
      glow,
    };
  }

  const role = me.role as 'oni' | 'runner';

  if (game.stage === 'assigned') {
    return { ...base, step: 1, label: 'あなたの役', big: roleName, message: MESSAGES[role][0], glow };
  }

  if (game.stage === 'result') {
    const winner = game.result ?? decideWinner(game);
    return {
      ...base,
      step: 6,
      label: '結果発表',
      big: WINNER_TEXT[winner],
      message: `${game.resultAuto === false ? '' : endReason(game)}次のラウンドは配役から。`,
    };
  }

  // stage === 'timer'
  const timer = game.timer!;
  const pos = positionAt(timer, serverNow);
  // caught＝いま牢屋にいる（古いサーバー（捕獲の前の版）は送らない。undefined も「いない」）
  const caught = role === 'runner' && me.caught != null;
  const allCaught = game.allCaughtAt != null;
  // 解放された直後は捕まらない（「捕まった」は出さない）
  const immuneMs = role === 'runner' && !caught && me.freeUntil != null ? Math.max(0, me.freeUntil - serverNow) : 0;
  // 長押しはゲームの段階（終わった直後の少しを含む）だけ。牢屋の人・捕まらない間の人には出さない
  const open = captureOpenAt(timer, serverNow) || captureOpenAt(timer, serverNow - CLAIM_GRACE_MS);
  const touch: PhoneView['touch'] = !open ? 'none' : role === 'oni' ? 'oni' : caught || immuneMs > 0 ? 'none' : 'runner';
  // 牢屋から出られるのは、ゲームの段階が動いている間だけ（全員が入ったら、もう出られない）
  const rescueOpen = captureOpenAt(timer, serverNow) && !allCaught;
  const rescue: PhoneView['rescue'] =
    role !== 'runner' || !rescueOpen ? 'none' : caught ? 'help' : (game.counts.caught ?? 0) > 0 ? 'save' : 'none';
  if (pos.kind === 'done') {
    // 時間が0になった：結果はアプリが決める（サーバーの確定を待たずに、同じ決め方で出す）
    return { ...base, step: 6, label: '結果発表', big: WINNER_TEXT[decideWinner(game)], message: endReason(game), touch, caught };
  }
  // 光るのは、ゲームの段階が動いている間だけ（止めている間・始まる前の2秒は光らない）。捕まった人は光らない
  const lightable = !caught && captureOpenAt(timer, serverNow);
  const paused = timer.status === 'paused';
  const afterGame = pos.index > CAPTURE_PHASE_INDEX;
  const message = paused
    ? '主催者の合図を待つ。'
    : afterGame && (allCaught || everyoneJailed(game.counts))
      ? '全員が牢屋に入った。ゲーム終了。広場に戻る。'
      : caught && pos.index === CAPTURE_PHASE_INDEX
        ? allCaught
          ? '全員が牢屋に入った。ゲーム終了。'
          : '牢屋で待つ。仲間に触れてもらうか、ミッションで出られる。'
        : immuneMs > 0
          ? `牢屋から出た。あと${Math.ceil(immuneMs / 1000)}秒は捕まらない。牢屋から離れる。`
          : MESSAGES[role][pos.index + 1];
  const phaseLabel = PHASES[pos.index].label;
  return {
    ...base,
    step: pos.index + 2,
    label: paused ? `一時停止中（${phaseLabel}）` : caught ? `${phaseLabel}・牢屋` : immuneMs > 0 ? `${phaseLabel}・捕まらない` : phaseLabel,
    big: formatClock(pos.remainingMs),
    message,
    touch,
    caught,
    glow,
    lightable,
    rescue,
    immuneMs,
  };
}

/** 走ると光る：配役〜追跡開始までは準備、ゲームの段階は光る（一時停止中も地図は出したまま。光る人はいなくなる） */
export function glowPhase(game: GameView, serverNow: number): PhoneView['glow'] {
  if (game.stage === 'assigned') return 'prep';
  if (game.stage !== 'timer' || !game.timer) return 'none';
  const pos = positionAt(game.timer, serverNow);
  if (pos.kind === 'done') return 'none';
  if (pos.index < CAPTURE_PHASE_INDEX) return 'prep';
  return pos.index === CAPTURE_PHASE_INDEX ? 'live' : 'none';
}

function stepOf(game: GameView, serverNow: number): number {
  if (game.stage === 'assigned') return 1;
  if (game.stage === 'result') return 6;
  if (game.stage === 'timer' && game.timer) {
    const pos = positionAt(game.timer, serverNow);
    return pos.kind === 'done' ? 6 : pos.index + 2;
  }
  return 0;
}

function bigClock(game: GameView, serverNow: number): string {
  const pos = positionAt(game.timer!, serverNow);
  return pos.kind === 'done' ? '0:00' : formatClock(pos.remainingMs);
}

/** 主催者画面の上に出す、今の段階の名前と残り時間 */
export function hostStatus(game: GameView, serverNow: number): { title: string; big: string; next: string } {
  switch (game.stage) {
    case 'lobby':
      return { title: '配役前', big: `${game.counts.total}人`, next: '次：配役' };
    case 'assigned':
      return { title: '1 配役済み', big: `${game.counts.oni}/${game.counts.runner}`, next: '次：開始で「逃走開始まで」' };
    case 'ended':
      return { title: '夜は終わった', big: FAREWELL, next: '次：配役で再開／新しい夜を始める' };
    case 'result':
      return {
        title: `6 結果発表（${game.resultAuto === false ? '主催者が決めた' : 'アプリが決めた'}）`,
        big: WINNER_TEXT[game.result ?? decideWinner(game)],
        next: `${game.resultAuto === false ? '' : endReason(game)}次：配役で次のラウンド`,
      };
    case 'timer': {
      const timer = game.timer!;
      const pos = positionAt(timer, serverNow);
      if (pos.kind === 'done') return { title: '6 結果発表', big: WINNER_TEXT[decideWinner(game)], next: `${endReason(game)}アプリが結果を出す` };
      const nextLabel = pos.index + 1 < PHASES.length ? PHASES[pos.index + 1].label : '結果発表';
      const paused = timer.status === 'paused';
      const allIn = game.allCaughtAt != null ? '全員が牢屋に入った（鬼の勝ちで決まり）　' : '';
      return {
        title: `${pos.index + 2} ${PHASES[pos.index].label}${paused ? '（一時停止中）' : ''}`,
        big: formatClock(pos.remainingMs),
        next: `${allIn}次：${nextLabel}`,
      };
    }
  }
}
