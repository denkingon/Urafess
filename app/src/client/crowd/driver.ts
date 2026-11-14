import {
  TOUCH_M,
  advance,
  around,
  crowdName,
  dist,
  newBot,
  offset,
  phaseOf,
  seeded,
  think,
  type Bot,
  type Box,
  type CrowdPhase,
  type LatLon,
  type Other,
  type World,
} from '../../shared/crowd';
import type { RoleId } from '../../shared/rules';
import { MATES_SEND_EVERY_MS, RUN_SEND_EVERY_MS, RUN_SPEED_MIN, RUN_START_MS, RUN_STOP_MS } from '../../shared/rules';
import { GameClient, type KeyValueStore, type WebSocketLike } from '../core/game-client';

/**
 * 偽の群衆をつなぐ係。1人につき本物のスマホと同じしくみ（GameClient）を1本持ち、shared/crowd.ts の動きに合わせて
 * 位置・走っている・長押しを本物と同じ形で送る。サーバーから見ると、ふつうの参加者と区別がつかない。
 *
 * - 位置：ゲームの段階の間、5秒ごと（本物と同じ）。走っている間は1秒ごとに「走っている」
 * - 捕獲：鬼と逃走者が TOUCH_M まで近づいたら、2人が同時に長押しする（音は鳴らせないので「同時に長押し」の道）
 * - 解放：度胸のある逃走者が牢屋の人に近づいたら、2人が同時に長押しする
 * - 本物の人：主催者の合言葉がこの端末にあれば、本物の人の位置と役も見える（鬼は追い、逃走者は逃げ、近づけば長押しで応える）
 * - 自動で回す：配役 → 開始 → 終わったらまた配役、をくり返す（主催者の合言葉が要る）
 */

export interface CrowdOptions {
  url: string;
  gameId: string;
  count: number;
  /** 広場の位置 */
  center: LatLon;
  /** 隠れ場所を選ぶ半径（m） */
  reach: number;
  createSocket: (url: string) => WebSocketLike;
  now: () => number;
  /** i 番目の人の合い鍵の置き場（開き直しても同じ人として戻るため） */
  storeFor: (i: number) => KeyValueStore;
  hostToken: string | null;
  seed?: number;
  /** この枠の外へは行かせない（SFC のキャンパス） */
  bounds?: Box;
}

export interface MemberView {
  name: string;
  role: RoleId | null;
  caught: boolean;
  lit: boolean;
  pos: LatLon;
  act: Bot['act'];
  ready: boolean;
}

export interface HumanView {
  name: string;
  role: RoleId | null;
  pos: LatLon;
  lit: boolean;
}

export interface CrowdSnapshot {
  phase: CrowdPhase;
  stage: string;
  round: number;
  ready: number;
  online: number;
  counts: { oni: number; runner: number; caught: number } | null;
  members: MemberView[];
  humans: HumanView[];
  /** 送ったメッセージの数（位置・走っている・長押し。時計合わせは入らない） */
  sent: number;
  captures: number;
  rescues: number;
  hostState: 'none' | 'connecting' | 'ok' | 'denied';
}

interface Member {
  i: number;
  name: string;
  retry: number;
  client: GameClient;
  bot: Bot;
  /** いまの入室の頼みを出した client の phase（同じ phase で2回頼まない） */
  askedPhase: string | null;
  speed: number;
  fastSince: number | null;
  slowSince: number | null;
  running: boolean;
  lastRunSend: number;
  lastPosSend: number;
  /** 長押しなどで手がふさがっている */
  busyUntil: number;
  senseSent: boolean;
  /** 本物の人に長押しで応えたのに記録されなかった回数と、本物の人を追うのをやめている時刻まで */
  misses: number;
  ignoreHumansUntil: number;
}

const AUTO_WAIT_MS = 6_000;
/** 本物の人が長押しで応えないとき、これだけ空振りしたら IGNORE_MS の間その人たちを追わない（広場に立っているだけの人に鬼が群がり続けないように） */
const MISSES_MAX = 2;
const IGNORE_MS = 30_000;
/** 1人の逃走者を同時に追う鬼の上限（これより多い分は、ほかを探す） */
const PACK_MAX = 2;
/** 位置の誤差（本物の GPS に似せる。m） */
const NOISE_M = 3;

