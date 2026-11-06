import { CAPTURE_PHASE_INDEX, captureOpenAt } from './capture';
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

  // ---- 見た目の層（アニメと同じ枠：上＝段階、真ん中＝絵、下＝時間と人数の印）が使う ----
  /** 真ん中に出すピクトの id（裏フェス ピクトグラムの正本） */
  scene: string;
  /** ひとこと（日本語・英語） */
  word: Pair | null;
  /** 大事なときだけ出す文（誰に捕まった・一時停止・見学など） */
  note: Pair | null;
  /** 大きい数字（残り時間・待合室の人数）。出さないときは null */
  time: string | null;
  /** 数字の横に出す印 */
  unit: 'person' | null;
  /** 結果で、自分の側が勝ったか */
  outcome: 'win' | 'lose' | null;
  /** 人数の印（配役のあと） */
  counts: { oni: number; runners: number; left: number } | null;
  /** 段階バーの時間（逃走開始まで〜広場に戻るまで。主催者が変えた長さ） */
  times: string[];
  paused: boolean;
  /** 夜が終わった（SEE YOU AGAIN の画面）。古い呼び出し側は省略できる */
  ended?: boolean;
  /**
   * 走ると光る：live＝ゲームの段階（光った人が地図に出る）、prep＝その前（配役〜追跡開始まで。センサーの準備をする）、none＝出さない。
   * 見学の人・捕まった人にも出す（光らないが、光った人は見える）
   */
  glow: 'none' | 'prep' | 'live';
  /** 走ると光る：いま走ったら光る（配役に入っていて、捕まっておらず、ゲームの段階が動いている） */
  lightable: boolean;
}

/** 夜の最後の画面に出す言葉 */
export const FAREWELL = 'SEE YOU AGAIN';

/** 日本語と英語の組 */
export type Pair = readonly [ja: string, en: string];

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
const WINNER_PAIR: Record<Winner, Pair> = { oni: ['鬼の勝ち', 'Chasers win'], runner: ['逃走者の勝ち', 'Runners win'] };

