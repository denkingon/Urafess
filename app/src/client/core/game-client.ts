import { ClockEstimator } from '../../shared/clock';
import type { CaptureVia } from '../../shared/capture';
import type { GameView, HostOp, HostSummary, MeView, NoticeKind, RosterEntry, ServerMsg, Winner } from '../../shared/protocol';
import { SILENCE_LIMIT_MS } from '../../shared/rules';

/**
 * しくみの層。接続・時計合わせ・状態だけを持ち、見た目は一切知らない。
 * ブラウザでも、テスト用の仮想参加者（Node）でも同じものが動く。
 */

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // ブラウザの WebSocket と Node の WebSocket の両方を受けるため、イベントの型はゆるくしておく
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface ClientDeps {
  /** wss://…/api/game/<id>/ws */
  url: string;
  gameId: string;
  createSocket: (url: string) => WebSocketLike;
  /** このスマホの時計（ブラウザでは Date.now） */
  now: () => number;
  storage: KeyValueStore;
  random?: () => number;
}

export type ClientMode = { kind: 'player' } | { kind: 'host'; token: string };

export interface Identity {
  pid: string;
  key: string;
  num: number;
  name: string;
}

/** 本人だけに届いた短い知らせ。seq は届くたびに増える（画面は seq の変化で帯を出す） */
export interface Notice {
  seq: number;
  kind: NoticeKind;
  other: { num: number; name: string } | null;
  via: CaptureVia | null;
  at: number;
}

export interface ClientState {
  /** need-name: 入室前 / ready: 状態を受け取った / denied: 主催者の合言葉が違う */
  phase: 'connecting' | 'need-name' | 'joining' | 'ready' | 'denied';
  online: boolean;
  game: GameView | null;
  me: MeView | null;
  host: HostSummary | null;
  identity: Identity | null;
  lastReject: { op: HostOp; reason: string } | null;
  joinError: string | null;
  notice: Notice | null;
  /** 手動で選ぶための一覧（頼んだあとに届く）。seq は届くたびに増える */
  roster: { seq: number; people: RosterEntry[] } | null;
}

const CONNECTING = 0;
const OPEN = 1;
const BURST_ON_CONNECT = 8;
const BURST_ON_WAKE = 5;
const BURST_PERIODIC = 3;
const BURST_SPACING_MS = 120;
/** つなぎ直しの直後は、全員が同じ瞬間に測り始めないよう最初の問い合わせを少しずらす */
const BURST_JITTER_MS = 500;
/**
 * 大勢が一斉につなぎ直した直後はサーバーが混み、行きだけが遅れて時計が少しずれる。
 * 混雑が引いたころ（6〜12秒後）にもう一度測り、往復の短い測定で上書きする
 */