export class Crowd {
  /** 動きの速さの倍率（見るために早回しにする） */
  speed = 1;
  /** 自動で回す */
  auto = false;
  /** 位置にゆらぎを入れる */
  noise = true;

  private members: Member[] = [];
  private host: GameClient | null = null;
  private queue: { at: number; fn: () => void }[] = [];
  private last = 0;
  private sent = 0;
  private captures = 0;
  private rescues = 0;
  private autoAt = 0;
  private autoStage = '';
  private readonly rng: () => number;
  private readonly home: LatLon;
  private readonly jail: LatLon;

  constructor(private readonly o: CrowdOptions) {
    this.rng = seeded(o.seed ?? 20261112);
    this.home = o.center;
    this.jail = offset(o.center, 18, -14);
  }

  start(): void {
    if (this.o.hostToken && !this.host) {
      this.host = new GameClient(
        { url: this.o.url, gameId: this.o.gameId, createSocket: this.o.createSocket, now: this.o.now, storage: memory() },
        { kind: 'host', token: this.o.hostToken },
      );
      this.host.start();
    }
    this.setCount(this.o.count);
    this.last = this.o.now();
  }

  /** 人数を変える。増やした分は入室し、減らした分は切る（名簿には残る） */
  setCount(n: number): void {
    while (this.members.length > n) this.members.pop()!.client.stop();
    while (this.members.length < n) {
      const i = this.members.length;
      const client = new GameClient(
        { url: this.o.url, gameId: this.o.gameId, createSocket: this.o.createSocket, now: this.o.now, storage: this.o.storeFor(i) },
        { kind: 'player' },
      );
      this.members.push({
        i,
        name: crowdName(i),
        retry: 0,
        client,
        bot: newBot(this.home, this.rng),
        askedPhase: null,
        speed: 0,
        fastSince: null,
        slowSince: null,
        running: false,
        lastRunSend: 0,
        lastPosSend: -i * 137,
        busyUntil: 0,
        senseSent: false,
        misses: 0,
        ignoreHumansUntil: 0,
      });
      // 一斉につながないよう少しずつ
      this.later(i * 60, () => client.start());
    }
  }

  stop(): void {
    for (const m of this.members) m.client.stop();
    this.members = [];
    this.host?.stop();
    this.host = null;
    this.queue = [];
  }

  private later(ms: number, fn: () => void): void {
    this.queue.push({ at: this.o.now() + ms, fn });
  }

  /** 1コマ進める。画面からは 250ms ごと、タブが裏にあるときは1秒ごとに呼ばれる（dt で進めるのでどちらでも同じ） */
  tick(): void {
    const now = this.o.now();
    const dt = Math.min(2, Math.max(0, (now - this.last) / 1000));
    this.last = now;

    const due = this.queue.filter((q) => q.at <= now);
    this.queue = this.queue.filter((q) => q.at > now);
    for (const q of due) q.fn();

    for (const m of this.members) this.enter(m);

    const ref = this.host?.state.game ? this.host : this.members.find((m) => m.client.state.game)?.client;
    const game = ref?.state.game ?? null;
    const serverNow = ref?.serverNow() ?? now;
    const phase = phaseOf(game, serverNow);
    this.runAuto(now, game?.stage ?? '', phase);

    const mine = new Set<number>();
    for (const m of this.members) {
      const num = m.client.state.me?.num;
      if (num !== undefined) mine.add(num);
    }
    const humans = this.humans(mine);
    const bodies: (Other & { m: Member | null })[] = [
      ...this.members.filter((m) => m.client.state.me).map((m) => ({ m, pos: m.bot.pos, role: roleOf(m), caught: isCaught(m), lit: m.running })),
      ...humans.map((h) => ({ m: null, pos: h.pos, role: h.role, caught: false, lit: h.lit })),
    ];
    const world: World = {
      phase,
      home: this.home,
      jail: this.jail,
      reach: this.o.reach,
      now,
      rng: this.rng,
      anyJailed: (game?.counts.caught ?? 0) > 0,
      bounds: this.o.bounds,
    };

    for (const m of this.members) {
      const me = m.client.state.me;
      if (!me) continue;
      if (!m.senseSent && m.client.state.phase === 'ready') {
        m.client.sense('ok', 'ok');
        m.senseSent = true;
      }
      if (now < m.busyUntil) {
        m.speed = 0;
      } else {
        think(m.bot, me.role, me.caught !== null, this.seenBy(m, bodies, now), world);
        m.speed = advance(m.bot, dt, this.speed);
      }
      this.report(m, now, phase);
    }
    if (phase === 'game') this.contacts(now, serverNow, humans);
  }