/** 段階ごとの絵とひとこと（配役・逃走開始まで・追跡開始まで・ゲーム・広場に戻るまで） */
const SCENES: Record<'oni' | 'runner', { scene: string; word: Pair }[]> = {
  runner: [
    { scene: 'runner', word: ['逃走者', 'RUNNER'] },
    { scene: 'ready', word: ['待つ', 'WAIT'] },
    { scene: 'run', word: ['逃げろ', 'RUN'] },
    { scene: 'wall', word: ['隠れろ', 'HIDE'] },
    { scene: 'gather', word: ['戻る', 'BACK'] },
  ],
  oni: [
    { scene: 'chaser', word: ['鬼', 'CHASER'] },
    { scene: 'ready', word: ['待つ', 'WAIT'] },
    { scene: 'chaser', word: ['待つ', 'WAIT'] },
    { scene: 'search', word: ['探せ', 'HUNT'] },
    { scene: 'gather', word: ['戻る', 'BACK'] },
  ],
};

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
    scene: 'gather',
    word: null,
    note: null,
    time: null,
    unit: null,
    outcome: null,
    counts: assigned
      ? { oni: game.counts.oni, runners: game.counts.runner, left: game.counts.runner - (game.counts.caught ?? 0) }
      : null,
    times: (game.timer?.durations ?? game.durations).map((d) => formatClock(d)),
    paused: false,
    glow: 'none',
    lightable: false,
  };

  // 夜の最後：入室している人にも、途中で外された人にも、同じ言葉を出す
  if (game.stage === 'ended') {
    return { ...base, step: 6, label: '', big: FAREWELL, message: '', ended: true, scene: 'home', counts: null };
  }

  if (me.removed) {
    return {
      ...base, label: '参加していない', big: '—', message: '主催者に確認する。',
      scene: 'quiet', word: ['参加していない', 'NOT IN'], note: ['主催者に確認する', 'Ask the host'], counts: null,
    };
  }

  if (game.stage === 'lobby') {
    return {
      ...base,
      label: '配役を待っている',
      big: `${game.counts.total}人`,
      message: '主催者が配役を始めるまで、そのまま待つ。',
      scene: 'gather',
      word: ['待つ', 'WAIT'],
      time: String(game.counts.total),
      unit: 'person',
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
      scene: 'quiet',
      word: ['見学', 'WATCH'],
      note: ['次の配役から参加', 'You join from the next round'],
      time: game.timer && step >= 2 && step <= 5 ? bigClock(game, serverNow) : null,
      glow,
    };
  }

  const role = me.role as 'oni' | 'runner';

  if (game.stage === 'assigned') {
    return { ...base, step: 1, label: 'あなたの役', big: roleName, message: MESSAGES[role][0], ...SCENES[role][0], glow };
  }

  if (game.stage === 'result') {
    return {
      ...base,
      step: 6,
      label: '結果発表',
      big: game.result ? WINNER_TEXT[game.result] : '発表待ち',
      message: '次のラウンドは配役から。',
      scene: game.result ? 'result' : 'gather',
      word: !game.result ? ['発表待ち', 'WAITING'] : game.result === role ? ['勝ち', 'WIN'] : ['負け', 'LOSE'],
      note: game.result ? WINNER_PAIR[game.result] : null,
      outcome: !game.result ? null : game.result === role ? 'win' : 'lose',
    };
  }

  // stage === 'timer'
  const timer = game.timer!;
  const pos = positionAt(timer, serverNow);
  // 古いサーバー（捕獲の前の版）は caught を送らない。undefined も「捕まっていない」
  const caught = role === 'runner' && me.caught != null;
  // 長押しはゲームの段階（終わった直後の少しを含む）だけ。捕まった人には出さない
  const open = captureOpenAt(timer, serverNow) || captureOpenAt(timer, serverNow - CLAIM_GRACE_MS);
  const touch: PhoneView['touch'] = !open ? 'none' : role === 'oni' ? 'oni' : caught ? 'none' : 'runner';
  if (pos.kind === 'done') {
    return {
      ...base, step: 6, label: '結果発表', big: '発表待ち', message: '主催者の発表を待つ。', touch, caught,
      scene: 'gather', word: ['発表待ち', 'WAITING'],
    };
  }
  // 光るのは、ゲームの段階が動いている間だけ（止めている間・始まる前の2秒は光らない）。捕まった人は光らない
  const lightable = !caught && captureOpenAt(timer, serverNow);
  const paused = timer.status === 'paused';
  const message = paused
    ? '主催者の合図を待つ。'
    : caught
      ? `${me.caught?.byName ? `${me.caught.byName}に` : ''}捕まった。その場の決まりに従う。`
      : MESSAGES[role][pos.index + 1];
  return {
    ...base,
    step: pos.index + 2,
    label: paused ? `一時停止中（${PHASES[pos.index].label}）` : caught ? `${PHASES[pos.index].label}・捕まった` : PHASES[pos.index].label,
    big: formatClock(pos.remainingMs),
    message,
    touch,
    caught,
    scene: caught ? 'jail' : SCENES[role][pos.index + 1].scene,
    word: paused ? ['一時停止', 'PAUSED'] : caught ? ['捕まった', 'CAUGHT'] : SCENES[role][pos.index + 1].word,
    note: paused
      ? ['主催者の合図を待つ', 'Wait for the host']
      : caught
        ? me.caught?.byName
          ? [`${me.caught.byName}に捕まった`, `Caught by ${me.caught.byName}`]
          : ['その場の決まりに従う', 'Follow the rules on site']
        : null,
    time: formatClock(pos.remainingMs),
    paused,
    glow,
    lightable,
  };
}

/** つないでいる間（まだ部屋の様子が来ていない）の画面 */
export function connectingView(online: boolean): PhoneView {
  return {
    round: '—', role: 'なし', step: 0, label: online ? 'つないでいる' : '通信を待っている',
    big: '…', message: '', oni: '?', runners: '?', offline: !online, touch: 'none', caught: false,
    scene: 'gather', word: online ? ['つないでいる', 'CONNECTING'] : ['通信を待っている', 'OFFLINE'], note: null,
    time: null, unit: null, outcome: null, counts: null, times: [], paused: false, glow: 'none', lightable: false,
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
        title: '6 結果発表',
        big: game.result ? WINNER_TEXT[game.result] : '発表待ち',
        next: '次：配役で次のラウンド',
      };
    case 'timer': {
      const timer = game.timer!;
      const pos = positionAt(timer, serverNow);
      if (pos.kind === 'done') return { title: '6 結果発表', big: '発表待ち', next: '勝ったほうを押す' };
      const nextLabel = pos.index + 1 < PHASES.length ? PHASES[pos.index + 1].label : '結果発表';
      const paused = timer.status === 'paused';
      return {
        title: `${pos.index + 2} ${PHASES[pos.index].label}${paused ? '（一時停止中）' : ''}`,
        big: formatClock(pos.remainingMs),
        next: `次：${nextLabel}`,
      };
    }
  }
}