const FOLLOW_UP_MIN_MS = 6_000;
const FOLLOW_UP_SPREAD_MS = 6_000;
const RESYNC_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 8_000;
/** つなごうとしたまま返事が来ない（電波の悪い所・つながりかけの回線）ときに諦めて、つなぎ直すまでの時間 */
const CONNECT_TIMEOUT_MS = 8_000;
/** 見張りの間隔。試合中の合図が途切れたのに気づくのが、最大でこれだけ遅れる */
const HEARTBEAT_TICK_MS = 1_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class GameClient {
  readonly clock = new ClockEstimator();
  state: ClientState;

  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private burstTimers: ReturnType<typeof setTimeout>[] = [];
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  private pings = new Map<number, number>();
  private pingId = 0;
  private lastSyncAt = -Infinity;
  private connectStartedAt = 0;
  /** この接続で最後に何かを受け取った時刻（スマホの時計） */
  private lastRecvAt = 0;
  /** この接続で試合中の合図（hb）を一度でも受け取ったか。古いサーバーとつながったときは見張らない */
  private sawHeartbeat = false;
  private roughOffset: number | null = null;
  private ackedAssignId = 0;
  private pendingJoinName: string | null = null;
  /** 押している長押し（押し始めのサーバー時刻）。つなぎ直したら送り直す */
  private holding: { at: number | undefined } | null = null;
  private noticeSeq = 0;
  private rosterSeq = 0;
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;

  constructor(
    private readonly deps: ClientDeps,
    private readonly mode: ClientMode,
  ) {
    this.storageKey = `urafess:${deps.gameId}:me`;
    this.state = {
      phase: 'connecting',
      online: false,
      game: null,
      me: null,
      host: null,
      identity: mode.kind === 'player' ? this.loadIdentity() : null,
      lastReject: null,
      joinError: null,
      notice: null,
      roster: null,
    };
  }

  // ---------- 外から使うもの ----------

  start(): void {
    this.stopped = false;
    this.connect();
    this.heartbeat ??= setInterval(() => this.tick(), HEARTBEAT_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    this.clearBurst();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // 閉じている
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** サーバー時刻の見積もり。まだ一度も測れていなければ、最初に届いた状態の時刻から粗く出す */
  serverNow(): number | null {
    const offset = this.clock.offset() ?? this.roughOffset;
    return offset === null ? null : this.deps.now() + offset;
  }

  syncError(): number | null {
    return this.clock.errorBound();
  }

  join(name: string): void {
    this.pendingJoinName = name;
    this.state = { ...this.state, phase: 'joining', joinError: null };
    this.emit();
    if (this.isOpen()) this.send({ t: 'join', name });
  }

  // ---------- 捕獲 ----------

  /** スマホの時計の時刻を、サーバー時刻の見積もりにする（まだ測れていなければ undefined＝サーバーが届いた時刻を使う） */
  private toServer(localAt: number): number | undefined {
    const offset = this.clock.offset() ?? this.roughOffset;
    return offset === null ? undefined : Math.round(localAt + offset);
  }

  /** 長押しを始めた（HOLD_MIN_MS 押し続けたら呼ぶ。localAt は指を置いた瞬間のスマホの時計） */
  holdStart(localAt: number): void {
    const at = this.toServer(localAt);
    this.holding = { at };
    this.send({ t: 'hold', on: true, at });
  }

  /** 長押しを離した */
  holdEnd(localAt: number): void {
    if (!this.holding) return;
    this.holding = null;
    this.send({ t: 'hold', on: false, at: this.toServer(localAt) });
  }

  /** 鬼のスマホが3桁を拾った */
  heard(code: string): void {
    this.send({ t: 'heard', code });
  }

  /** 逃走者が「捕まえたのは◯◯」を選んだ。manual＝手動の一覧から選んだ */
  answer(oniPid: string, manual = false): void {
    this.send({ t: 'answer', pid: oniPid, manual });
  }

  /** 鬼が手動の一覧から逃走者を選んだ */
  nominate(runnerPid: string): void {
    this.send({ t: 'nominate', pid: runnerPid });
  }

  /** 手動で選ぶ一覧を頼む（届くと state.roster が変わる） */
  requestRoster(): void {
    this.send({ t: 'roster' });
  }

  /** 逃走者が「捕まった」を取り下げる */
  cancelClaim(): void {
    this.send({ t: 'cancel' });
  }

  command(op: HostOp, extra: { winner?: Winner; durations?: number[]; pid?: string; by?: string } = {}): boolean {
    const game = this.state.game;
    if (!this.isOpen() || !game) return false;
    this.state = { ...this.state, lastReject: null };
    this.send({ t: 'cmd', op, cv: game.cv, ...extra });
    return true;
  }

  /**
   * 画面に戻ってきた・電波が戻ったとき。切れていればすぐつなぎ直し、つながっていれば時計を測り直す。
   * 「つながっている」ように見えても試合中の合図が途切れていれば、裏にいる間に切れていたのですぐつなぎ直す
   */
  wake(): void {
    if (this.stopped) return;
    if (this.isOpen() && !this.isSilent(this.deps.now())) {
      this.burst(BURST_ON_WAKE);
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.connect();
  }

  /** スマホの時計が飛んだ疑いがあるとき */
  resetClock(): void {
    this.clock.reset();
    this.wake();
  }

  // ---------- 接続 ----------

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === OPEN;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {
      // 閉じている
    }
    let ws: WebSocketLike;
    try {
      ws = this.deps.createSocket(this.deps.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectStartedAt = this.deps.now();
    this.lastRecvAt = this.connectStartedAt;
    this.sawHeartbeat = false;
    this.pings.clear();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastRecvAt = this.deps.now();
      // つなぎ直したら受け取りの返事も送り直す（サーバー側で重複は無視される）
      this.ackedAssignId = 0;
      this.state = { ...this.state, online: true };
      this.hello();
      this.burst(BURST_ON_CONNECT, BURST_JITTER_MS);
      this.scheduleFollowUp();
      this.emit();
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      this.lastRecvAt = this.deps.now();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.dropConnection();
    };
    ws.onerror = () => {
      // onclose が続いて来る
    };
  }

  private dropConnection(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearBurst();
    this.pings.clear();
    try {
      ws?.close();
    } catch {
      // 閉じている
    }
    this.state = { ...this.state, online: false };
    this.emit();
    this.scheduleReconnect();
  }

  /** 待ち時間を少しずつ延ばし、全員が同じ瞬間につなぎ直さないようにばらす */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const random = this.deps.random ?? Math.random;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = base / 2 + random() * (base / 2);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private hello(): void {
    if (this.mode.kind === 'host') {
      this.send({ t: 'host', token: this.mode.token });
    } else if (this.state.identity) {
      this.send({ t: 'resume', pid: this.state.identity.pid, key: this.state.identity.key });
      // 押している途中でつなぎ直したら、同じ押し始めを送り直す（サーバーは同じ長押しとして扱う）
      if (this.holding) this.send({ t: 'hold', on: true, at: this.holding.at });
    } else if (this.pendingJoinName) {
      this.send({ t: 'join', name: this.pendingJoinName });
    } else {
      this.state = { ...this.state, phase: 'need-name' };
    }
  }

  private tick(): void {
    const now = this.deps.now();
    // つなごうとしたまま止まっている接続は捨てて、つなぎ直す
    if (this.ws && this.ws.readyState === CONNECTING && now - this.connectStartedAt > CONNECT_TIMEOUT_MS) {
      this.dropConnection();
      return;
    }
    if (!this.isOpen()) return;
    // 返事の来ない問い合わせがある＝見えない切断。つなぎ直す
    for (const a of this.pings.values()) {
      if (now - a > PONG_TIMEOUT_MS) {
        this.dropConnection();
        return;
      }
    }
    // 試合中の合図が途切れた＝見えない切断。30秒ごとの時計合わせを待たずに、数秒で気づいてつなぎ直す
    if (this.isSilent(now)) {
      this.dropConnection();
      return;
    }
    if (now - this.lastSyncAt >= RESYNC_EVERY_MS) this.burst(BURST_PERIODIC);
  }

  /**
   * 試合中（合図が来るはずの間）に、合図も何も SILENCE_LIMIT_MS 以上届いていない。
   * 入室画面に戻された人（主催者が「部屋を空にする」を押した等）は、手元に古い段階が残っていても見張らない
   */
  private isSilent(now: number): boolean {
    const stage = this.state.game?.stage;
    const expecting = this.sawHeartbeat && this.state.phase === 'ready' && (stage === 'assigned' || stage === 'timer');
    return expecting && now - this.lastRecvAt > SILENCE_LIMIT_MS;
  }

  // ---------- 時計合わせ ----------

  private clearBurst(): void {
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = [];
  }

  private scheduleFollowUp(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    const delay = FOLLOW_UP_MIN_MS + (this.deps.random ?? Math.random)() * FOLLOW_UP_SPREAD_MS;
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null;
      if (this.isOpen()) this.burst(BURST_PERIODIC);
    }, delay);
  }

  private burst(n: number, jitterMs = 0): void {
    this.clearBurst();
    this.lastSyncAt = this.deps.now();
    const offset = jitterMs > 0 ? (this.deps.random ?? Math.random)() * jitterMs : 0;
    for (let i = 0; i < n; i++) {
      this.burstTimers.push(setTimeout(() => this.ping(), offset + i * BURST_SPACING_MS));
    }
  }

  private ping(): void {
    if (!this.isOpen()) return;
    const id = ++this.pingId;
    const a = this.deps.now();
    this.pings.set(id, a);
    this.send({ t: 'ping', id, a });
  }

  // ---------- 受け取り ----------

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hb':
        // 届いた時刻は onmessage で記録済み。画面は変わらないので描き直さない
        this.sawHeartbeat = true;
        return;
      case 'pong': {
        const a = this.pings.get(msg.id);
        if (a === undefined) return;
        this.pings.delete(msg.id);
        this.clock.add(a, msg.s, this.deps.now());
        if (this.pings.size === 0) {
          const err = this.clock.errorBound();
          if (err !== null) this.send({ t: 'sync', err: Math.round(err) });
          this.emit();
        }
        return;
      }
      case 'welcome': {
        const identity: Identity = { pid: msg.pid, key: msg.key, num: msg.num, name: msg.name };
        this.pendingJoinName = null;
        this.saveIdentity(identity);
        this.state = { ...this.state, identity };
        break;
      }
      case 'unknown': {
        // 保存してあった本人の印がサーバーに無い（別のゲーム・外された記録の消去など）か、名前が不正
        const triedJoin = this.pendingJoinName !== null;
        this.pendingJoinName = null;
        if (!triedJoin) this.clearIdentity();
        this.state = {
          ...this.state,
          identity: triedJoin ? this.state.identity : null,
          phase: 'need-name',
          joinError: triedJoin ? 'ニックネームは1〜20文字で入れる。' : null,
        };
        break;
      }
      case 'denied':
        this.state = { ...this.state, phase: 'denied' };
        break;
      case 'snap': {
        if (this.clock.offset() === null) this.roughOffset = msg.now - this.deps.now();
        this.state = {
          ...this.state,
          phase: msg.me || msg.host ? 'ready' : this.state.phase,
          game: msg.game,
          me: msg.me ?? null,
          host: msg.host ?? null,
        };
        // 役を受け取ったことをサーバーに返す（主催者画面の「受け取り済み」）
        const me = msg.me;
        if (me && me.role && me.assignId === msg.game.assignId && this.ackedAssignId !== me.assignId) {
          this.ackedAssignId = me.assignId;
          this.send({ t: 'ack', assignId: me.assignId });
        }
        break;
      }
      case 'reject':
        this.state = { ...this.state, lastReject: { op: msg.op, reason: msg.reason } };
        break;
      case 'notice':
        this.state = {
          ...this.state,
          notice: { seq: ++this.noticeSeq, kind: msg.kind, other: msg.other ?? null, via: msg.via ?? null, at: msg.at },
        };
        break;
      case 'roster':
        this.state = { ...this.state, roster: { seq: ++this.rosterSeq, people: msg.people } };
        break;
    }
    this.emit();
  }

  private send(msg: object): void {
    if (!this.isOpen()) return;
    try {
      this.ws!.send(JSON.stringify(msg));
    } catch {
      // 次のつなぎ直しで送り直す
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------- 本人の印 ----------

  private loadIdentity(): Identity | null {
    try {
      const raw = this.deps.storage.get(this.storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw) as Identity;
      return typeof v.pid === 'string' && typeof v.key === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  private saveIdentity(identity: Identity): void {
    try {
      this.deps.storage.set(this.storageKey, JSON.stringify(identity));
    } catch {
      // 保存できない端末でも、この画面を開いている間は同じ人として動く
    }
  }

  private clearIdentity(): void {
    try {
      this.deps.storage.remove(this.storageKey);
    } catch {
      // 何もしない
    }
  }
}