  /** この人から見えるまわりの人。鬼には、もう PACK_MAX 人の鬼が自分より近くで追っている逃走者と、追うのをやめている本物の人を見せない */
  private seenBy(m: Member, bodies: readonly (Other & { m: Member | null })[], now: number): Other[] {
    const others = bodies.filter((b) => b.m !== m);
    if (roleOf(m) !== 'oni') return others;
    const pack = bodies.filter((b) => b.m !== null && b.m !== m && b.role === 'oni' && b.m.bot.act === 'chase');
    return others.filter((b) => {
      if (b.role === 'oni') return true;
      if (b.m === null && now < m.ignoreHumansUntil) return false;
      const mine = dist(m.bot.pos, b.pos);
      return pack.filter((o) => o.m!.bot.goal !== null && dist(o.m!.bot.goal!, b.pos) < 5 && dist(o.pos, b.pos) < mine).length < PACK_MAX;
    });
  }

  /** 入室：名前を入れる → （名簿にいれば）名前のボタン → 入っている。名前がほかの人のものなら、後ろに印をつけて入り直す */
  private enter(m: Member): void {
    const phase = m.client.state.phase;
    if (phase === m.askedPhase) return;
    m.askedPhase = phase;
    if (phase === 'need-name') m.client.join(m.name);
    else if (phase === 'known') m.client.enter();
    else if (phase === 'taken') {
      m.retry += 1;
      m.name = crowdName(m.i, m.retry);
      m.client.backToName();
    }
  }

  /** 本物の人（この群衆ではない人）。主催者の合言葉があれば全員の位置と役、なければ光った人だけ */
  private humans(mine: Set<number>): HumanView[] {
    const src = this.host ?? this.members.find((m) => m.client.state.glow)?.client;
    const litNums = new Set((src?.state.glow?.runs ?? []).map((r) => r.num));
    const out: HumanView[] = [];
    const seen = new Set<number>();
    for (const p of this.host?.state.mates?.people ?? []) {
      if (mine.has(p.num)) continue;
      seen.add(p.num);
      out.push({ name: p.name, role: p.role ?? null, pos: { lat: p.lat, lon: p.lon }, lit: litNums.has(p.num) });
    }
    for (const r of src?.state.glow?.runs ?? []) {
      if (mine.has(r.num) || seen.has(r.num) || r.lat === null || r.lon === null) continue;
      out.push({ name: r.name, role: null, pos: { lat: r.lat, lon: r.lon }, lit: true });
    }
    return out;
  }

  /** 本物のスマホと同じ間隔で、位置と「走っている」を送る */
  private report(m: Member, now: number, phase: CrowdPhase): void {
    const fast = m.speed >= RUN_SPEED_MIN;
    if (fast) {
      m.fastSince ??= now;
      m.slowSince = null;
    } else {
      m.slowSince ??= now;
      m.fastSince = null;
    }
    const live = phase === 'game' && roleOf(m) !== null && !isCaught(m) && m.client.state.online;
    if (!live) {
      if (m.running) {
        m.running = false;
        m.client.run(false);
        this.sent++;
      }
      return;
    }
    if (!m.running && m.fastSince !== null && now - m.fastSince >= RUN_START_MS) m.running = true;
    if (m.running && m.slowSince !== null && now - m.slowSince >= RUN_STOP_MS) {
      m.running = false;
      m.client.run(false);
      this.sent++;
    }
    if (m.running && now - m.lastRunSend >= RUN_SEND_EVERY_MS) {
      m.lastRunSend = now;
      m.client.run(true, this.fix(m));
      this.sent++;
    }
    if (now - m.lastPosSend >= MATES_SEND_EVERY_MS) {
      m.lastPosSend = now;
      m.client.pos(this.fix(m));
      this.sent++;
    }
  }

