import type { GameView } from './protocol';
import type { RoleId } from './rules';
import { positionAt } from './schedule';

/**
 * 偽の群衆（稽古用）。1人ずつ座標を持ち、段階と役に合わせて「それらしく」動く。
 * ここは動きの決まりだけ（通信も画面も知らない）。つなぐのは client/crowd/driver.ts、見るのは /lab?k=crowd。
 *
 * 本物の人の読めなさは出ない。出るのは：広場に集まる → 逃走者が散って隠れる → 鬼が見つけて追う →
 * 近づいたら捕まる → 牢屋へ歩く → 度胸のある人が助けに来る → 広場に戻る。
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const M_PER_DEG = 111_320;

/** p から東へ east m、北へ north m */
export function offset(p: LatLon, east: number, north: number): LatLon {
  return { lat: p.lat + north / M_PER_DEG, lon: p.lon + east / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) };
}

/** a から見た b（東・北、m） */
export function delta(a: LatLon, b: LatLon): { east: number; north: number } {
  return { east: (b.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180), north: (b.lat - a.lat) * M_PER_DEG };
}

export function dist(a: LatLon, b: LatLon): number {
  const d = delta(a, b);
  return Math.hypot(d.east, d.north);
}

/**
 * 群衆から見た段階。idle＝配役前・結果、ready＝配役済み、wait＝逃走開始まで（その場で待つ）、
 * escape＝追跡開始まで（逃走者だけ動く）、game＝ゲーム、return＝広場に戻る、paused＝止めている
 */
export type CrowdPhase = 'idle' | 'ready' | 'wait' | 'escape' | 'game' | 'return' | 'paused';

export function phaseOf(game: GameView | null, serverNow: number): CrowdPhase {
  if (!game) return 'idle';
  if (game.stage === 'assigned') return 'ready';
  if (game.stage !== 'timer' || !game.timer) return 'idle';
  if (game.timer.status === 'paused') return 'paused';
  const pos = positionAt(game.timer, serverNow);
  if (pos.kind === 'done') return 'return';
  if (pos.waitingForStart) return 'paused';
  return (['wait', 'escape', 'game', 'return'] as const)[pos.index] ?? 'return';
}

export type Pace = 'stay' | 'walk' | 'run';
/** いま何をしているか（上から見る地図に出す） */
export type Act = 'mill' | 'wait' | 'flee' | 'hide' | 'move' | 'patrol' | 'chase' | 'jail' | 'rescue' | 'home';

export interface Bot {
  pos: LatLon;
  goal: LatLon | null;
  pace: Pace;
  act: Act;
  /** 次に考え直す時刻（ms） */
  thinkAt: number;
  /** 走れる残り（秒）。走ると減り、歩く・止まると戻る */
  breath: number;
  /** 0〜1：度胸。高い人は牢屋へ助けに行く */
  nerve: number;
  /** 歩く速さ・走る速さ（m/s）。人によって違う */
  walk: number;
  sprint: number;
  /** いまの隠れ場所 */
  spot: LatLon | null;
  /** 前に考えたときの段階と、捕まっていたか（変わったらすぐ考え直す） */
  seenPhase: CrowdPhase | null;
  seenCaught: boolean;
}

/** まわりの1人。role が null は、役の分からない人（走って光った本物の人） */
export interface Other {
  pos: LatLon;
  role: RoleId | null;
  caught: boolean;
  lit: boolean;
}

export interface World {
  phase: CrowdPhase;
  /** 広場（集まる所） */
  home: LatLon;
  /** 牢屋（捕まった人が歩いていく所） */
  jail: LatLon;
  /** 隠れ場所を選ぶ半径（m） */
  reach: number;
  now: number;
  rng: () => number;
  /** 牢屋に誰かいる */
  anyJailed: boolean;
  /** この枠の外へは行かない（SFC のキャンパスなど）。無ければどこへでも行く */
  bounds?: Box;
}

