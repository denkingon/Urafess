import { CLAIM_PAIR_WINDOW_MS, HOLD_MAX_MS, PHASES } from './rules';
import { positionAt, type Timer } from './schedule';

/**
 * 捕獲の記録で、サーバーとスマホが同じに使う決まり。
 *
 * 鬼は「捕まえた」、逃走者は「捕まった」を長押しする。長押しは「押し始め〜離した」のサーバー時刻で持つ。
 * 逃走者の画面に並べる候補（鬼）は、次のどれかに当てはまる鬼：
 *   - 音：逃走者のスマホが鳴らした3桁を、その鬼のスマホが拾った
 *   - 同時：逃走者と同じ時間に長押ししていた
 *   - 鬼が選んだ：その鬼が「手動で選ぶ」でこの逃走者を選んだ
 *   - 前後：重なってはいないが、前後 CLAIM_PAIR_WINDOW_MS 以内に長押しした
 * 候補は同じ大きさで並べ、逃走者本人がどれを選んでもよい。選んだ鬼が捕まえたとして記録に残る。
 */

/**
 * どうやって記録されたか（選ばれた鬼が持っていた一番強い手がかり）。
 * sound＝音を拾った、together＝同時に長押し、nominated＝鬼が手動で選んだ、near＝前後に長押し、
 * manual＝逃走者が手動の一覧から選んだ（ほかの手がかり無し）、host＝主催者が手で
 */
export type CaptureVia = 'sound' | 'together' | 'nominated' | 'near' | 'manual' | 'host';

export const VIA_NAME: Record<CaptureVia, string> = {
  sound: '音',
  together: '同時に長押し',
  nominated: '鬼が選んだ',
  near: '前後に長押し',
  manual: '手動',
  host: '主催者',
};

/** 逃走者に見せる候補（鬼）。候補でない鬼の名前は送らない（役は本人にしか見せない） */
export interface Candidate {
  pid: string;
  num: number;
  name: string;
  /** その鬼のスマホが、自分の音を拾った */
  heard: boolean;
  /** 同じ時間に長押ししていた */
  together: boolean;
  /** その鬼が手動で自分を選んだ */
  nominated: boolean;
  /** 長押しどうしが離れていた時間（ms、重なっていれば 0、長押ししていなければ null） */
  gapMs: number | null;
}

/** 長押し1回。end が null なら押している途中 */
export interface Hold {
  start: number;
  end: number | null;
}

export interface OniSignal {
  pid: string;
  num: number;
  name: string;
  holds: readonly Hold[];
  /** この逃走者の音を拾ったサーバー時刻（無ければ null） */
  heardAt: number | null;
  /** 手動でこの逃走者を選んだサーバー時刻（無ければ null） */
  nominatedAt: number | null;
}

/** 候補に出す最大人数（画面に並べられる数） */
export const MAX_CANDIDATES = 6;

function holdEnd(h: Hold, now: number): number {
  return h.end ?? Math.min(now, h.start + HOLD_MAX_MS);
}

/** 長押しの組どうしの関係：重なっていたか、一番近いときに何 ms 離れていたか */
export function relateHolds(a: readonly Hold[], b: readonly Hold[], now: number): { together: boolean; gapMs: number | null } {
  let gap: number | null = null;
  for (const x of a) {
    for (const y of b) {
      const overlap = Math.min(holdEnd(x, now), holdEnd(y, now)) - Math.max(x.start, y.start);
      if (overlap > 0) return { together: true, gapMs: 0 };
      const g = -overlap;
      if (gap === null || g < gap) gap = g;
    }
  }
  return { together: false, gapMs: gap };
}

function strength(c: Candidate): number {
  return (c.heard ? 4 : 0) + (c.together ? 2 : 0) + (c.nominated ? 1 : 0);
}

/**
 * 逃走者の長押し runnerHolds に対する候補を作る。並び順は、手がかりが強い順（音→同時→鬼が選んだ）、
 * 次に長押しが近い順、最後に番号順。どれを選んでもよいので、画面では同じ大きさで並べる
 */
export function rankCandidates(runnerHolds: readonly Hold[], oni: readonly OniSignal[], now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const o of oni) {
    const rel = relateHolds(runnerHolds, o.holds, now);
    const near = rel.gapMs !== null && rel.gapMs <= CLAIM_PAIR_WINDOW_MS;
    const heard = o.heardAt !== null;
    const nominated = o.nominatedAt !== null;
    if (!near && !heard && !nominated) continue;
    out.push({ pid: o.pid, num: o.num, name: o.name, heard, together: rel.together, nominated, gapMs: near ? rel.gapMs : null });
  }
  out.sort((a, b) => {
    const s = strength(b) - strength(a);
    if (s !== 0) return s;
    const ga = a.gapMs ?? Infinity;
    const gb = b.gapMs ?? Infinity;
    if (ga !== gb) return ga - gb;
    return a.num - b.num;
  });
  return out.slice(0, MAX_CANDIDATES);
}

/** 選ばれた候補から、記録の手がかりを決める */
export function viaOf(c: Candidate | undefined): CaptureVia {
  if (!c) return 'manual';
  if (c.heard) return 'sound';
  if (c.together) return 'together';
  if (c.nominated) return 'nominated';
  return 'near';
}

/** 捕まえる・捕まるができるのは「ゲーム」の段階（追跡が始まってから終わるまで）が動いている間だけ */
export const CAPTURE_PHASE_INDEX = PHASES.findIndex((p) => p.id === 'game');

export function captureOpenAt(timer: Timer | null, serverAt: number): boolean {
  if (!timer || timer.status !== 'running') return false;
  const pos = positionAt(timer, serverAt);
  return pos.kind === 'phase' && pos.index === CAPTURE_PHASE_INDEX && !pos.waitingForStart;
}

/** その回の3桁（逃走者のスマホが音で鳴らす）。配役のたびに、部屋の中で重ならないように選ぶ */
export function pickCodes(count: number, random: () => number = Math.random): string[] {
  const pool: number[] = [];
  for (let i = 100; i <= 999; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (count > pool.length) throw new Error('too many people for 3-digit codes');
  return pool.slice(0, count).map(String);
}