  private fix(m: Member): { lat: number; lon: number; acc: number } {
    const p = this.noise ? around(m.bot.pos, NOISE_M, this.rng) : m.bot.pos;
    return { lat: round5(p.lat), lon: round5(p.lon), acc: this.noise ? 5 + this.rng() * 10 : 5 };
  }

  /** 触れる距離まで近づいた2人に、長押しをさせる */
  private contacts(now: number, serverNow: number, humans: HumanView[]): void {
    const free = (m: Member) => now >= m.busyUntil && m.client.state.me !== null;
    const oni = this.members.filter((m) => roleOf(m) === 'oni' && free(m));
    const runners = this.members.filter((m) => roleOf(m) === 'runner' && free(m));
    const loose = runners.filter((m) => !isCaught(m) && (m.client.state.me?.freeUntil ?? 0) <= serverNow);
    const jailed = runners.filter(isCaught);

    // 偽の鬼 × 偽の逃走者
    for (const o of oni) {
      const r = loose.find((x) => now >= x.busyUntil && dist(o.bot.pos, x.bot.pos) <= TOUCH_M);
      if (!r || now < o.busyUntil) continue;
      this.hold([o, r], 2_000, now);
      this.captures++;
      const oniPid = o.client.state.me?.pid;
      // 候補が並んだまま（鬼が2人いた等）なら、捕まえた鬼を選ぶ
      this.later(3_500, () => {
        const me = r.client.state.me;
        if (oniPid && me?.claim && !me.caught) r.client.answer(oniPid);
      });
    }
    // 偽の助ける人 × 偽の牢屋の人
    for (const j of jailed) {
      const h = loose.find((x) => x.bot.act === 'rescue' && now >= x.busyUntil && dist(j.bot.pos, x.bot.pos) <= TOUCH_M);
      if (!h || now < j.busyUntil) continue;
      this.rescue([j, h], 2_000, now);
      this.rescues++;
    }
    // 本物の人が触れる距離にいたら、偽の人は長押しで応える（本物の人も同時に長押しすれば記録される）
    const near = (m: Member, role: RoleId | null) => humans.some((h) => (h.role === role || (role === 'runner' && h.role === null)) && dist(m.bot.pos, h.pos) <= TOUCH_M + 2);
    for (const o of oni) {
      if (now < o.busyUntil || now < o.ignoreHumansUntil || !near(o, 'runner')) continue;
      this.hold([o], 3_000, now, 5_000);
      const before = o.client.state.me?.catches ?? 0;
      this.later(7_000, () => {
        if ((o.client.state.me?.catches ?? 0) > before) return void (o.misses = 0);
        o.misses += 1;
        if (o.misses >= MISSES_MAX) {
          o.misses = 0;
          o.ignoreHumansUntil = this.o.now() + IGNORE_MS;
        }
      });
    }
    for (const r of loose) {
      if (now < r.busyUntil) continue;
      if (near(r, 'oni')) {
        this.hold([r], 3_000, now, 5_000);
        // 誰も重ならなかったら取り下げる（本物の鬼が押せば、候補から選ぶ）
        this.later(6_000, () => {
          const me = r.client.state.me;
          if (!me?.claim || me.caught) return;
          if (me.claim.cands.length > 0) r.client.answer(me.claim.cands[0].pid);
          else r.client.cancelClaim();
        });
      }
    }
    for (const j of jailed) if (now >= j.busyUntil && near(j, 'runner')) this.rescue([j], 3_000, now, 5_000);
    // 本物の人が牢屋にいる（主催者の集計で分かる）：度胸のある偽の人が牢屋に着いたら、長押しして待つ
    const humanJailed = (this.host?.state.host?.capture?.runners ?? []).some((r) => r.caught && !this.members.some((m) => m.client.state.me?.pid === r.pid));
    if (humanJailed) for (const r of loose) if (now >= r.busyUntil && r.bot.act === 'rescue' && dist(r.bot.pos, this.jail) <= TOUCH_M + 2) this.rescue([r], 3_000, now, 5_000);
  }

