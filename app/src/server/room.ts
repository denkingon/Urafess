import { DurableObject } from 'cloudflare:workers';
import { assignRoles } from '../shared/allocate';
import type { ClientMsg, GameView, HostOp, HostSummary, MeView, ServerMsg, Stage, Winner } from '../shared/protocol';
import {
  DEFAULT_DURATIONS_MS,
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  NAME_MAX_LENGTH,
  PHASES,
  ROLES,
  SYNC_OK_MS,
  type RoleId,
} from '../shared/rules';
import { isDone, pauseTimer, resumeTimer, startTimer, type Timer } from '../shared/schedule';
import type { ProbeHub } from './probe';

export interface Env {
  GAME: DurableObjectNamespace<GameRoom>;
  /** 夜テストの記録（テスト回ごとに1つ） */
  PROBE: DurableObjectNamespace<ProbeHub>;
  ASSETS: Fetcher;
  /** 主催者用の合言葉。`wrangler secret put HOST_TOKEN` で入れる */
  HOST_TOKEN?: string;
}

interface GameState {
  gameId: string;
  round: number;
  assignId: number;
  stage: Stage;
  cv: number;
  timer: Timer | null;
  result: Winner | null;
  durations: number[];
  nextNum: number;
  counts: { oni: number; runner: number };
}

interface Participant {
  pid: string;
  key: string;
  num: number;
  name: string;
  role: RoleId | null;
  assignId: number;
  ackId: number;
  removed: boolean;
  joinedAt: number;
}

/** WebSocket ごとに持つ情報。休止（hibernation）をまたいでも残る */
interface Attachment {
  pid?: string;
  host?: boolean;
  /** 本人が報告した時計の誤差（往復の半分, ms） */
  syncErr?: number;
}

type ParticipantRow = {
  pid: string;
  key: string;
  num: number;
  name: string;
  role: string | null;
  assign_id: number;
  ack_id: number;
  removed: number;
  joined_at: number;
};

const LOBBY_BROADCAST_MS = 300;
const HOST_UPDATE_MS = 500;

/**
 * 1ゲーム＝1つの Durable Object。正解はここにしかない。
 * - 操作は1つずつ順番に処理される（Durable Object は同時に1つしか動かない）
 * - 状態は SQLite に保存してから配る
 * - つながるたびに「今の全部」を送る
 */