export interface Box {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function inside(p: LatLon, b: Box): boolean {
  return p.lat <= b.north && p.lat >= b.south && p.lon <= b.east && p.lon >= b.west;
}

/** 枠の外の点を、枠のふちへ寄せる */
export function clampTo(p: LatLon, b: Box | undefined): LatLon {
  if (!b) return p;
  return { lat: Math.min(b.north, Math.max(b.south, p.lat)), lon: Math.min(b.east, Math.max(b.west, p.lon)) };
}

/** 走れる長さの上限（秒） */
export const BREATH_MAX = 25;
/** 鬼が逃走者を見つける距離・逃走者が鬼に気づく距離（m） */
export const SIGHT_ONI_M = 60;
export const SIGHT_RUNNER_M = 35;
/** 光った人に鬼が寄っていく距離（m） */
export const SIGHT_LIT_M = 250;
/** 触れたとみなす距離（m） */
export const TOUCH_M = 3;

export function newBot(home: LatLon, rng: () => number): Bot {
  return {
    pos: around(home, 10, rng),
    goal: null,
    pace: 'stay',
    act: 'mill',
    thinkAt: 0,
    breath: BREATH_MAX,
    nerve: rng(),
    walk: 1.1 + rng() * 0.5,
    sprint: 3.6 + rng() * 1.6,
    spot: null,
    seenPhase: null,
    seenCaught: false,
  };
}

/** p のまわり半径 r m の中の、ばらけた1点 */
export function around(p: LatLon, r: number, rng: () => number): LatLon {
  const a = rng() * Math.PI * 2;
  const d = Math.sqrt(rng()) * r;
  return offset(p, Math.cos(a) * d, Math.sin(a) * d);
}

/** 隠れ場所：広場から reach の 35〜100% 離れた所（枠があれば、その中から選ぶ） */
export function pickSpot(w: World): LatLon {
  let p = w.home;
  for (let i = 0; i < 8; i++) {
    const a = w.rng() * Math.PI * 2;
    const d = w.reach * (0.35 + w.rng() * 0.65);
    p = offset(w.home, Math.cos(a) * d, Math.sin(a) * d);
    if (!w.bounds || inside(p, w.bounds)) return p;
  }
  return clampTo(p, w.bounds);
}

function nearest(from: LatLon, others: readonly Other[], ok: (o: Other) => boolean): { o: Other; d: number } | null {
  let best: { o: Other; d: number } | null = null;
  for (const o of others) {
    if (!ok(o)) continue;
    const d = dist(from, o.pos);
    if (!best || d < best.d) best = { o, d };
  }
  return best;
}

function go(bot: Bot, goal: LatLon, pace: Pace, act: Act, thinkAt: number): void {
  bot.goal = goal;
  bot.pace = pace;
  bot.act = act;
  bot.thinkAt = thinkAt;
}

/** 次の行き先と速さを決める。考え直す時刻になるまでは何もしない（段階・捕まったが変わったらすぐ考え直す） */
export function think(bot: Bot, role: RoleId | null, caught: boolean, others: readonly Other[], w: World): void {
  const changed = bot.seenPhase !== w.phase || bot.seenCaught !== caught;
  if (bot.seenPhase !== w.phase && (w.phase === 'ready' || w.phase === 'idle')) bot.spot = null;
  bot.seenPhase = w.phase;
  bot.seenCaught = caught;
  const arrived = bot.goal !== null && dist(bot.pos, bot.goal) < 0.5;
  if (!changed && !arrived && w.now < bot.thinkAt) return;
  const { now, rng } = w;
  const canRun = bot.breath > 3;

  if (w.phase === 'wait' || w.phase === 'paused') return go(bot, bot.pos, 'stay', 'wait', now + 1_000);
  if (w.phase === 'idle' || w.phase === 'ready') return go(bot, around(w.home, 12, rng), 'walk', 'mill', now + 3_000 + rng() * 6_000);
  if (w.phase === 'return') return go(bot, around(w.home, 8, rng), 'walk', 'home', now + 8_000 + rng() * 8_000);
  if (role === null) return go(bot, around(w.home, 12, rng), 'walk', 'mill', now + 5_000);

  if (role === 'runner') {
    if (caught) {
      const atJail = dist(bot.pos, w.jail) < 4;
      return go(bot, atJail ? bot.pos : around(w.jail, 2.5, rng), atJail ? 'stay' : 'walk', 'jail', now + 2_000);
    }
    bot.spot ??= pickSpot(w);
    if (w.phase === 'escape') return go(bot, bot.spot, canRun ? 'run' : 'walk', 'flee', now + 2_000);
    const oni = nearest(bot.pos, others, (o) => o.role === 'oni');
    if (oni && oni.d < SIGHT_RUNNER_M) {
      const d = delta(oni.o.pos, bot.pos);
      const len = Math.hypot(d.east, d.north) || 1;
      const turn = (rng() - 0.5) * 0.9;
      const [e, n] = [d.east / len, d.north / len];
      const away = offset(bot.pos, (e * Math.cos(turn) - n * Math.sin(turn)) * 40, (e * Math.sin(turn) + n * Math.cos(turn)) * 40);
      bot.spot = null;
      return go(bot, clampTo(away, w.bounds), canRun ? 'run' : 'walk', 'flee', now + 1_500);
    }
    if (w.anyJailed && bot.nerve > 0.6) return go(bot, around(w.jail, 2, rng), 'walk', 'rescue', now + 3_000);
    if (dist(bot.pos, bot.spot) < 4) {
      if (rng() < 0.25) {
        bot.spot = pickSpot(w);
        return go(bot, bot.spot, 'walk', 'move', now + 10_000 + rng() * 30_000);
      }
      return go(bot, bot.pos, 'stay', 'hide', now + 10_000 + rng() * 30_000);
    }
    return go(bot, bot.spot, 'walk', 'move', now + 4_000);
  }

  // 鬼
  if (w.phase === 'escape') return go(bot, around(w.home, 6, rng), 'walk', 'wait', now + 4_000 + rng() * 4_000);
  const seen = nearest(bot.pos, others, (o) => o.role === 'runner' && !o.caught);
  const lit = nearest(bot.pos, others, (o) => o.lit && o.role !== 'oni' && !o.caught);
  const target = seen && seen.d < SIGHT_ONI_M ? seen : lit && lit.d < SIGHT_LIT_M ? lit : null;
  if (target) return go(bot, target.o.pos, canRun ? 'run' : 'walk', 'chase', now + 1_000);
  return go(bot, pickSpot(w), 'walk', 'patrol', now + 8_000 + rng() * 12_000);
}

/** dtSec だけ進める。進んだ速さ（m/s）を返す */
export function advance(bot: Bot, dtSec: number, speedMul = 1): number {
  const want = bot.pace === 'run' ? bot.sprint : bot.pace === 'walk' ? bot.walk * (bot.act === 'mill' ? 0.5 : 1) : 0;
  let speed = 0;
  if (bot.goal && want > 0) {
    const d = delta(bot.pos, bot.goal);
    const left = Math.hypot(d.east, d.north);
    const step = Math.min(left, want * speedMul * dtSec);
    if (left > 0.01) {
      bot.pos = offset(bot.pos, (d.east / left) * step, (d.north / left) * step);
      speed = dtSec > 0 ? step / (speedMul * dtSec) : 0;
    }
  }
  if (bot.pace === 'run' && speed > 0) bot.breath = Math.max(0, bot.breath - dtSec * speedMul);
  else bot.breath = Math.min(BREATH_MAX, bot.breath + dtSec * speedMul * 0.5);
  if (bot.pace === 'run' && bot.breath <= 0) bot.pace = 'walk';
  return speed;
}

/** 決まった種から、同じ並びの乱数を作る（テストと、開き直しても同じ人になるように） */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 偽の参加者の名前。本物の名簿と同じに見えるよう、長さも字の種類もばらばら（名簿では1人1つなので、全部ちがう名前）。
 * 足りなくなったら後ろに数字をつける
 */
export const CROWD_NAMES: readonly string[] = [
  'はると', 'ミナ', '蓮', 'Kai', 'そうた', 'ユイ', '陽菜', 'りく', 'アオイ', '大和', 'Mei', 'こはる', 'ソラ', '湊', 'ひまり',
  'レン太', '結衣', 'Leo', 'あかり', 'タクミ', '颯', 'みお', 'カナデ', '悠真', 'Noa', 'さくら', 'ハル', '樹', 'りん', 'ヒナタ',
  '朝陽', 'Emma', 'つむぎ', 'ショウ', '蒼', 'いちか', 'ダイチ', '陸斗', 'Ren', 'めい', 'ケンタ', '芽依', 'ゆうま', 'サキ', '律',
  'Luna', 'ほのか', 'リョウ', '凪', 'かえで', 'マサト', '紬', 'Jun', 'ことね', 'アヤ', '翔太', 'すず', 'トモヤ', '葵', 'Rio',
  'ななみ', 'コウキ', '楓', 'ゆづき', 'シュン', '咲良', 'Ken', 'みゆ', 'ナオキ', '怜', 'あやと', 'マイ', '陽向', 'Sho', 'ちひろ',
  'カズ', '詩', 'れいな', 'ユウト', '澪', 'Aki', 'のぞみ', 'タイガ', '杏', 'そら豆', 'リナ', '大翔', 'Yuki', 'かんな', 'ジン',
  '美月', 'てっぺい', 'エマ', '柊', 'Hana', 'ましろ', 'ゲンキ', '莉子', 'こうへい', 'ミク', '暖', 'Taro', 'ひかる', 'アキラ', '花',
  'りょうすけ', 'モモ', '新', 'Eito', 'ふうか', 'ヨシ', '心春', 'しんのすけ', 'ルイ', '晴', 'Momo', 'いつき', 'セナ', '彩葉', 'たいよう',
  'ニコ', '歩', 'Sena', 'わかな', 'テツ', '千尋', 'まさき', 'ララ', '仁', 'Toma', 'ゆきの', 'ハヤテ', '琴音', 'けいすけ', 'ミサキ',
  '岳', 'Nagi', 'あんな', 'ゴウ', '日和', 'しょうご', 'エリ', '空', 'Riku', 'みつき', 'ダン', '優奈', 'ともき', 'チカ', '匠',
];

export function crowdName(i: number, retry = 0): string {
  const base = CROWD_NAMES[i % CROWD_NAMES.length];
  const lap = Math.floor(i / CROWD_NAMES.length);
  return `${base}${lap > 0 ? lap + 1 : ''}${retry > 0 ? `_${retry + 1}` : ''}`;
}