  /** 本物のスマホと同じ順で長押しを送る：指を置く → 0.5秒後に「押し始めた」→ 離す */
  private hold(who: Member[], ms: number, now: number, rest = 2_000): void {
    for (const m of who) {
      m.busyUntil = now + ms + rest;
      this.later(500, () => (m.client.holdStart(now), this.sent++));
      this.later(ms, () => (m.client.holdEnd(this.o.now()), this.sent++));
    }
  }

  private rescue(who: Member[], ms: number, now: number, rest = 3_500): void {
    for (const m of who) {
      m.busyUntil = now + ms + rest;
      this.later(500, () => (m.client.rescueStart(now), this.sent++));
      this.later(ms, () => (m.client.rescueEnd(this.o.now()), this.sent++));
    }
  }

  /** 自動で回す：配役 → 開始 →（時間が終わったら）また配役 */
  private runAuto(now: number, stage: string, phase: CrowdPhase): void {
    const host = this.host;
    if (!this.auto || !host || host.state.phase !== 'ready' || !host.state.game) return;
    const game = host.state.game;
    const done = stage === 'timer' && phase === 'return' && game.timer !== null && isDone(game.timer, host.serverNow() ?? now);
    const key = `${stage}:${game.assignId}:${done}`;
    if (key !== this.autoStage) {
      this.autoStage = key;
      this.autoAt = now + AUTO_WAIT_MS;
      return;
    }
    if (now < this.autoAt) return;
    this.autoAt = now + AUTO_WAIT_MS;
    const ready = this.members.filter((m) => m.client.state.phase === 'ready').length;
    if (stage === 'lobby' || stage === 'result' || stage === 'ended' || done) {
      if (ready >= Math.min(2, this.members.length)) host.command('assign');
    } else if (stage === 'assigned') host.command('start');
  }

  /** 段階の長さを変える（配役の前・配役済み・結果のときだけ効く） */
  setDurations(ms: number[]): boolean {
    return this.host?.command('durations', { durations: ms }) ?? false;
  }

  snapshot(): CrowdSnapshot {
    const mine = new Set<number>();
    for (const m of this.members) {
      const num = m.client.state.me?.num;
      if (num !== undefined) mine.add(num);
    }
    const ref = this.host?.state.game ? this.host : this.members.find((m) => m.client.state.game)?.client;
    const game = ref?.state.game ?? null;
    const hp = this.host?.state.phase;
    return {
      phase: phaseOf(game, ref?.serverNow() ?? this.o.now()),
      stage: game?.stage ?? '',
      round: game?.round ?? 0,
      ready: this.members.filter((m) => m.client.state.phase === 'ready').length,
      online: this.members.filter((m) => m.client.state.online).length,
      counts: game ? { oni: game.counts.oni, runner: game.counts.runner, caught: game.counts.caught } : null,
      members: this.members.map((m) => ({
        name: m.client.state.me?.name ?? m.name,
        role: roleOf(m),
        caught: isCaught(m),
        lit: m.running,
        pos: m.bot.pos,
        act: m.bot.act,
        ready: m.client.state.phase === 'ready',
      })),
      humans: this.humans(mine),
      sent: this.sent,
      captures: this.captures,
      rescues: this.rescues,
      hostState: !this.host ? 'none' : hp === 'ready' ? 'ok' : hp === 'denied' ? 'denied' : 'connecting',
    };
  }

  get center(): LatLon {
    return this.home;
  }

  get jailAt(): LatLon {
    return this.jail;
  }
}

const roleOf = (m: Member): RoleId | null => m.client.state.me?.role ?? null;
const isCaught = (m: Member): boolean => (m.client.state.me?.caught ?? null) !== null;
const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

function isDone(timer: { t0: number; floorElapsed: number; durations: number[]; status: string; pausedElapsed: number }, serverNow: number): boolean {
  if (timer.status !== 'running') return false;
  const elapsed = Math.max(serverNow - timer.t0, timer.floorElapsed);
  return elapsed >= timer.durations.reduce((a, b) => a + b, 0);
}

function memory(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}