export class GameRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private game!: GameState;
  private readonly people = new Map<string, Participant>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.load();
    });
  }

  // ---------- 保存 ----------

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS participants (
        pid TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        num INTEGER NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        assign_id INTEGER NOT NULL DEFAULT 0,
        ack_id INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL
      )`,
    );
  }

  private load(): void {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'game'`).toArray()[0];
    this.game = row
      ? (JSON.parse(row.v) as GameState)
      : {
          gameId: '',
          round: 0,
          assignId: 0,
          stage: 'lobby',
          cv: 0,
          timer: null,
          result: null,
          durations: [...DEFAULT_DURATIONS_MS],
          nextNum: 1,
          counts: { oni: 0, runner: 0 },
        };
    this.people.clear();
    for (const r of this.sql.exec<ParticipantRow>(`SELECT * FROM participants`)) {
      this.people.set(r.pid, {
        pid: r.pid,
        key: r.key,
        num: r.num,
        name: r.name,
        role: (r.role as RoleId | null) ?? null,
        assignId: r.assign_id,
        ackId: r.ack_id,
        removed: r.removed === 1,
        joinedAt: r.joined_at,
      });
    }
  }

  private saveGame(): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(this.game),
    );
  }

  // ---------- 入口 ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/game\/([A-Za-z0-9_-]{1,40})\/(ws|debug)$/);
    if (!m) return new Response('not found', { status: 404 });
    if (!this.game.gameId) {
      this.game.gameId = m[1];
      this.saveGame();
    }

    if (m[2] === 'debug') {
      // 主催者の合言葉があるときだけ、全員の役を含む中身を返す（テストと確認用）
      if (!this.isHostToken(request.headers.get('x-host-token'))) return new Response('forbidden', { status: 403 });
      return Response.json({
        now: Date.now(),
        game: this.game,
        people: [...this.people.values()].map(({ key: _key, ...rest }) => rest),
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? {};
    switch (msg.t) {
      case 'ping':
        // 時計合わせ：受け取った瞬間のサーバー時刻を返す
        this.send(ws, { t: 'pong', id: Number(msg.id), a: Number(msg.a), s: now });
        return;
      case 'join':
        this.onJoin(ws, att, msg.name, now);
        return;
      case 'resume':
        this.onResume(ws, att, msg.pid, msg.key);
        return;
      case 'host':
        this.onHost(ws, att, msg.token);
        return;
      case 'ack':
        this.onAck(att, Number(msg.assignId));
        return;
      case 'sync': {
        const err = Number(msg.err);
        if (Number.isFinite(err) && err >= 0) {
          att.syncErr = err;
          ws.serializeAttachment(att);
          this.scheduleHostUpdate();
        }
        return;
      }
      case 'cmd':
        this.onCmd(ws, att, msg, now);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.scheduleHostUpdate();
    try {
      ws.close(code, reason);
    } catch {
      // すでに閉じている
    }
  }

  async webSocketError(): Promise<void> {
    this.scheduleHostUpdate();
  }

  // ---------- 参加者 ----------

  private onJoin(ws: WebSocket, att: Attachment, rawName: unknown, now: number): void {
    const name = normalizeName(rawName);
    if (!name) {
      this.send(ws, { t: 'unknown' });
      return;
    }
    const p: Participant = {
      pid: crypto.randomUUID(),
      key: randomKey(),
      num: this.game.nextNum,
      name,
      role: null,
      assignId: 0,
      ackId: 0,
      removed: false,
      joinedAt: now,
    };
    this.game.nextNum += 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO participants (pid, key, num, name, role, assign_id, ack_id, removed, joined_at) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, ?)`,
        p.pid,
        p.key,
        p.num,
        p.name,
        p.joinedAt,
      );
      this.saveGame();
    });
    this.people.set(p.pid, p);
    att.pid = p.pid;
    att.host = false;
    ws.serializeAttachment(att);
    this.send(ws, { t: 'welcome', pid: p.pid, key: p.key, num: p.num, name: p.name });
    this.sendSnap(ws, att);
    this.scheduleBroadcast();
  }

  private onResume(ws: WebSocket, att: Attachment, pid: unknown, key: unknown): void {
    const p = typeof pid === 'string' ? this.people.get(pid) : undefined;
    if (!p || p.key !== key) {
      this.send(ws, { t: 'unknown' });
      return;
    }
    att.pid = p.pid;
    att.host = false;
    ws.serializeAttachment(att);
    this.sendSnap(ws, att);
    this.scheduleHostUpdate();
  }

  private onAck(att: Attachment, assignId: number): void {
    if (!att.pid) return;
    const p = this.people.get(att.pid);
    if (!p || assignId !== this.game.assignId || p.assignId !== assignId || p.ackId === assignId) return;
    p.ackId = assignId;
    this.sql.exec(`UPDATE participants SET ack_id = ? WHERE pid = ?`, assignId, p.pid);
    this.scheduleHostUpdate();
  }

  // ---------- 主催者 ----------

  private isHostToken(token: unknown): boolean {
    const expected = this.env.HOST_TOKEN;
    return typeof expected === 'string' && expected.length > 0 && token === expected;
  }

  private onHost(ws: WebSocket, att: Attachment, token: unknown): void {
    if (!this.isHostToken(token)) {
      this.send(ws, { t: 'denied' });
      return;
    }
    att.host = true;
    delete att.pid;
    ws.serializeAttachment(att);
    this.sendSnap(ws, att);
  }

  private reject(ws: WebSocket, att: Attachment, op: HostOp, reason: string): void {
    this.send(ws, { t: 'reject', op, reason, cv: this.game.cv });
    this.sendSnap(ws, att);
  }

  private onCmd(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: 'cmd' }>, now: number): void {
    const op = msg.op;
    if (!att.host) {
      this.send(ws, { t: 'denied' });
      return;
    }

    // 人を外す操作は、ほかの主催者の操作とぶつからないので版番号を見ない
    if (op === 'remove') {
      const p = typeof msg.pid === 'string' ? this.people.get(msg.pid) : undefined;
      if (!p) return this.reject(ws, att, op, 'not-found');
      p.removed = true;
      this.sql.exec(`UPDATE participants SET removed = 1 WHERE pid = ?`, p.pid);
      this.broadcastNow();
      return;
    }

    // 古い画面からの操作（同時押し・二度押し）は断って、今の状態を送り直す
    if (msg.cv !== this.game.cv) return this.reject(ws, att, op, 'stale');

    const g = this.game;
    const timerDone = g.stage === 'timer' && g.timer !== null && isDone(g.timer, now);

    switch (op) {
      case 'assign': {
        if (!(g.stage === 'lobby' || g.stage === 'assigned' || g.stage === 'result' || timerDone)) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const active = [...this.people.values()].filter((p) => !p.removed);
        if (active.length === 0) return this.reject(ws, att, op, 'no-participants');
        const roles = assignRoles(
          active.map((p) => p.pid),
          ROLES,
        );
        const isReroll = g.stage === 'assigned';
        const nextRound = isReroll ? Math.max(g.round, 1) : g.round + 1;
        const nextAssignId = g.assignId + 1;
        let oni = 0;
        let runner = 0;
        for (const r of roles.values()) r === 'oni' ? oni++ : runner++;
        const next: GameState = {
          ...g,
          round: nextRound,
          assignId: nextAssignId,
          stage: 'assigned',
          cv: g.cv + 1,
          timer: null,
          result: null,
          counts: { oni, runner },
        };
        this.ctx.storage.transactionSync(() => {
          for (const [pid, role] of roles) {
            this.sql.exec(`UPDATE participants SET role = ?, assign_id = ?, ack_id = 0 WHERE pid = ?`, role, nextAssignId, pid);
          }
          this.sql.exec(
            `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            JSON.stringify(next),
          );
        });
        for (const [pid, role] of roles) {
          const p = this.people.get(pid)!;
          p.role = role;
          p.assignId = nextAssignId;
          p.ackId = 0;
        }
        this.game = next;
        break;
      }
      case 'start':
        if (g.stage !== 'assigned') return this.reject(ws, att, op, 'not-allowed');
        this.commit({ stage: 'timer', timer: startTimer(g.durations, now), result: null });
        break;
      case 'pause':
        if (g.stage !== 'timer' || !g.timer || g.timer.status !== 'running' || timerDone) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        this.commit({ timer: pauseTimer(g.timer, now) });
        break;
      case 'resume':
        if (g.stage !== 'timer' || !g.timer || g.timer.status !== 'paused') return this.reject(ws, att, op, 'not-allowed');
        this.commit({ timer: resumeTimer(g.timer, now) });
        break;
      case 'reset':
        if (g.stage !== 'timer') return this.reject(ws, att, op, 'not-allowed');
        this.commit({ stage: 'assigned', timer: null });
        break;
      case 'result': {
        if (msg.winner !== 'oni' && msg.winner !== 'runner') return this.reject(ws, att, op, 'bad-input');
        if (!(g.stage === 'result' || timerDone)) return this.reject(ws, att, op, 'not-allowed');
        this.commit({ stage: 'result', result: msg.winner });
        break;
      }
      case 'durations': {
        if (!(g.stage === 'lobby' || g.stage === 'assigned' || g.stage === 'result')) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const d = msg.durations;
        const ok =
          Array.isArray(d) &&
          d.length === PHASES.length &&
          d.every((x) => Number.isInteger(x) && x >= DURATION_MIN_MS && x <= DURATION_MAX_MS);
        if (!ok) return this.reject(ws, att, op, 'bad-input');
        this.commit({ durations: [...d] });
        break;
      }
      default:
        return this.reject(ws, att, op, 'bad-input');
    }
    this.broadcastNow();
  }

  /** 状態を変えて保存する（版番号を1つ進める） */
  private commit(patch: Partial<GameState>): void {
    this.game = { ...this.game, ...patch, cv: this.game.cv + 1 };
    this.saveGame();
  }

  // ---------- 配る ----------

  private activePeople(): Participant[] {
    return [...this.people.values()].filter((p) => !p.removed);
  }

  private gameView(): GameView {
    const g = this.game;
    return {
      gameId: g.gameId,
      round: g.round,
      assignId: g.assignId,
      stage: g.stage,
      cv: g.cv,
      timer: g.timer,
      counts: { oni: g.counts.oni, runner: g.counts.runner, total: this.activePeople().length },
      result: g.result,
      durations: g.durations,
    };
  }

  private meView(pid: string): MeView | undefined {
    const p = this.people.get(pid);
    if (!p) return undefined;
    const inCurrent = p.assignId === this.game.assignId && this.game.assignId > 0;
    return {
      pid: p.pid,
      num: p.num,
      name: p.name,
      role: inCurrent && !p.removed ? p.role : null,
      assignId: inCurrent ? p.assignId : 0,
      removed: p.removed,
    };
  }

  private hostSummary(): HostSummary {
    const active = this.activePeople();
    const connected = new Set<string>();
    const synced = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.pid) continue;
      connected.add(a.pid);
      if (typeof a.syncErr === 'number' && a.syncErr <= SYNC_OK_MS) synced.add(a.pid);
    }
    const g = this.game;
    const inAssign = g.assignId > 0 ? active.filter((p) => p.assignId === g.assignId && p.role !== null) : [];
    const groups = new Map<string, Participant[]>();
    for (const p of active) {
      const k = p.name.toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    return {
      total: active.length,
      connected: active.filter((p) => connected.has(p.pid)).length,
      assigned: inAssign.length,
      received: inAssign.filter((p) => p.ackId === g.assignId).length,
      synced: active.filter((p) => synced.has(p.pid)).length,
      waiting: g.stage === 'lobby' ? 0 : active.length - inAssign.length,
      dupNames: [...groups.values()]
        .filter((ps) => ps.length > 1)
        .map((ps) => ({ name: ps[0].name, people: ps.map((p) => ({ pid: p.pid, num: p.num })) })),
    };
  }

  private snapFor(att: Attachment, game: GameView, host: HostSummary | null): ServerMsg {
    return {
      t: 'snap',
      now: Date.now(),
      game,
      me: att.pid ? this.meView(att.pid) : undefined,
      host: att.host && host ? host : undefined,
    };
  }

  private sendSnap(ws: WebSocket, att: Attachment): void {
    this.send(ws, this.snapFor(att, this.gameView(), att.host ? this.hostSummary() : null));
  }

  /** 全員に今の全部を送る。本人の役は本人の接続にだけ入る */
  private broadcastNow(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.hostTimer) {
      clearTimeout(this.hostTimer);
      this.hostTimer = null;
    }
    const game = this.gameView();
    const host = this.hostSummary();
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() as Attachment | null) ?? {};
      if (!att.pid && !att.host) continue;
      this.send(ws, this.snapFor(att, game, host));
    }
  }

  /** 入室が続くときの人数表示はまとめて送る */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, LOBBY_BROADCAST_MS);
  }

  /** 受け取り・時計合わせ・接続の数は主催者にだけ、まとめて送る */
  private scheduleHostUpdate(): void {
    if (this.hostTimer || this.broadcastTimer) return;
    this.hostTimer = setTimeout(() => {
      this.hostTimer = null;
      const game = this.gameView();
      const host = this.hostSummary();
      for (const ws of this.ctx.getWebSockets()) {
        const att = (ws.deserializeAttachment() as Attachment | null) ?? {};
        if (att.host) this.send(ws, this.snapFor(att, game, host));
      }
    }, HOST_UPDATE_MS);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 閉じかけの接続は、つなぎ直したときに全部を送り直すので捨ててよい
    }
  }
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX_LENGTH) return null;
  return name;
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
