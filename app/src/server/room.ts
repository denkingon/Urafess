import { DurableObject } from 'cloudflare:workers';
import { assignRoles } from '../shared/allocate';
import { captureOpenAt, pickCodes, rankCandidates, viaOf, type Candidate, type CaptureVia, type Hold, type OniSignal } from '../shared/capture';
import type {
  ClientMsg,
  GameView,
  HostCapture,
  HostOp,
  HostSummary,
  MeView,
  NoticeKind,
  RosterEntry,
  ServerMsg,
  Stage,
  Winner,
} from '../shared/protocol';
import {
  CLAIM_GRACE_MS,
  CLAIM_OPEN_MS,
  CLAIM_PAIR_WINDOW_MS,
  DEFAULT_DURATIONS_MS,
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  EVIDENCE_VALID_MS,
  HEARTBEAT_EVERY_MS,
  HOLD_MAX_MS,
  HOLD_UNKNOWN_END_MS,
  NAME_MAX_LENGTH,
  PHASES,
  ROLES,
  SYNC_OK_MS,
  type RoleId,
} from '../shared/rules';
import { elapsedAt, isDone, pauseTimer, positionAt, resumeTimer, skipPhase, startTimer, type Timer } from '../shared/schedule';
import { eventsToCsv, type EventRow } from './log';
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
  /** その回の3桁（逃走者のスマホが音で鳴らす）。配役のたびに変わる */
  code: string | null;
  /** 捕まった配役の番号（0＝捕まっていない）。配役が変われば自然に外れる */
  caughtAssign: number;
  caughtBy: string | null;
  caughtAt: number | null;
  caughtVia: CaptureVia | null;
  /** 最後に入室・復帰したときの端末（ブラウザの User-Agent）。機種ごとの失敗を後から見るため */
  ua: string | null;
}

/** 逃走者の「捕まった」。最初に長押しを始めた（または鬼に手動で選ばれた）ときに開き、本人が選ぶまで開いている */
interface Claim {
  pid: string;
  assignId: number;
  /** 開いたサーバー時刻 */
  at: number;
}

/** 長押し1回（鬼も逃走者も） */
interface HoldRec extends Hold {
  id: number;
  assignId: number;
}

/** 逃走者と鬼の組の手がかり：鬼のスマホが音を拾った・鬼が手動で選んだ */
interface Evidence {
  assignId: number;
  heardAt: number | null;
  nominatedAt: number | null;
}

/** WebSocket ごとに持つ情報。休止（hibernation）をまたいでも残る */
interface Attachment {
  pid?: string;
  host?: boolean;
  /** 本人が報告した時計の誤差（往復の半分, ms） */
  syncErr?: number;
  /** つないだ端末の User-Agent */
  ua?: string;
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
  code: string | null;
  caught_assign: number;
  caught_by: string | null;
  caught_at: number | null;
  caught_via: string | null;
  ua: string | null;
};

const LOBBY_BROADCAST_MS = 300;
const HOST_UPDATE_MS = 500;
/** 押した時刻として受け付けるのは、届いた時刻からこれだけ前まで（電波の詰まり・つなぎ直しの送り直しで遅れて届く分） */
const PRESS_MAX_DELAY_MS = 60_000;
/** 同じ鬼が同じ音を何度も聞き取ったとき、記録し直すまでの間隔（逃走者のスマホは繰り返し鳴らす） */
const HEARD_DEDUPE_MS = 5_000;
/** 押している途中に届いた「押し始め」が、前の押し始めとこれだけしか違わなければ、つなぎ直しの送り直し（同じ長押し） */
const HOLD_SAME_MS = 1_000;

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
  private readonly claims = new Map<string, Claim>();
  /** 人 → 最近の長押し（古い順） */
  private readonly holds = new Map<string, HoldRec[]>();
  /** 逃走者 → （鬼 → 手がかり） */
  private readonly evidence = new Map<string, Map<string, Evidence>>();
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
    // 捕獲の記録を入れたときに足した列（すでにある部屋には後から足す）
    const have = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(participants)`).toArray().map((r) => r.name));
    const columns: [string, string][] = [
      ['code', 'code TEXT'],
      ['caught_assign', 'caught_assign INTEGER NOT NULL DEFAULT 0'],
      ['caught_by', 'caught_by TEXT'],
      ['caught_at', 'caught_at INTEGER'],
      ['caught_via', 'caught_via TEXT'],
      ['ua', 'ua TEXT'],
    ];
    for (const [name, ddl] of columns) {
      if (!have.has(name)) this.sql.exec(`ALTER TABLE participants ADD COLUMN ${ddl}`);
    }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS claims (
        pid TEXT PRIMARY KEY,
        assign_id INTEGER NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid TEXT NOT NULL,
        assign_id INTEGER NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS evidence (
        runner TEXT NOT NULL,
        oni TEXT NOT NULL,
        assign_id INTEGER NOT NULL,
        heard_at INTEGER,
        nominated_at INTEGER,
        PRIMARY KEY (runner, oni)
      )`,
    );
    // 1イベント＝1行。部屋を空にしても消さない（あとで人数比や流れを統計で見るため）
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        round INTEGER NOT NULL,
        assign_id INTEGER NOT NULL,
        phase INTEGER,
        elapsed INTEGER,
        kind TEXT NOT NULL,
        pid TEXT,
        num INTEGER,
        name TEXT,
        other_pid TEXT,
        other_num INTEGER,
        other_name TEXT,
        via TEXT,
        data TEXT
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
        code: r.code ?? null,
        caughtAssign: r.caught_assign ?? 0,
        caughtBy: r.caught_by ?? null,
        caughtAt: r.caught_at ?? null,
        caughtVia: (r.caught_via as CaptureVia | null) ?? null,
        ua: r.ua ?? null,
      });
    }
    // 捕獲を入れる前の版で配役した部屋（公開の瞬間に試合中だった等）は、3桁が無い。ここで配る
    if (this.game.assignId > 0) {
      const missing = [...this.people.values()].filter((p) => !p.removed && p.assignId === this.game.assignId && p.role && !p.code);
      if (missing.length) {
        const used = new Set([...this.people.values()].map((p) => p.code));
        const pool = pickCodes(900).filter((c) => !used.has(c));
        missing.forEach((p, i) => {
          p.code = pool[i] ?? null;
          this.sql.exec(`UPDATE participants SET code = ? WHERE pid = ?`, p.code, p.pid);
        });
      }
    }
    this.claims.clear();
    for (const r of this.sql.exec<{ pid: string; assign_id: number; at: number }>(`SELECT * FROM claims`)) {
      this.claims.set(r.pid, { pid: r.pid, assignId: r.assign_id, at: r.at });
    }
    this.holds.clear();
    for (const r of this.sql.exec<{ id: number; pid: string; assign_id: number; start: number; end: number | null }>(
      `SELECT * FROM holds ORDER BY id`,
    )) {
      const list = this.holds.get(r.pid) ?? [];
      list.push({ id: r.id, assignId: r.assign_id, start: r.start, end: r.end ?? null });
      this.holds.set(r.pid, list);
    }
    this.evidence.clear();
    for (const r of this.sql.exec<{ runner: string; oni: string; assign_id: number; heard_at: number | null; nominated_at: number | null }>(
      `SELECT * FROM evidence`,
    )) {
      let m = this.evidence.get(r.runner);
      if (!m) this.evidence.set(r.runner, (m = new Map()));
      m.set(r.oni, { assignId: r.assign_id, heardAt: r.heard_at ?? null, nominatedAt: r.nominated_at ?? null });
    }
  }

  private saveGame(): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(this.game),
    );
  }

  private saveClaim(c: Claim): void {
    this.sql.exec(
      `INSERT INTO claims (pid, assign_id, at) VALUES (?, ?, ?)
       ON CONFLICT(pid) DO UPDATE SET assign_id = excluded.assign_id, at = excluded.at`,
      c.pid,
      c.assignId,
      c.at,
    );
  }

  private saveEvidence(runner: string, oni: string, ev: Evidence): void {
    this.sql.exec(
      `INSERT INTO evidence (runner, oni, assign_id, heard_at, nominated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(runner, oni) DO UPDATE SET assign_id = excluded.assign_id, heard_at = excluded.heard_at, nominated_at = excluded.nominated_at`,
      runner,
      oni,
      ev.assignId,
      ev.heardAt,
      ev.nominatedAt,
    );
  }

  /** 配役が変わる・やり直すときに、押した記録と手がかりを全部消す（ログには残る） */
  private dropClaims(): void {
    this.sql.exec(`DELETE FROM claims`);
    this.sql.exec(`DELETE FROM holds`);
    this.sql.exec(`DELETE FROM evidence`);
    this.claims.clear();
    this.holds.clear();
    this.evidence.clear();
  }

  // ---------- 記録（1イベント＝1行） ----------

  private log(
    kind: string,
    e: { p?: Participant | null; other?: Participant | null; via?: string | null; data?: Record<string, unknown>; at?: number } = {},
  ): void {
    const at = e.at ?? Date.now();
    const g = this.game;
    let phase: number | null = null;
    let elapsed: number | null = null;
    if (g.stage === 'timer' && g.timer) {
      const pos = positionAt(g.timer, at);
      phase = pos.kind === 'phase' ? pos.index : PHASES.length;
      elapsed = Math.round(elapsedAt(g.timer, at));
    }
    this.sql.exec(
      `INSERT INTO events (at, round, assign_id, phase, elapsed, kind, pid, num, name, other_pid, other_num, other_name, via, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      at,
      g.round,
      g.assignId,
      phase,
      elapsed,
      kind,
      e.p?.pid ?? null,
      e.p?.num ?? null,
      e.p?.name ?? null,
      e.other?.pid ?? null,
      e.other?.num ?? null,
      e.other?.name ?? null,
      e.via ?? null,
      e.data ? JSON.stringify(e.data) : null,
    );
  }

  // ---------- 入口 ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/game\/([A-Za-z0-9_-]{1,40})\/(ws|debug|log)$/);
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
        claims: [...this.claims.values()],
        holds: Object.fromEntries(this.holds),
        evidence: [...this.evidence.entries()].map(([runner, m2]) => ({ runner, oni: [...m2.entries()].map(([oni, e]) => ({ oni, ...e })) })),
      });
    }

    if (m[2] === 'log') {
      // 主催者の合言葉があるときだけ、全部の記録を CSV（Excel で開ける）か JSON で返す
      if (!this.isHostToken(request.headers.get('x-host-token') ?? url.searchParams.get('token'))) {
        return new Response('forbidden', { status: 403 });
      }
      const rows = this.sql.exec<EventRow>(`SELECT * FROM events ORDER BY id`).toArray();
      if (url.searchParams.get('format') === 'json') return Response.json(rows);
      return new Response(eventsToCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="urafess-${this.game.gameId}-log.csv"`,
          'cache-control': 'no-store',
        },
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ua: (request.headers.get('User-Agent') ?? '').slice(0, 300) } satisfies Attachment);
    // 試合中に全員が一度切れて合図が止まっていたら、最初につなぎ直した人の分から再開する
    await this.ensureHeartbeat();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 試合中の合図 ----------

  /** 合図を出すのは、配役からタイマーの間だけ（待合室や結果発表の間は出さない＝リクエストを使わない） */
  private heartbeatActive(): boolean {
    return this.game.stage === 'assigned' || this.game.stage === 'timer';
  }

  /**
   * 合図はアラームで出す。setInterval だと休止（hibernation）できず起きている時間ぶん課金されるが、
   * アラームなら合図の瞬間だけ起きる。アラーム1回＝1リクエスト（2秒ごとで1時間に1,800）
   */
  private async ensureHeartbeat(): Promise<void> {
    if (!this.heartbeatActive()) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_EVERY_MS);
    }
  }

  async alarm(): Promise<void> {
    if (!this.heartbeatActive()) return;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    // 全員に同じ1本を送る（組み立ては1回だけ）
    const msg = JSON.stringify({ t: 'hb', s: Date.now() } satisfies ServerMsg);
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // 閉じかけの接続は、つなぎ直したときに全部を送り直すので捨ててよい
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_EVERY_MS);
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
        // 配役・開始で試合に入ったら合図を始める（止めるのはアラームの側：試合が終わっていたら次を予約しない）
        await this.ensureHeartbeat();
        return;
      case 'hold':
        this.onHold(att, msg, now);
        return;
      case 'heard':
        this.onHeard(att, msg.code, now);
        return;
      case 'answer':
        this.onAnswer(att, msg.pid, msg.manual === true, now);
        return;
      case 'nominate':
        this.onNominate(att, msg.pid, now);
        return;
      case 'roster':
        this.onRoster(ws, att);
        return;
      case 'cancel':
        this.onCancel(att, now);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 長押しの途中で切れたら、切れた時点で離したことにする（つなぎ直した端末が押し続けていれば、押し始めを送り直してくる）
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.pid) {
      const stillOpen = this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() as Attachment | null)?.pid === att.pid);
      if (!stillOpen) this.endHold(att.pid, Date.now(), 'disconnect');
    }
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
      code: null,
      caughtAssign: 0,
      caughtBy: null,
      caughtAt: null,
      caughtVia: null,
      ua: att.ua || null,
    };
    this.game.nextNum += 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO participants (pid, key, num, name, role, assign_id, ack_id, removed, joined_at, ua) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, ?, ?)`,
        p.pid,
        p.key,
        p.num,
        p.name,
        p.joinedAt,
        p.ua,
      );
      this.saveGame();
      this.log('join', { p, at: now, data: { ua: p.ua } });
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
    if (att.ua && att.ua !== p.ua) {
      p.ua = att.ua;
      this.sql.exec(`UPDATE participants SET ua = ? WHERE pid = ?`, p.ua, p.pid);
    }
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

  // ---------- 捕獲 ----------

  /** 今の配役に入っていて、外されていない人 */
  private inRound(pid: unknown): Participant | null {
    if (typeof pid !== 'string') return null;
    const p = this.people.get(pid);
    const g = this.game;
    if (!p || p.removed || g.assignId === 0 || p.assignId !== g.assignId || !p.role) return null;
    return p;
  }

  private isCaught(p: Participant): boolean {
    return p.role === 'runner' && p.caughtAssign === this.game.assignId && this.game.assignId > 0;
  }

  /** 押した時刻：スマホの見積もり（サーバー時刻）を使うが、未来や古すぎる値は届いた時刻に寄せる */
  private pressAt(raw: unknown, now: number): number {
    const at = Number(raw);
    if (!Number.isFinite(at)) return now;
    return Math.min(now, Math.max(now - PRESS_MAX_DELAY_MS, Math.round(at)));
  }

  /** ゲームの段階（終了の直後 CLAIM_GRACE_MS も含む）に押されたか */
  private pressOpen(at: number): boolean {
    const g = this.game;
    if (g.stage !== 'timer' || !g.timer) return false;
    return captureOpenAt(g.timer, at) || captureOpenAt(g.timer, at - CLAIM_GRACE_MS);
  }

  /** 今も開いている、逃走者の「捕まった」 */
  private liveClaim(pid: string, now: number): Claim | null {
    const c = this.claims.get(pid);
    if (!c || c.assignId !== this.game.assignId || now - c.at > CLAIM_OPEN_MS) return null;
    return c;
  }

  private holdsOf(pid: string): HoldRec[] {
    return (this.holds.get(pid) ?? []).filter((h) => h.assignId === this.game.assignId);
  }

  private candidatesFor(runner: Participant, claim: Claim, now: number): Candidate[] {
    const g = this.game;
    // 開いてから（と、その少し前から）の自分の長押し。手動で選ばれて開いただけなら、開いた瞬間を長押しとみなす
    const mine = this.holdsOf(runner.pid).filter((h) => (h.end ?? now) >= claim.at - CLAIM_PAIR_WINDOW_MS);
    const runnerHolds: Hold[] = mine.length ? mine : [{ start: claim.at, end: claim.at }];
    const evBy = this.evidence.get(runner.pid);
    const oni: OniSignal[] = [];
    for (const q of this.people.values()) {
      if (q.removed || q.assignId !== g.assignId || q.role !== 'oni') continue;
      const ev = evBy?.get(q.pid);
      const valid = (t: number | null | undefined) => (ev && ev.assignId === g.assignId && t != null && now - t <= EVIDENCE_VALID_MS ? t : null);
      oni.push({ pid: q.pid, num: q.num, name: q.name, holds: this.holdsOf(q.pid), heardAt: valid(ev?.heardAt), nominatedAt: valid(ev?.nominatedAt) });
    }
    return rankCandidates(runnerHolds, oni, now);
  }

  /** 答え待ちの逃走者（候補が変わりうる人） */
  private openRunners(now: number): string[] {
    const out: string[] = [];
    for (const c of this.claims.values()) if (this.liveClaim(c.pid, now)) out.push(c.pid);
    return out;
  }

  private openClaim(p: Participant, at: number): Claim {
    const c: Claim = { pid: p.pid, assignId: this.game.assignId, at };
    this.claims.set(p.pid, c);
    this.saveClaim(c);
    return c;
  }

  /** 長押し（押し始め・離した）。送り直し・順番の入れ替わり・届かなかった「離した」に耐える */
  private onHold(att: Attachment, msg: Extract<ClientMsg, { t: 'hold' }>, now: number): void {
    const p = this.inRound(att.pid);
    if (!p) return;
    const at = this.pressAt(msg.at, now);
    if (msg.on !== true) {
      const start = Number(msg.start);
      if (Number.isFinite(start)) {
        // どの長押しを離したかが分かる：その長押しだけを閉じる（もう閉じていれば何もしない）
        this.endHold(p.pid, at, 'release', start);
      } else {
        // 押し始めの分からない「離した」（つなぎ直したとき・古い画面）：開いている長押しがあれば閉じる
        this.endHold(p.pid, at, msg.resume ? 'resume' : 'release');
      }
      return;
    }
    const list = this.holdsOf(p.pid);
    const same = list.find((h) => Math.abs(h.start - at) <= HOLD_SAME_MS);
    if (same) {
      // 同じ押し始めの送り直し。2回数えない。
      // 「まだ押している」の送り直し（replay でない）なのに、切断で閉じてしまっていたら、押している途中に戻す
      if (!msg.replay && same.end !== null && !this.isCaught(p)) {
        same.end = null;
        this.sql.exec(`UPDATE holds SET end = NULL WHERE id = ?`, same.id);
        this.log('hold', { p, at, data: { on: true, reopen: true } });
        this.sendSnapTo(p.role === 'oni' ? [p.pid, ...this.openRunners(now)] : [p.pid]);
        return;
      }
      this.sendSnapTo([p.pid]);
      return;
    }
    // 前の「離した」が届かないまま、新しく押した。前の長押しは、離した瞬間が分からないものとして閉じる
    if (list.some((h) => h.end === null)) this.endHold(p.pid, at, 'lost');
    if (this.isCaught(p)) {
      if (!msg.replay) this.notify(p.pid, 'already');
      this.sendSnapTo([p.pid]);
      return;
    }
    if (!this.pressOpen(at)) {
      if (!msg.replay) this.notify(p.pid, 'closed');
      return;
    }
    this.sql.exec(`INSERT INTO holds (pid, assign_id, start, end) VALUES (?, ?, ?, NULL)`, p.pid, this.game.assignId, at);
    const id = this.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
    // 古い長押しは候補の計算に使わないので、手元には最近の分だけ持つ
    const keep = list.filter((h) => now - (h.end ?? now) <= CLAIM_OPEN_MS + CLAIM_PAIR_WINDOW_MS);
    keep.push({ id, assignId: this.game.assignId, start: at, end: null });
    this.holds.set(p.pid, keep.slice(-8));
    this.log('hold', { p, at, data: { on: true, lagMs: now - at, replay: msg.replay === true } });
    if (p.role === 'runner' && !this.liveClaim(p.pid, now)) this.openClaim(p, at);
    // 鬼の長押しは、答え待ちの逃走者全員の候補を変えうる
    this.sendSnapTo(p.role === 'oni' ? [p.pid, ...this.openRunners(now)] : [p.pid]);
  }

  /**
   * 長押しを閉じる。start を渡したらその押し始めの長押しだけ、渡さなければ開いている最後の長押し。
   * 離した瞬間が分からない閉じ方（切断・つなぎ直し・届かなかった）は、押し始めから HOLD_UNKNOWN_END_MS までとみなす
   * （長い切断のあいだ「ずっと押していた」ことにして、関係ない逃走者に「同時」で出ないように）
   */
  private endHold(pid: string, at: number, reason: 'release' | 'capture' | 'disconnect' | 'lost' | 'resume', start?: number): void {
    const list = this.holds.get(pid);
    if (!list) return;
    const open = list.filter((h) => h.end === null && h.assignId === this.game.assignId);
    const h = start === undefined ? open[open.length - 1] : open.find((x) => Math.abs(x.start - start) <= HOLD_SAME_MS);
    if (!h) return;
    const known = reason === 'release' || reason === 'capture';
    h.end = Math.max(h.start, Math.min(at, h.start + (known ? HOLD_MAX_MS : HOLD_UNKNOWN_END_MS)));
    this.sql.exec(`UPDATE holds SET end = ? WHERE id = ?`, h.end, h.id);
    const p = this.people.get(pid) ?? null;
    this.log('hold', { p, at: h.end, data: { on: false, ms: h.end - h.start, reason } });
    const now = Date.now();
    this.sendSnapTo(p?.role === 'oni' ? [pid, ...this.openRunners(now)] : [pid]);
  }

  /** 鬼のスマホが、誰かの3桁を拾った */
  private onHeard(att: Attachment, rawCode: unknown, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || p.role !== 'oni' || typeof rawCode !== 'string' || !/^\d{3}$/.test(rawCode)) return;
    const g = this.game;
    if (g.stage !== 'timer' && g.stage !== 'result') return;
    let target: Participant | null = null;
    for (const q of this.people.values()) {
      if (q.code === rawCode && !q.removed && q.assignId === g.assignId) {
        target = q;
        break;
      }
    }
    if (!target || target.role !== 'runner' || this.isCaught(target)) return;
    const ev = this.evidenceOf(target.pid, p.pid);
    if (ev.heardAt !== null && now - ev.heardAt < HEARD_DEDUPE_MS) return;
    ev.heardAt = now;
    this.saveEvidence(target.pid, p.pid, ev);
    const open = this.liveClaim(target.pid, now) !== null;
    this.log('heard', { p, other: target, at: now, data: { code: rawCode, open } });
    if (open) this.sendSnapTo([target.pid]);
    this.notify(p.pid, 'heard', target);
  }

  private evidenceOf(runner: string, oni: string): Evidence {
    let m = this.evidence.get(runner);
    if (!m) this.evidence.set(runner, (m = new Map()));
    let ev = m.get(oni);
    if (!ev || ev.assignId !== this.game.assignId) {
      ev = { assignId: this.game.assignId, heardAt: null, nominatedAt: null };
      m.set(oni, ev);
    }
    return ev;
  }

  /**
   * 手動で選ぶための一覧（頼んだ本人にだけ）。鬼はゲームの段階の間、逃走者は「捕まった」を長押しして選んでいる間だけ。
   * それ以外のときに鬼の顔ぶれ（役）が分かってしまわないように
   */
  private onRoster(ws: WebSocket, att: Attachment): void {
    const p = this.inRound(att.pid);
    const g = this.game;
    const now = Date.now();
    const allowed = !!p && !this.isCaught(p) && (p.role === 'oni' ? this.pressOpen(now) : this.liveClaim(p.pid, now) !== null);
    if (!p || !allowed || (g.stage !== 'timer' && g.stage !== 'result')) {
      this.send(ws, { t: 'roster', people: [] });
      return;
    }
    const want: RoleId = p.role === 'oni' ? 'runner' : 'oni';
    const people: RosterEntry[] = [...this.people.values()]
      .filter((q) => !q.removed && q.assignId === g.assignId && q.role === want && !this.isCaught(q))
      .sort((a, b) => a.num - b.num)
      .map((q) => ({ pid: q.pid, num: q.num, name: q.name }));
    this.send(ws, { t: 'roster', people });
  }

  /** 鬼が手動で逃走者を選んだ。その逃走者の画面に候補として出る（記録はまだ） */
  private onNominate(att: Attachment, runnerPid: unknown, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || p.role !== 'oni') return;
    const runner = this.inRound(runnerPid);
    if (!runner || runner.role !== 'runner') return;
    if (this.isCaught(runner)) {
      this.notify(p.pid, 'already', runner);
      return;
    }
    if (!this.liveClaim(runner.pid, now) && !this.pressOpen(now)) {
      this.notify(p.pid, 'closed');
      return;
    }
    const ev = this.evidenceOf(runner.pid, p.pid);
    ev.nominatedAt = now;
    this.saveEvidence(runner.pid, p.pid, ev);
    if (!this.liveClaim(runner.pid, now)) this.openClaim(runner, now);
    this.log('nominate', { p, other: runner, at: now });
    this.notify(p.pid, 'nominated', runner);
    this.sendSnapTo([runner.pid]);
  }

  /** 逃走者が、並んだ候補（または手動の一覧）から「捕まえたのは◯◯」を選んだ。どれを選んでもよい */
  private onAnswer(att: Attachment, oniPid: unknown, manual: boolean, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || p.role !== 'runner') return;
    const g = this.game;
    if (this.isCaught(p)) {
      this.notify(p.pid, 'already');
      this.sendSnapTo([p.pid]);
      return;
    }
    const oni = this.inRound(oniPid);
    if (!oni || oni.role !== 'oni' || (g.stage !== 'timer' && g.stage !== 'result')) {
      this.sendSnapTo([p.pid]);
      return;
    }
    // 長押しせずに手動の一覧から選んだときは、選んだ瞬間に開いたとみなす（ゲームの段階の中だけ）
    let c = this.liveClaim(p.pid, now);
    if (!c) {
      if (!this.pressOpen(now)) {
        this.notify(p.pid, 'closed');
        return;
      }
      c = this.openClaim(p, now);
    }
    const cands = this.candidatesFor(p, c, now);
    const cand = cands.find((x) => x.pid === oni.pid);
    // 手動の一覧から選んだら「手動」。そのとき候補の手がかりがあったかは、詳細に残す
    this.recordCapture(p, oni, c.at, manual ? 'manual' : viaOf(cand), {
      manual,
      claimAt: c.at,
      heard: cand?.heard ?? false,
      together: cand?.together ?? false,
      nominated: cand?.nominated ?? false,
      gapMs: cand?.gapMs ?? null,
      rank: cand ? cands.indexOf(cand) : null,
      candidates: cands.length,
      answerMs: now - c.at,
    });
  }

  /** 逃走者が「捕まった」を取り下げた */
  private onCancel(att: Attachment, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || p.role !== 'runner') return;
    const c = this.liveClaim(p.pid, now);
    if (!c) return;
    this.claims.delete(p.pid);
    this.sql.exec(`DELETE FROM claims WHERE pid = ?`, p.pid);
    this.log('cancel', { p, at: now, data: { claimAt: c.at } });
    this.sendSnapTo([p.pid]);
  }

  /** 捕まったことにする。保存してから、本人と鬼に知らせ、全員の人数を配り直す */
  private recordCapture(runner: Participant, oni: Participant | null, at: number, via: CaptureVia, data: Record<string, unknown>): void {
    const assignId = this.game.assignId;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE participants SET caught_assign = ?, caught_by = ?, caught_at = ?, caught_via = ? WHERE pid = ?`,
        assignId,
        oni?.pid ?? null,
        at,
        via,
        runner.pid,
      );
      this.sql.exec(`DELETE FROM claims WHERE pid = ?`, runner.pid);
      this.sql.exec(`DELETE FROM evidence WHERE runner = ?`, runner.pid);
      this.log('capture', { p: oni, other: runner, via, at, data });
    });
    runner.caughtAssign = assignId;
    runner.caughtBy = oni?.pid ?? null;
    runner.caughtAt = at;
    runner.caughtVia = via;
    this.claims.delete(runner.pid);
    this.evidence.delete(runner.pid);
    // 捕まった人が押したまま記録されたら、その長押しはここで終わり
    this.endHold(runner.pid, Date.now(), 'capture');
    this.notify(runner.pid, 'caught', oni ?? undefined, via);
    if (oni) this.notify(oni.pid, 'captured', runner, via);
    this.broadcastNow();
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
      this.log('remove', { p, at: now });
      this.broadcastNow();
      return;
    }

    // 捕獲の手直しも、ほかの操作とぶつからないので版番号を見ない（1人ずつの操作）
    if (op === 'capture' || op === 'release') {
      const g = this.game;
      if (g.stage !== 'timer' && g.stage !== 'result') return this.reject(ws, att, op, 'not-allowed');
      const runner = this.inRound(msg.pid);
      if (!runner || runner.role !== 'runner') return this.reject(ws, att, op, 'not-found');
      if (op === 'capture') {
        if (this.isCaught(runner)) return this.reject(ws, att, op, 'not-allowed');
        const oni = msg.by ? this.inRound(msg.by) : null;
        if (msg.by && (!oni || oni.role !== 'oni')) return this.reject(ws, att, op, 'not-found');
        this.recordCapture(runner, oni, now, 'host', {});
        return;
      }
      if (!this.isCaught(runner)) return this.reject(ws, att, op, 'not-allowed');
      const by = runner.caughtBy ? this.people.get(runner.caughtBy) ?? null : null;
      const prev = { via: runner.caughtVia, at: runner.caughtAt };
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE participants SET caught_assign = 0, caught_by = NULL, caught_at = NULL, caught_via = NULL WHERE pid = ?`,
          runner.pid,
        );
        this.log('release', { p: by, other: runner, at: now, data: prev });
      });
      runner.caughtAssign = 0;
      runner.caughtBy = null;
      runner.caughtAt = null;
      runner.caughtVia = null;
      this.notify(runner.pid, 'released', by ?? undefined);
      if (by) this.notify(by.pid, 'released', runner);
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
        const codes = pickCodes(active.length);
        const codeOf = new Map(active.map((p, i) => [p.pid, codes[i]] as const));
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
            this.sql.exec(
              `UPDATE participants SET role = ?, assign_id = ?, ack_id = 0, code = ? WHERE pid = ?`,
              role,
              nextAssignId,
              codeOf.get(pid) ?? null,
              pid,
            );
          }
          this.sql.exec(
            `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            JSON.stringify(next),
          );
          this.dropClaims();
          this.game = next;
          for (const [pid, role] of roles) {
            const p = this.people.get(pid)!;
            this.log('role', { p, at: now, data: { role, code: codeOf.get(pid) } });
          }
          this.log('assign', { at: now, data: { oni, runner, reroll: isReroll } });
        });
        for (const [pid, role] of roles) {
          const p = this.people.get(pid)!;
          p.role = role;
          p.assignId = nextAssignId;
          p.ackId = 0;
          p.code = codeOf.get(pid) ?? null;
        }
        break;
      }
      case 'start':
        if (g.stage !== 'assigned') return this.reject(ws, att, op, 'not-allowed');
        this.commit({ stage: 'timer', timer: startTimer(g.durations, now), result: null });
        this.log('start', { at: now, data: { durations: g.durations } });
        break;
      case 'pause':
        if (g.stage !== 'timer' || !g.timer || g.timer.status !== 'running' || timerDone) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        this.commit({ timer: pauseTimer(g.timer, now) });
        this.log('pause', { at: now });
        break;
      case 'resume':
        if (g.stage !== 'timer' || !g.timer || g.timer.status !== 'paused') return this.reject(ws, att, op, 'not-allowed');
        this.commit({ timer: resumeTimer(g.timer, now) });
        this.log('resume', { at: now });
        break;
      case 'skip': {
        // 次に進む：走っている間だけ。あと2秒以内に終わる段階は縮めない（二度押しは版番号で断っている）
        if (g.stage !== 'timer' || !g.timer || g.timer.status !== 'running' || timerDone) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const next = skipPhase(g.timer, now);
        if (next === g.timer) return this.reject(ws, att, op, 'not-allowed');
        const from = positionAt(g.timer, now);
        this.commit({ timer: next });
        this.log('skip', { at: now, data: { from: from.kind === 'phase' ? from.index : null } });
        break;
      }
      case 'reset': {
        if (g.stage !== 'timer') return this.reject(ws, att, op, 'not-allowed');
        // やり直しなので、この配役の捕獲と押した記録も消す（ログには残る）
        this.ctx.storage.transactionSync(() => {
          this.log('reset', { at: now });
          this.sql.exec(
            `UPDATE participants SET caught_assign = 0, caught_by = NULL, caught_at = NULL, caught_via = NULL WHERE caught_assign = ?`,
            g.assignId,
          );
          this.dropClaims();
        });
        for (const p of this.people.values()) {
          if (p.caughtAssign === g.assignId) {
            p.caughtAssign = 0;
            p.caughtBy = null;
            p.caughtAt = null;
            p.caughtVia = null;
          }
        }
        this.commit({ stage: 'assigned', timer: null });
        break;
      }
      case 'result': {
        if (msg.winner !== 'oni' && msg.winner !== 'runner') return this.reject(ws, att, op, 'bad-input');
        if (!(g.stage === 'result' || timerDone)) return this.reject(ws, att, op, 'not-allowed');
        this.log('result', { at: now, data: { winner: msg.winner, caught: this.caughtCount() } });
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
        this.log('durations', { at: now, data: { durations: d } });
        break;
      }
      case 'clear': {
        // 部屋を空にする：参加者を全員外し、配役前に戻す（時間の設定は残す）。試合中はできない
        if (g.stage === 'timer' && !timerDone) return this.reject(ws, att, op, 'not-allowed');
        const next: GameState = {
          ...g,
          round: 0,
          assignId: 0,
          stage: 'lobby',
          cv: g.cv + 1,
          timer: null,
          result: null,
          nextNum: 1,
          counts: { oni: 0, runner: 0 },
        };
        this.ctx.storage.transactionSync(() => {
          this.log('clear', { at: now, data: { people: this.people.size } });
          this.sql.exec(`DELETE FROM participants`);
          this.dropClaims();
          this.sql.exec(
            `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            JSON.stringify(next),
          );
        });
        this.people.clear();
        this.game = next;
        // つながっている参加者に「その人はもういない」と知らせる → スマホは入室画面に戻る
        for (const sock of this.ctx.getWebSockets()) {
          const a = sock.deserializeAttachment() as Attachment | null;
          if (!a?.pid) continue;
          delete a.pid;
          delete a.syncErr;
          sock.serializeAttachment(a);
          this.send(sock, { t: 'unknown' });
        }
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

  private caughtCount(): number {
    const g = this.game;
    if (g.assignId === 0) return 0;
    let n = 0;
    for (const p of this.people.values()) {
      if (!p.removed && p.assignId === g.assignId && p.role === 'runner' && p.caughtAssign === g.assignId) n++;
    }
    return n;
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
      counts: { oni: g.counts.oni, runner: g.counts.runner, total: this.activePeople().length, caught: this.caughtCount() },
      result: g.result,
      durations: g.durations,
    };
  }

  private meView(pid: string, now = Date.now()): MeView | undefined {
    const p = this.people.get(pid);
    if (!p) return undefined;
    const g = this.game;
    const inCurrent = p.assignId === g.assignId && g.assignId > 0;
    const live = inCurrent && !p.removed;
    const by = p.caughtBy ? this.people.get(p.caughtBy) : undefined;
    let catches = 0;
    if (live && p.role === 'oni') {
      for (const q of this.people.values()) if (q.caughtAssign === g.assignId && q.caughtBy === p.pid) catches++;
    }
    let claim: MeView['claim'] = null;
    const c = live ? this.liveClaim(p.pid, now) : null;
    if (c && p.role === 'runner' && !this.isCaught(p)) {
      claim = { at: c.at, cands: this.candidatesFor(p, c, now) };
    }
    return {
      pid: p.pid,
      num: p.num,
      name: p.name,
      role: live ? p.role : null,
      assignId: inCurrent ? p.assignId : 0,
      removed: p.removed,
      code: live ? p.code : null,
      caught:
        live && this.isCaught(p)
          ? { byNum: by?.num ?? null, byName: by?.name ?? null, at: p.caughtAt ?? 0, via: p.caughtVia ?? 'host' }
          : null,
      catches,
      claim,
    };
  }

  private hostCapture(): HostCapture | null {
    const g = this.game;
    if (g.assignId === 0) return null;
    const now = Date.now();
    const inRound = [...this.people.values()].filter((p) => !p.removed && p.assignId === g.assignId && p.role);
    const catches = new Map<string, number>();
    for (const p of inRound) {
      if (p.caughtAssign === g.assignId && p.caughtBy) catches.set(p.caughtBy, (catches.get(p.caughtBy) ?? 0) + 1);
    }
    return {
      runners: inRound
        .filter((p) => p.role === 'runner')
        .sort((a, b) => a.num - b.num)
        .map((p) => {
          const caught = this.isCaught(p);
          const by = caught && p.caughtBy ? this.people.get(p.caughtBy) : undefined;
          return {
            pid: p.pid,
            num: p.num,
            name: p.name,
            caught,
            byNum: by?.num ?? null,
            byName: by?.name ?? null,
            via: caught ? p.caughtVia : null,
            at: caught ? p.caughtAt : null,
            open: !caught && this.liveClaim(p.pid, now) !== null,
          };
        }),
      oni: inRound
        .filter((p) => p.role === 'oni')
        .sort((a, b) => a.num - b.num)
        .map((p) => ({ pid: p.pid, num: p.num, name: p.name, catches: catches.get(p.pid) ?? 0 })),
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
      capture: this.hostCapture(),
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

  /** 決まった人たちにだけ、今の全部を送る（押した・聞き取った・答えたは本人と相手にしか関係しない） */
  private sendSnapTo(pids: Iterable<string>): void {
    const want = new Set(pids);
    if (want.size === 0) return;
    const game = this.gameView();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid && want.has(att.pid)) this.send(ws, this.snapFor(att, game, null));
    }
    this.scheduleHostUpdate();
  }

  private notify(pid: string, kind: NoticeKind, other?: Participant, via?: CaptureVia): void {
    const msg: ServerMsg = {
      t: 'notice',
      kind,
      other: other ? { num: other.num, name: other.name } : undefined,
      via,
      at: Date.now(),
    };
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid === pid) this.send(ws, msg);
    }
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
