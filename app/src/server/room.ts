import { DurableObject } from 'cloudflare:workers';
import { assignRoles } from '../shared/allocate';
import { autoPick, CAPTURE_PHASE_INDEX, captureOpenAt, pickCodes, rankCandidates, viaOf, type Candidate, type CaptureVia, type Hold, type OniSignal } from '../shared/capture';
import type {
  ClientMsg,
  GameView,
  GlowEntry,
  HostCapture,
  HostOp,
  HostSummary,
  MeView,
  NoticeKind,
  RosterEntry,
  SenseState,
  RescueVia,
  ServerMsg,
  Stage,
  Winner,
} from '../shared/protocol';
import { decideWinner, everyoneJailed } from '../shared/jail';
import {
  CLAIM_GRACE_MS,
  CLAIM_OPEN_MS,
  CLAIM_PAIR_WINDOW_MS,
  DEFAULT_DURATIONS_MS,
  DEFAULT_MIC_MODE,
  DEFAULT_RATIO,
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  EVIDENCE_VALID_MS,
  HEARTBEAT_EVERY_MS,
  HOLD_MAX_MS,
  HEARD_SLACK_MS,
  HOLD_UNKNOWN_END_MS,
  isMicMode,
  isValidRatio,
  PHASES,
  RESCUE_GAP_MS,
  RESCUE_HOLD_KEEP_MS,
  RESCUE_IMMUNE_MS,
  ROLES,
  RUN_STALE_MS,
  SYNC_OK_MS,
  type MicMode,
  type Ratio,
  type RoleId,
} from '../shared/rules';
import { nameKey, normalizeName } from '../shared/names';
import { distanceM } from '../shared/run';
import { boundaryTimes, cumulative, elapsedAt, isDone, pauseTimer, positionAt, resumeTimer, skipPhase, startTimer, type Timer } from '../shared/schedule';
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
  /** 配役の比率の重み。古い保存データには無いので load で補う */
  ratio: Ratio;
  /** 鬼のマイクの聞き方（主催者が切り替える）。古い保存データには無いので load で補う */
  micMode: MicMode;
  /** 次に名簿に入る人の番号（名簿に入った順。画面には出さない。部屋を空にしても戻さない） */
  nextNum: number;
  counts: { oni: number; runner: number };
  /** 何番目の夜か（「新しい夜を始める」で1つ進む） */
  night: number;
  /** 今の夜を始めた時刻 */
  nightAt: number;
  /** 逃走者が全員同時に牢屋に入った時刻（その配役は鬼の勝ちで決まり）。古い保存データには無い */
  allCaughtAt?: number | null;
  /** result をアプリが決めた */
  resultAuto?: boolean;
}

/**
 * 名簿の1人。「新しい夜を始める（部屋を空にする）」でも消えない（一生もの）。
 * pid と key は今夜の参加者（Participant）と同じものを使う。スマホに残る合い鍵はこの2つ
 */
interface Member {
  pid: string;
  key: string;
  num: number;
  name: string;
  /** 同じ名前かどうかを見る形（names.ts の nameKey） */
  nameKey: string;
  createdAt: number;
  /** 最後に今夜へ入った時刻 */
  lastAt: number;
  /** 来た夜の数 */
  nights: number;
  firstNight: number;
  lastNight: number;
}

type MemberRow = {
  pid: string;
  key: string;
  num: number;
  name: string;
  name_key: string;
  created_at: number;
  last_at: number;
  nights: number;
  first_night: number;
  last_night: number;
};

/** 記録に名前を残す相手（今夜の参加者でも、名簿の人でもよい） */
type Who = { pid: string; num: number; name: string };

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
  /** その回の「助ける番号」。牢屋の人を助けるとき、スマホが最大音量で鳴らす（code とは別。鬼のマイクが拾っても捕獲にならない） */
  rcode: string | null;
  /** 牢屋から出たあと、この時刻までは捕まらない */
  freeUntil: number | null;
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

/**
 * 走ると光る：いま光っている1人。保存しない（光は一瞬のもの。サーバーが入れ替わったら、次に届いた「走っている」から光り直す）。
 * 光った・消えたは記録（events）に残す
 */
interface RunRec {
  pid: string;
  since: number;
  at: number;
  lat: number | null;
  lon: number | null;
  acc: number | null;
  /** 記録用：ときどきの位置 [緯度, 経度, 光ってからの秒] と、走ったおおよその距離（m） */
  path: [number, number, number][];
  dist: number;
  lastPathAt: number;
}

type RunEnd = 'stop' | 'stale' | 'closed' | 'caught' | 'out';

/** WebSocket ごとに持つ情報。休止（hibernation）をまたいでも残る */
interface Attachment {
  /** 今夜に入っている参加者 */
  pid?: string;
  /** 名簿にはいるが、今夜にはまだ入っていない人（名前のボタンを押すと enter が来る） */
  mid?: string;
  /** 「前の◯◯に戻りたい」と主催者を待っている（rid＝頼みの印、mid＝戻りたい先） */
  reclaim?: { rid: string; mid: string; at: number };
  host?: boolean;
  /** 本人が報告した時計の誤差（往復の半分, ms） */
  syncErr?: number;
  /** つないだ端末の User-Agent */
  ua?: string;
  /** 走ると光る：このスマホで動きのセンサー・位置が使えるか（本人が知らせてくる） */
  sense?: { motion: SenseState; geo: SenseState };
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
  rcode: string | null;
  free_until: number | null;
};

/** 「助けて」「助ける」の長押し（保存しない。押している間の数秒だけのもの） */
interface RescueHold {
  start: number;
  end: number | null;
  /** この長押しで、もう1人を出した（1回の長押しで1人） */
  used?: boolean;
}

const LOBBY_BROADCAST_MS = 300;
const HOST_UPDATE_MS = 500;
/** 押した時刻として受け付けるのは、届いた時刻からこれだけ前まで（電波の詰まり・つなぎ直しの送り直しで遅れて届く分） */
const PRESS_MAX_DELAY_MS = 60_000;
/** 同じ鬼が同じ音を何度も聞き取ったとき、記録し直すまでの間隔（逃走者のスマホは繰り返し鳴らす） */
const HEARD_DEDUPE_MS = 5_000;
/** 押している途中に届いた「押し始め」が、前の押し始めとこれだけしか違わなければ、つなぎ直しの送り直し（同じ長押し） */
const HOLD_SAME_MS = 1_000;
/** 走ると光る：光の知らせはまとめて配る（何人走っていても、全員へは最大でこの間隔に1回） */
const GLOW_BROADCAST_MS = 250;
/** 走ると光る：記録に残す位置の間隔 */
const RUN_PATH_EVERY_MS = 2_000;

/**
 * 1ゲーム＝1つの Durable Object。正解はここにしかない。
 * - 操作は1つずつ順番に処理される（Durable Object は同時に1つしか動かない）
 * - 状態は SQLite に保存してから配る
 * - つながるたびに「今の全部」を送る
 */
export class GameRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private game!: GameState;
  /** 今夜の参加者 */
  private readonly people = new Map<string, Participant>();
  /** 名簿（ずっと残る） */
  private readonly members = new Map<string, Member>();
  /** 名前の形 → 名簿の人（同じ形が2人いれば先に入った人） */
  private readonly memberByName = new Map<string, Member>();
  private readonly claims = new Map<string, Claim>();
  /** 人 → 最近の長押し（古い順） */
  private readonly holds = new Map<string, HoldRec[]>();
  /** 逃走者 → （鬼 → 手がかり） */
  private readonly evidence = new Map<string, Map<string, Evidence>>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;
  /** 走ると光る：いま光っている人 */
  private readonly runs = new Map<string, RunRec>();
  /** 今の配役で、鬼 → 捕まえた回数（解放されても減らない。主催者の取り消しでだけ減る） */
  private readonly catches = new Map<string, number>();
  /** 今の配役で、逃走者 → 牢屋から出した人数 */
  private readonly rescues = new Map<string, number>();
  /** 「助けて」「助ける」の長押し（人 → 最近の分） */
  private readonly rescueHolds = new Map<string, RescueHold[]>();
  /** 助ける人が最後に1人を出した時刻（1回の長押しで1人） */
  private readonly lastRescueAt = new Map<string, number>();
  /**
   * 主催者の操作が最後に効いたときの版番号。アプリが自分で版番号を進めた（時間が0で結果を決めた・全員が牢屋に入った）だけなら、
   * その前の画面からの操作も受ける（古い画面の二度押し・同時押しだけを断る）
   */
  private hostCv = -1;
  private glowTimer: ReturnType<typeof setTimeout> | null = null;

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
      ['rcode', 'rcode TEXT'],
      ['free_until', 'free_until INTEGER'],
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
    // 名簿。新しい夜を始めても（部屋を空にしても）消さない
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS members (
        pid TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        num INTEGER NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        nights INTEGER NOT NULL DEFAULT 1,
        first_night INTEGER NOT NULL DEFAULT 1,
        last_night INTEGER NOT NULL DEFAULT 1
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS members_name_key ON members (name_key)`);
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
          ratio: { ...DEFAULT_RATIO },
          micMode: DEFAULT_MIC_MODE,
          nextNum: 1,
          counts: { oni: 0, runner: 0 },
          night: 1,
          nightAt: Date.now(),
        };
    // 名簿を入れる前の版で作った部屋には、夜の数が無い
    if (!Number.isInteger(this.game.night) || this.game.night < 1) this.game.night = 1;
    if (!Number.isFinite(this.game.nightAt)) {
      // 夜の始まりは、今夜いちばん早く入った人の時刻とみなして保存する。
      // 保存しないと、サーバーが入れ替わるたびに「今」に戻り、「前の夜のまま12時間」の知らせが出なくなる
      const first = this.sql.exec<{ t: number | null }>(`SELECT MIN(joined_at) AS t FROM participants`).toArray()[0]?.t;
      this.game.nightAt = typeof first === 'number' && Number.isFinite(first) ? first : Date.now();
      if (row) this.saveGame();
    }
    if (!isValidRatio(this.game.ratio)) this.game.ratio = { ...DEFAULT_RATIO };
    if (!isMicMode(this.game.micMode)) this.game.micMode = DEFAULT_MIC_MODE;
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
        rcode: r.rcode ?? null,
        freeUntil: r.free_until ?? null,
      });
    }
    // 捕獲・牢屋を入れる前の版で配役した部屋（公開の瞬間に試合中だった等）は、3桁が無い。ここで配る
    if (this.game.assignId > 0) {
      const current = [...this.people.values()].filter((p) => !p.removed && p.assignId === this.game.assignId && p.role);
      const used = new Set(current.flatMap((p) => [p.code, p.rcode]));
      const pool = pickCodes(900).filter((c) => !used.has(c));
      for (const p of current) {
        if (!p.code) p.code = pool.shift() ?? null;
        if (!p.rcode) p.rcode = pool.shift() ?? null;
        this.sql.exec(`UPDATE participants SET code = ?, rcode = ? WHERE pid = ?`, p.code, p.rcode, p.pid);
      }
    }
    this.loadTallies();
    this.loadMembers();
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

  /**
   * 名簿を読む。名簿を入れる前の版で入った参加者（外されていない人）は、最初の1回だけ名簿へ移す。
   * pid・合い鍵・番号はそのまま使うので、その人のスマホは入り直さずに名簿の人として戻れる
   */
  private loadMembers(): void {
    const moved = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'members'`).toArray()[0];
    if (!moved) {
      const now = Date.now();
      const legacy = [...this.people.values()].filter((p) => !p.removed).sort((a, b) => a.num - b.num);
      this.ctx.storage.transactionSync(() => {
        for (const p of legacy) {
          this.sql.exec(
            `INSERT OR IGNORE INTO members (pid, key, num, name, name_key, created_at, last_at, nights, first_night, last_night)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            p.pid,
            p.key,
            p.num,
            p.name,
            nameKey(p.name),
            p.joinedAt,
            p.joinedAt,
            this.game.night,
            this.game.night,
          );
        }
        this.sql.exec(`INSERT INTO meta (k, v) VALUES ('members', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
        this.saveGame();
        if (legacy.length) this.log('migrate', { at: now, data: { members: legacy.length } });
      });
    }
    this.members.clear();
    this.memberByName.clear();
    for (const r of this.sql.exec<MemberRow>(`SELECT * FROM members ORDER BY num`)) {
      const m: Member = {
        pid: r.pid,
        key: r.key,
        num: r.num,
        name: r.name,
        nameKey: r.name_key,
        createdAt: r.created_at,
        lastAt: r.last_at,
        nights: r.nights,
        firstNight: r.first_night,
        lastNight: r.last_night,
      };
      this.members.set(m.pid, m);
      if (!this.memberByName.has(m.nameKey)) this.memberByName.set(m.nameKey, m);
    }
  }

  /**
   * 今の配役の「捕まえた回数」「出した人数」を記録から数え直す（サーバーが入れ替わったとき）。
   * 同じ配役の番号は、やり直し（reset）と新しい夜（clear）のあとにも使われるので、最後の配役・やり直し・新しい夜より後の記録だけ数える
   */
  private loadTallies(): void {
    this.catches.clear();
    this.rescues.clear();
    if (this.game.assignId === 0) return;
    const base =
      this.sql.exec<{ id: number | null }>(`SELECT MAX(id) AS id FROM events WHERE kind IN ('assign', 'reset', 'clear')`).toArray()[0]?.id ?? 0;
    for (const r of this.sql.exec<{ kind: string; pid: string | null }>(
      `SELECT kind, pid FROM events WHERE id > ? AND assign_id = ? AND kind IN ('capture', 'release', 'rescue') AND pid IS NOT NULL`,
      base,
      this.game.assignId,
    )) {
      const pid = r.pid!;
      if (r.kind === 'capture') this.catches.set(pid, (this.catches.get(pid) ?? 0) + 1);
      else if (r.kind === 'release') this.catches.set(pid, Math.max(0, (this.catches.get(pid) ?? 0) - 1));
      else this.rescues.set(pid, (this.rescues.get(pid) ?? 0) + 1);
    }
  }

  /** 配役が変わる・やり直す・新しい夜：牢屋まわりの数と長押しを空にする */
  private dropJail(): void {
    this.catches.clear();
    this.rescues.clear();
    this.rescueHolds.clear();
    this.lastRescueAt.clear();
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
    e: { p?: Who | null; other?: Who | null; via?: string | null; data?: Record<string, unknown>; at?: number } = {},
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
        members: [...this.members.values()].map(({ key: _key, ...rest }) => rest),
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
    // 時間が0になっていたら、結果をアプリが決める（合図のついで。合図が止まる前に見る）
    this.finalizeIfDone(Date.now());
    // 光っている人の位置が届かなくなった・ゲームの段階が終わった分を消す（合図のついで）
    this.sweepRuns(Date.now());
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
    // 時間が0になったのに結果がまだなら、先に決める（合図が来ない間に届いた操作でも、結果のあとの状態で受ける）
    if (msg.t !== 'ping' && msg.t !== 'sync') this.finalizeIfDone(now);
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
      case 'enter':
        this.onEnter(ws, att, now);
        return;
      case 'reclaim':
        this.onReclaim(ws, att, msg.name, now);
        return;
      case 'reclaim-stop':
        this.onReclaimStop(ws, att, now);
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
      case 'rescue':
        this.onRescue(att, msg, now);
        return;
      case 'run':
        this.onRun(att, msg, now);
        return;
      case 'sense':
        this.onSense(ws, att, msg.motion, msg.geo);
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 長押しの途中で切れたら、切れた時点で離したことにする（つなぎ直した端末が押し続けていれば、押し始めを送り直してくる）
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.pid) {
      const stillOpen = this.ctx.getWebSockets().some((o) => o !== ws && (o.deserializeAttachment() as Attachment | null)?.pid === att.pid);
      if (!stillOpen) {
        this.endHold(att.pid, Date.now(), 'disconnect');
        this.endRescueHold(att.pid, Date.now());
      }
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

  /**
   * 新しく名簿に入って、そのまま今夜に入る。
   * 名前が名簿のほかの人のものなら、入れずに taken を返す（スマホが「前の◯◯？」と聞く）
   */
  private onJoin(ws: WebSocket, att: Attachment, rawName: unknown, now: number): void {
    const name = normalizeName(rawName);
    if (!name) {
      this.send(ws, { t: 'unknown' });
      return;
    }
    const key = nameKey(name);
    const owner = this.memberByName.get(key);
    if (owner) {
      this.log('taken', { p: owner, at: now, data: { typed: name } });
      this.send(ws, { t: 'taken', name: owner.name });
      return;
    }
    const night = this.game.night;
    const m: Member = {
      pid: crypto.randomUUID(),
      key: randomKey(),
      num: this.game.nextNum,
      name,
      nameKey: key,
      createdAt: now,
      lastAt: now,
      nights: 1,
      firstNight: night,
      lastNight: night,
    };
    this.game.nextNum += 1;
    const p = this.newParticipant(m, att.ua || null, now);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO members (pid, key, num, name, name_key, created_at, last_at, nights, first_night, last_night)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        m.pid,
        m.key,
        m.num,
        m.name,
        m.nameKey,
        m.createdAt,
        m.lastAt,
        night,
        night,
      );
      this.insertParticipant(p);
      this.saveGame();
      this.log('join', { p, at: now, data: { ua: p.ua } });
    });
    this.members.set(m.pid, m);
    this.memberByName.set(m.nameKey, m);
    this.people.set(p.pid, p);
    this.bindTonight(ws, att, p);
  }

  /**
   * スマホに残っている合い鍵で戻る。
   * 今夜に入っていれば今の状態を送る。名簿にだけいれば known（名前のボタン）。どちらでもなければ unknown
   */
  private onResume(ws: WebSocket, att: Attachment, pid: unknown, key: unknown): void {
    const p = typeof pid === 'string' ? this.people.get(pid) : undefined;
    if (p && p.key === key) {
      att.pid = p.pid;
      delete att.mid;
      delete att.reclaim;
      att.host = false;
      ws.serializeAttachment(att);
      if (att.ua && att.ua !== p.ua) {
        p.ua = att.ua;
        this.sql.exec(`UPDATE participants SET ua = ? WHERE pid = ?`, p.ua, p.pid);
      }
      this.sendSnap(ws, att);
      this.sendGlowTo(ws, Date.now());
      this.scheduleHostUpdate();
      return;
    }
    const m = typeof pid === 'string' ? this.members.get(pid) : undefined;
    if (m && m.key === key) {
      this.markKnown(ws, att, m);
      return;
    }
    this.send(ws, { t: 'unknown' });
  }

  /** 名簿の人だと分かった接続に、名前のボタンを出してもらう（今夜にはまだ入れない） */
  private markKnown(ws: WebSocket, att: Attachment, m: Member): void {
    att.mid = m.pid;
    delete att.pid;
    delete att.reclaim;
    att.host = false;
    delete att.syncErr;
    ws.serializeAttachment(att);
    this.send(ws, { t: 'known', name: m.name });
    // 今夜の様子（段階・人数）だけ送る。本人の部分は今夜に入ってから
    this.sendSnap(ws, att);
    this.scheduleHostUpdate();
  }

  /** 名簿の人が、名前のボタンを押して今夜に入る */
  private onEnter(ws: WebSocket, att: Attachment, now: number): void {
    // もう入っている（送り直し・2回押し）：今の状態を送り直すだけ
    const already = att.pid ? this.people.get(att.pid) : undefined;
    if (already) {
      this.bindTonight(ws, att, already);
      return;
    }
    const m = att.mid ? this.members.get(att.mid) : undefined;
    if (!m) {
      this.send(ws, { t: 'unknown' });
      return;
    }
    const p = this.enterTonight(m, att.ua || null, now, 'button');
    this.bindTonight(ws, att, p);
  }

  /**
   * 合い鍵のないスマホで「前の◯◯に戻る」。主催者がつなぐか断るまで、この接続で待つ。
   * 頼みはこの接続（休止をまたいでも残る印）に持たせるので、切れたら消え、つなぎ直したスマホが出し直す
   */
  private onReclaim(ws: WebSocket, att: Attachment, rawName: unknown, now: number): void {
    const name = normalizeName(rawName);
    if (!name) {
      this.send(ws, { t: 'unknown' });
      return;
    }
    const m = this.memberByName.get(nameKey(name));
    if (!m) {
      // その名前の人が名簿にいない（打ち直した等）：ふつうに新しく入る
      this.onJoin(ws, att, name, now);
      return;
    }
    const same = att.reclaim?.mid === m.pid ? att.reclaim : undefined;
    att.reclaim = { rid: same?.rid ?? randomKey().slice(0, 12), mid: m.pid, at: same?.at ?? now };
    delete att.pid;
    delete att.mid;
    att.host = false;
    ws.serializeAttachment(att);
    if (!same) this.log('reclaim-ask', { p: m, at: now, data: { typed: name, ua: att.ua || null } });
    this.send(ws, { t: 'reclaim', status: 'waiting', name: m.name });
    this.scheduleHostUpdate();
  }

  private onReclaimStop(ws: WebSocket, att: Attachment, now: number): void {
    if (!att.reclaim) return;
    const m = this.members.get(att.reclaim.mid);
    delete att.reclaim;
    ws.serializeAttachment(att);
    if (m) this.log('reclaim-stop', { p: m, at: now });
    this.scheduleHostUpdate();
  }

  /** 名簿の人から、今夜の参加者を作る（まだ保存しない） */
  private newParticipant(m: Member, ua: string | null, now: number): Participant {
    return {
      pid: m.pid,
      key: m.key,
      num: m.num,
      name: m.name,
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
      ua,
      rcode: null,
      freeUntil: null,
    };
  }

  private insertParticipant(p: Participant): void {
    this.sql.exec(
      `INSERT INTO participants (pid, key, num, name, role, assign_id, ack_id, removed, joined_at, ua) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, ?, ?)`,
      p.pid,
      p.key,
      p.num,
      p.name,
      p.joinedAt,
      p.ua,
    );
  }

  /**
   * 名簿の人を今夜に入れる（もう入っていれば、その人を返す）。来た夜の数も数える。
   * via＝button（名前のボタン）／reclaim（主催者がつないだ）
   */
  private enterTonight(m: Member, ua: string | null, now: number, via: 'button' | 'reclaim'): Participant {
    const have = this.people.get(m.pid);
    if (have) return have;
    const p = this.newParticipant(m, ua, now);
    const night = this.game.night;
    const firstTonight = m.lastNight !== night;
    this.ctx.storage.transactionSync(() => {
      this.insertParticipant(p);
      this.sql.exec(
        `UPDATE members SET last_at = ?, nights = ?, last_night = ? WHERE pid = ?`,
        now,
        firstTonight ? m.nights + 1 : m.nights,
        night,
        m.pid,
      );
      this.log('enter', { p, at: now, data: { via, ua, nights: firstTonight ? m.nights + 1 : m.nights } });
    });
    m.lastAt = now;
    if (firstTonight) m.nights += 1;
    m.lastNight = night;
    this.people.set(p.pid, p);
    return p;
  }

  /** この接続を今夜の参加者につなぎ、合い鍵と今の状態を送る */
  private bindTonight(ws: WebSocket, att: Attachment, p: Participant): void {
    att.pid = p.pid;
    delete att.mid;
    delete att.reclaim;
    att.host = false;
    ws.serializeAttachment(att);
    this.send(ws, { t: 'welcome', pid: p.pid, key: p.key, num: p.num, name: p.name });
    this.sendSnap(ws, att);
    this.sendGlowTo(ws, Date.now());
    this.scheduleBroadcast();
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
    const { runnerHolds, oni } = this.claimInputs(runner, claim, now);
    return rankCandidates(runnerHolds, oni, now);
  }

  /** 候補を作るのに使う、逃走者の長押しと鬼ごとの手がかり */
  private claimInputs(runner: Participant, claim: Claim, now: number): { runnerHolds: Hold[]; oni: OniSignal[] } {
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
    return { runnerHolds, oni };
  }

  /**
   * 逃走者が選ばなくていいなら、ここで記録する。逃走者が「捕まった」を離したとき（と、離した直後に音の知らせが届いたとき）に呼ぶ。
   * その長押しの間に音を拾ったか、同時に長押ししていた鬼がちょうど1人なら、その鬼で記録。0人・2人以上なら候補を並べたまま
   */
  private tryAutoCapture(runner: Participant, now: number): void {
    if (runner.role !== 'runner' || this.isCaught(runner)) return;
    const c = this.liveClaim(runner.pid, now);
    if (!c) return;
    const { runnerHolds, oni } = this.claimInputs(runner, c, now);
    // まだ押している（離していない）なら、離すまで待つ
    if (runnerHolds.some((h) => h.end === null)) return;
    const pick = autoPick(runnerHolds, oni, now);
    const target = pick ? this.inRound(pick.pid) : null;
    if (!pick || !target || target.role !== 'oni') return;
    const cands = rankCandidates(runnerHolds, oni, now);
    const cand = cands.find((x) => x.pid === pick.pid);
    this.recordCapture(runner, target, c.at, viaOf(cand), {
      auto: true,
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
    // 牢屋から出た直後は捕まらない（「捕まった」は記録しない）
    if (p.role === 'runner' && this.isImmune(p, at)) {
      if (!msg.replay) this.notify(p.pid, 'immune');
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
    if (!h) {
      if (start !== undefined && reason === 'release') this.lateRelease(pid, list, at, start);
      return;
    }
    const known = reason === 'release' || reason === 'capture';
    h.end = Math.max(h.start, Math.min(at, h.start + (known ? HOLD_MAX_MS : HOLD_UNKNOWN_END_MS)));
    this.sql.exec(`UPDATE holds SET end = ? WHERE id = ?`, h.end, h.id);
    const p = this.people.get(pid) ?? null;
    this.log('hold', { p, at: h.end, data: { on: false, ms: h.end - h.start, reason } });
    const now = Date.now();
    this.sendSnapTo(p?.role === 'oni' ? [pid, ...this.openRunners(now)] : [pid]);
    // 逃走者が離した：鬼が1人に決まっていれば、選ばなくても記録する（離した瞬間が分かるときだけ）
    if (p && p.role === 'runner' && reason === 'release') this.tryAutoCapture(p, now);
  }

  /**
   * 切断で先に閉じてしまった長押しの「離した」が、つなぎ直したあとに届いた。
   * 早く離していたなら縮める（延ばしはしない：長い切断を「ずっと押していた」にしない）。逃走者なら、選ばなくていいかをもう一度見る
   */
  private lateRelease(pid: string, list: HoldRec[], at: number, start: number): void {
    const h = list.find((x) => x.end !== null && x.assignId === this.game.assignId && Math.abs(x.start - start) <= HOLD_SAME_MS);
    if (!h) return;
    const end = Math.max(h.start, at);
    if (end < h.end!) {
      h.end = end;
      this.sql.exec(`UPDATE holds SET end = ? WHERE id = ?`, h.end, h.id);
    }
    const p = this.people.get(pid) ?? null;
    if (p && p.role === 'runner') this.tryAutoCapture(p, Date.now());
  }

  /** 鬼のスマホが、誰かの3桁を拾った */
  private onHeard(att: Attachment, rawCode: unknown, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || typeof rawCode !== 'string' || !/^\d{3}$/.test(rawCode)) return;
    // 牢屋の人のスマホが、助けに来た人の「助ける番号」を拾った
    if (p.role === 'runner') return this.onJailHeard(p, rawCode, now);
    if (p.role !== 'oni') return;
    const g = this.game;
    if (g.stage !== 'timer' && g.stage !== 'result') return;
    let target: Participant | null = null;
    for (const q of this.people.values()) {
      if (q.code === rawCode && !q.removed && q.assignId === g.assignId) {
        target = q;
        break;
      }
    }
    // 牢屋の人・解放された直後で捕まらない人の音は、捕獲の手がかりにしない
    if (!target || target.role !== 'runner' || this.isCaught(target) || this.isImmune(target, now)) return;
    const ev = this.evidenceOf(target.pid, p.pid);
    if (ev.heardAt !== null && now - ev.heardAt < HEARD_DEDUPE_MS) return;
    ev.heardAt = now;
    this.saveEvidence(target.pid, p.pid, ev);
    const open = this.liveClaim(target.pid, now) !== null;
    this.log('heard', { p, other: target, at: now, data: { code: rawCode, open, mic: this.game.micMode } });
    if (open) this.sendSnapTo([target.pid]);
    this.notify(p.pid, 'heard', target);
    // 逃走者が離した直後に届いた知らせ（回線の遅れ）：その長押しの音として、決まれば記録する
    if (open) {
      const holds = this.holdsOf(target.pid);
      const last = holds[holds.length - 1];
      if (last && last.end !== null && now - last.end <= HEARD_SLACK_MS) this.tryAutoCapture(target, now);
    }
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
    if (this.isImmune(runner, now)) {
      this.notify(p.pid, 'immune', runner);
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
    // 触られたのが、牢屋から出た直後で捕まらない間だった：記録しない
    if (this.isImmune(p, c.at)) {
      this.claims.delete(p.pid);
      this.sql.exec(`DELETE FROM claims WHERE pid = ?`, p.pid);
      this.log('immune', { p, other: oni, at: now, data: { claimAt: c.at, freeUntil: p.freeUntil } });
      this.notify(p.pid, 'immune');
      this.sendSnapTo([p.pid]);
      return;
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
        `UPDATE participants SET caught_assign = ?, caught_by = ?, caught_at = ?, caught_via = ?, free_until = NULL WHERE pid = ?`,
        assignId,
        oni?.pid ?? null,
        at,
        via,
        runner.pid,
      );
      this.sql.exec(`DELETE FROM claims WHERE pid = ?`, runner.pid);
      this.sql.exec(`DELETE FROM evidence WHERE runner = ?`, runner.pid);
      // どちらの聞き方のときの記録か（あとで比べるため）
      this.log('capture', { p: oni, other: runner, via, at, data: { ...data, mic: this.game.micMode } });
    });
    runner.caughtAssign = assignId;
    runner.caughtBy = oni?.pid ?? null;
    runner.caughtAt = at;
    runner.caughtVia = via;
    runner.freeUntil = null;
    if (oni) this.catches.set(oni.pid, (this.catches.get(oni.pid) ?? 0) + 1);
    this.claims.delete(runner.pid);
    this.evidence.delete(runner.pid);
    this.rescueHolds.delete(runner.pid);
    // 捕まった人が押したまま記録されたら、その長押しはここで終わり
    this.endHold(runner.pid, Date.now(), 'capture');
    // 捕まった人は光らない
    this.endRun(runner.pid, Date.now(), 'caught');
    this.notify(runner.pid, 'caught', oni ?? undefined, via);
    if (oni) this.notify(oni.pid, 'captured', runner, via);
    // 最後の1人が牢屋に入ったら、ゲームを終わらせる（その中で配り直す）
    if (!this.checkAllCaught(Date.now(), at)) this.broadcastNow();
    this.refreshAutoResult();
  }

  // ---------- 牢屋と解放 ----------

  /** 牢屋から出た直後で、まだ捕まらない */
  private isImmune(p: Participant, at: number): boolean {
    return p.role === 'runner' && !this.isCaught(p) && p.freeUntil !== null && at < p.freeUntil;
  }

  /** 牢屋から出られる時間か：ゲームの段階が動いていて、まだ全員は入っていない */
  private rescueOpen(at: number): boolean {
    const g = this.game;
    return g.stage === 'timer' && captureOpenAt(g.timer, at) && g.allCaughtAt == null;
  }

  /** 牢屋の人のスマホが、助けに来た人の「助ける番号」を拾った → その瞬間に解放 */
  private onJailHeard(jailed: Participant, code: string, now: number): void {
    if (!this.isCaught(jailed) || !this.rescueOpen(now)) return;
    const g = this.game;
    let rescuer: Participant | null = null;
    for (const q of this.people.values()) {
      if (q.rcode === code && !q.removed && q.assignId === g.assignId) {
        rescuer = q;
        break;
      }
    }
    if (!rescuer || rescuer.role !== 'runner' || this.isCaught(rescuer)) return;
    if (!this.canRescue(rescuer, now)) return;
    this.freeFromJail(jailed, rescuer, 'sound', now, { code });
  }

  /** 1回の長押しで1人：最後に出してから RESCUE_GAP_MS たっていれば、また出せる */
  private canRescue(rescuer: Participant, now: number): boolean {
    const last = this.lastRescueAt.get(rescuer.pid);
    if (last === undefined) return true;
    if (now - last < RESCUE_GAP_MS) return false;
    // 続けて出すには、出したあとに押し直した長押しが要る（押しっぱなしの音で、そばの2人目が出ないように）
    return now - last > RESCUE_HOLD_KEEP_MS || this.rescueHoldsOf(rescuer.pid, now).some((h) => h.start > last && !h.used);
  }

  private rescueHoldsOf(pid: string, now: number): RescueHold[] {
    const list = this.rescueHolds.get(pid) ?? [];
    // 「離した」が届かないまま残った長押しは、押し始めから HOLD_UNKNOWN_END_MS で離したとみなす（誰も押していないのに出ないように）
    for (const h of list) if (h.end === null && now - h.start > HOLD_UNKNOWN_END_MS) h.end = h.start + HOLD_UNKNOWN_END_MS;
    return list.filter((h) => h.end === null || now - h.end <= RESCUE_HOLD_KEEP_MS);
  }

  /** 「助けて」（牢屋の人）・「助ける」（外の逃走者）の長押し。2人の長押しが重なった瞬間に、牢屋の人が出る */
  private onRescue(att: Attachment, msg: Extract<ClientMsg, { t: 'rescue' }>, now: number): void {
    const p = this.inRound(att.pid);
    if (!p || p.role !== 'runner') return;
    const at = this.pressAt(msg.at, now);
    if (msg.on !== true) {
      this.endRescueHold(p.pid, at, Number.isFinite(Number(msg.start)) ? Number(msg.start) : undefined);
      return;
    }
    const list = this.rescueHoldsOf(p.pid, now);
    const same = list.find((h) => Math.abs(h.start - at) <= HOLD_SAME_MS);
    if (!same) {
      if (!this.rescueOpen(at)) {
        this.notify(p.pid, 'closed');
        return;
      }
      for (const h of list) if (h.end === null) h.end = at;
      list.push({ start: at, end: null });
      this.rescueHolds.set(p.pid, list.slice(-4));
      this.log('rescue-hold', { p, at, data: { on: true, jailed: this.isCaught(p), lagMs: now - at } });
    }
    this.matchRescue(p, at, now);
  }

  private endRescueHold(pid: string, at: number, start?: number): void {
    const list = this.rescueHolds.get(pid);
    if (!list) return;
    const h = list.find((x) => x.end === null && (start === undefined || Math.abs(x.start - start) <= HOLD_SAME_MS));
    if (!h) return;
    h.end = Math.max(h.start, at);
    this.log('rescue-hold', { p: this.people.get(pid) ?? null, at: h.end, data: { on: false, ms: h.end - h.start } });
  }

  /** 押した人の長押しと、相手側（牢屋の人なら外の逃走者、外なら牢屋の人）の長押しが重なっていれば、牢屋の人を1人出す */
  private matchRescue(p: Participant, at: number, now: number): void {
    if (!this.rescueOpen(now)) return;
    const mine = this.rescueHoldsOf(p.pid, now).find((h) => Math.abs(h.start - at) <= HOLD_SAME_MS);
    if (!mine || mine.used) return;
    // 押している途中の長押しは、まだ終わっていない（押し始めの時刻がサーバーの今に寄せられて同じ値になっても、重なりとみなす）
    const overlaps = (h: RescueHold) => h.start <= (mine.end ?? Infinity) && (h.end ?? Infinity) >= mine.start;
    const g = this.game;
    const iAmJailed = this.isCaught(p);
    if (!iAmJailed && !this.canRescue(p, now)) return;
    const others = [...this.people.values()]
      .filter((q) => q.pid !== p.pid && !q.removed && q.assignId === g.assignId && q.role === 'runner' && this.isCaught(q) !== iAmJailed)
      .map((q) => ({ q, h: this.rescueHoldsOf(q.pid, now).filter((h) => !h.used && overlaps(h)).sort((a, b) => a.start - b.start)[0] }))
      .filter((x) => x.h && (iAmJailed ? this.canRescue(x.q, now) : true))
      .sort((a, b) => a.h!.start - b.h!.start);
    const hit = others[0];
    if (!hit) return;
    const [jailed, rescuer] = iAmJailed ? [p, hit.q] : [hit.q, p];
    mine.used = true;
    hit.h!.used = true;
    this.freeFromJail(jailed, rescuer, 'together', now, {});
  }

  /** 牢屋から出す。保存してから、本人と助けた人に知らせ、全員の人数を配り直す */
  private freeFromJail(jailed: Participant, rescuer: Participant | null, via: RescueVia, now: number, data: Record<string, unknown>): void {
    if (!this.isCaught(jailed)) return;
    const freeUntil = now + RESCUE_IMMUNE_MS;
    const prev = { by: jailed.caughtBy, at: jailed.caughtAt, jailMs: jailed.caughtAt !== null ? now - jailed.caughtAt : null };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE participants SET caught_assign = 0, caught_by = NULL, caught_at = NULL, caught_via = NULL, free_until = ? WHERE pid = ?`,
        freeUntil,
        jailed.pid,
      );
      this.sql.exec(`DELETE FROM claims WHERE pid = ?`, jailed.pid);
      this.log('rescue', { p: rescuer, other: jailed, via, at: now, data: { ...prev, ...data, freeUntil } });
    });
    jailed.caughtAssign = 0;
    jailed.caughtBy = null;
    jailed.caughtAt = null;
    jailed.caughtVia = null;
    jailed.freeUntil = freeUntil;
    this.claims.delete(jailed.pid);
    this.rescueHolds.delete(jailed.pid);
    if (rescuer) {
      this.lastRescueAt.set(rescuer.pid, now);
      this.rescues.set(rescuer.pid, (this.rescues.get(rescuer.pid) ?? 0) + 1);
      // 1回の長押しで1人：助ける人の長押しはここで終わり（押し続けても、次の人は出ない）
      for (const h of this.rescueHolds.get(rescuer.pid) ?? []) {
        if (h.end === null) h.end = now;
        if (h.start <= now) h.used = true;
      }
    }
    this.notify(jailed.pid, 'freed', rescuer ?? undefined, via);
    if (rescuer) this.notify(rescuer.pid, 'saved', jailed, via);
    this.broadcastNow();
  }

  /**
   * 逃走者が全員同時に牢屋に入ったか。入ったら記録して、ゲームの段階を2秒後に終わらせる（全員の画面が同じ瞬間に切り替わる）。
   * ゲームの段階が終わったあと（終わり際の捕獲が遅れて記録された）なら、時間はそのままで鬼の勝ちだけ決まる。
   * 配り直したら true
   */
  private checkAllCaught(now: number, at: number): boolean {
    const g = this.game;
    if (g.stage !== 'timer' && g.stage !== 'result') return false;
    if (g.allCaughtAt != null || !everyoneJailed(this.gameView().counts)) return false;
    let timer = g.timer;
    let ended = false;
    if (g.stage === 'timer' && timer) {
      const pos = positionAt(timer, now);
      if (pos.kind === 'phase' && pos.index === CAPTURE_PHASE_INDEX) {
        if (timer.status === 'running') {
          timer = skipPhase(timer, now);
        } else {
          // 止めている間に全員が入った：再開したら「広場に戻るまで」から
          timer = { ...timer, pausedElapsed: cumulative(timer.durations)[CAPTURE_PHASE_INDEX + 1] };
        }
        ended = true;
      }
    }
    this.commit({ allCaughtAt: Math.min(at, now), timer });
    this.log('all-caught', { at: now, data: { runner: g.counts.runner, endsGame: ended } });
    this.sweepRuns(now);
    this.broadcastNow();
    return true;
  }

  /** 時間が0になったら、結果をアプリが決める（主催者が押す前に） */
  private finalizeIfDone(now: number): void {
    const g = this.game;
    if (g.stage !== 'timer' || !g.timer || !isDone(g.timer, now)) return;
    const winner = decideWinner(this.gameView());
    this.log('result', { at: now, data: { winner, auto: true, caught: this.caughtCount(), allCaughtAt: g.allCaughtAt ?? null } });
    this.commit({ stage: 'result', result: winner, resultAuto: true });
    this.broadcastNow();
  }

  /** アプリが決めた結果のあとに、終わり際の捕獲が遅れて記録されたら、決め直す */
  private refreshAutoResult(): void {
    const g = this.game;
    if (g.stage !== 'result' || g.resultAuto !== true) return;
    const winner = decideWinner(this.gameView());
    if (winner === g.result) return;
    this.log('result', { at: Date.now(), data: { winner, auto: true, changed: true } });
    this.commit({ result: winner });
    this.broadcastNow();
  }

  // ---------- 走ると光る ----------

  /** 光ってよいのは、ゲームの段階（追跡が始まってから終わるまで）が動いている間だけ。捕獲と同じ決まり（終了直後の猶予は無し） */
  private glowOpen(at: number): boolean {
    const g = this.game;
    return g.stage === 'timer' && captureOpenAt(g.timer, at);
  }

  /** 走っている（位置つき）・止まった。光ってよい人・段階でなければ、光っている分を消して捨てる */
  private onRun(att: Attachment, msg: Extract<ClientMsg, { t: 'run' }>, now: number): void {
    const p = this.inRound(att.pid);
    if (!p) return;
    if (this.isCaught(p)) return this.endRun(p.pid, now, 'caught');
    if (!this.glowOpen(now)) return this.endRun(p.pid, now, 'closed');
    if (msg.on !== true) return this.endRun(p.pid, now, 'stop');
    const pos = cleanPos(msg.lat, msg.lon, msg.acc);
    let r = this.runs.get(p.pid);
    if (!r) {
      r = { pid: p.pid, since: now, at: now, lat: null, lon: null, acc: null, path: [], dist: 0, lastPathAt: -Infinity };
      this.runs.set(p.pid, r);
      this.log('run', { p, at: now, data: pos ? { lat: pos.lat, lon: pos.lon, acc: pos.acc } : { pos: false } });
      // 新しく光った人は、待たずに配る（ほかの人の更新をまとめて待っている途中でも）
      this.flushGlowSoon(true);
    } else {
      this.flushGlowSoon(false);
    }
    r.at = now;
    if (pos) {
      if (r.lat !== null && r.lon !== null) r.dist += distanceM({ lat: r.lat, lon: r.lon }, pos);
      r.lat = pos.lat;
      r.lon = pos.lon;
      r.acc = pos.acc;
      if (now - r.lastPathAt >= RUN_PATH_EVERY_MS) {
        r.path.push([pos.lat, pos.lon, Math.round((now - r.since) / 100) / 10]);
        r.lastPathAt = now;
      }
    }
  }

  /** 光っている人を消して、記録に残す。at は消えた時刻（位置が届かなくなったときは最後に届いた時刻） */
  private endRun(pid: string, at: number, reason: RunEnd): void {
    const r = this.runs.get(pid);
    if (!r) return;
    this.runs.delete(pid);
    const end = reason === 'stale' ? r.at : at;
    if (r.lat !== null && r.lon !== null && r.path[r.path.length - 1]?.[2] !== Math.round((r.at - r.since) / 100) / 10) {
      r.path.push([r.lat, r.lon, Math.round((r.at - r.since) / 100) / 10]);
    }
    this.log('run-end', {
      p: this.people.get(pid) ?? null,
      at: end,
      data: { reason, ms: Math.max(0, end - r.since), m: Math.round(r.dist), path: r.path },
    });
    this.flushGlowSoon(true);
  }

  /** 位置が届かなくなった人・光ってよくなくなった人を消す（合図・主催者の操作のたびに見る） */
  private sweepRuns(now: number): void {
    if (this.runs.size === 0) return;
    const open = this.glowOpen(now);
    // ゲームの段階が時間で終わったのなら、消えた時刻は段階の終わり（合図のついでに見るので、最大2秒遅れて気づく）
    let closedAt = now;
    const t = this.game.timer;
    if (!open && this.game.stage === 'timer' && t?.status === 'running') {
      const end = boundaryTimes(t)?.[CAPTURE_PHASE_INDEX + 1];
      if (end !== undefined && end <= now) closedAt = end;
    }
    for (const r of [...this.runs.values()]) {
      const p = this.inRound(r.pid);
      if (!open) this.endRun(r.pid, Math.max(r.since, closedAt), 'closed');
      else if (!p) this.endRun(r.pid, now, 'out');
      else if (this.isCaught(p)) this.endRun(r.pid, now, 'caught');
      else if (now - r.at > RUN_STALE_MS) this.endRun(r.pid, now, 'stale');
    }
  }

  /** 光の知らせを配る。urgent（光った・消えた）は次の一瞬で、位置の更新だけなら GLOW_BROADCAST_MS ごとにまとめて */
  private flushGlowSoon(urgent: boolean): void {
    if (this.glowTimer) {
      if (!urgent) return;
      clearTimeout(this.glowTimer);
    }
    this.glowTimer = setTimeout(
      () => {
        this.glowTimer = null;
        this.broadcastGlow();
      },
      urgent ? 0 : GLOW_BROADCAST_MS,
    );
  }

  private glowMsg(now: number): ServerMsg {
    const runs: GlowEntry[] = [];
    for (const r of [...this.runs.values()].sort((a, b) => a.since - b.since)) {
      const p = this.people.get(r.pid);
      if (!p) continue;
      runs.push({ num: p.num, name: p.name, lat: r.lat, lon: r.lon, acc: r.acc, since: r.since, at: r.at });
    }
    return { t: 'glow', s: now, runs };
  }

  /** 全員（参加者・見学・主催者）に同じ1本を送る */
  private broadcastGlow(): void {
    const msg = JSON.stringify(this.glowMsg(Date.now()));
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.pid && !att?.host) continue;
      try {
        ws.send(msg);
      } catch {
        // 閉じかけの接続は、つなぎ直したときに送り直す
      }
    }
    this.scheduleHostUpdate();
  }

  /** つないだ・つなぎ直した人に、いま光っている人を送る（ゲームの段階の間だけ。消えた光が画面に残らないよう、空でも送る） */
  private sendGlowTo(ws: WebSocket, now: number): void {
    if (this.runs.size === 0 && !this.glowOpen(now)) return;
    this.send(ws, this.glowMsg(now));
  }

  /** このスマホで、動きのセンサー・位置が使えるか */
  private onSense(ws: WebSocket, att: Attachment, motion: unknown, geo: unknown): void {
    const ok = (v: unknown): v is SenseState => v === 'off' || v === 'ok' || v === 'denied' || v === 'unsupported' || v === 'error';
    if (!ok(motion) || !ok(geo)) return;
    if (att.sense?.motion === motion && att.sense?.geo === geo) return;
    att.sense = { motion, geo };
    ws.serializeAttachment(att);
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
    delete att.mid;
    delete att.reclaim;
    ws.serializeAttachment(att);
    this.sendSnap(ws, att);
    this.sendGlowTo(ws, Date.now());
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
      this.endRun(p.pid, now, 'out');
      // 外にいた最後の逃走者が外されたら、全員が牢屋にいることになる
      if (!this.checkAllCaught(now, now)) this.broadcastNow();
      this.refreshAutoResult();
      return;
    }

    // 「前の◯◯に戻りたい」人をつなぐ・断る。1人ずつの操作なので版番号を見ない
    if (op === 'link') {
      const rid = typeof msg.rid === 'string' ? msg.rid : '';
      const target = this.ctx.getWebSockets().find((s) => (s.deserializeAttachment() as Attachment | null)?.reclaim?.rid === rid);
      const tatt = target ? ((target.deserializeAttachment() as Attachment | null) ?? {}) : null;
      const m = tatt?.reclaim ? this.members.get(tatt.reclaim.mid) : undefined;
      if (!target || !tatt || !m) return this.reject(ws, att, op, 'not-found');
      if (msg.ok !== true) {
        delete tatt.reclaim;
        target.serializeAttachment(tatt);
        this.log('reclaim-no', { p: m, at: now });
        this.send(target, { t: 'reclaim', status: 'denied', name: m.name });
        this.broadcastNow();
        return;
      }
      this.log('reclaim-ok', { p: m, at: now, data: { ua: tatt.ua || null } });
      const p = this.enterTonight(m, tatt.ua || null, now, 'reclaim');
      this.bindTonight(target, tatt, p);
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
      if (by) this.catches.set(by.pid, Math.max(0, (this.catches.get(by.pid) ?? 0) - 1));
      this.rescueHolds.delete(runner.pid);
      // 取り消した捕獲で「全員が牢屋」になっていたなら、それも取り消す（時間はそのまま。結果はアプリが決め直す）
      if (g.allCaughtAt != null && !everyoneJailed(this.gameView().counts)) {
        this.commit({ allCaughtAt: null });
        this.log('all-caught-undo', { at: now, data: { runner: runner.pid } });
      }
      this.notify(runner.pid, 'released', by ?? undefined);
      if (by) this.notify(by.pid, 'released', runner);
      this.broadcastNow();
      this.refreshAutoResult();
      return;
    }

    // 古い画面からの操作（同時押し・二度押し）は断って、今の状態を送り直す。
    // 勝ちの手直しだけは見ない：時間が0になった瞬間にアプリが結果を決めて版番号が進むので、同じ瞬間に押した手直しが断られないように（あとから押したほうが残る）
    if (this.hostCv < 0) this.hostCv = this.game.cv;
    if (op !== 'result' && (msg.cv > this.game.cv || msg.cv < this.hostCv)) return this.reject(ws, att, op, 'stale');

    const g = this.game;
    const timerDone = g.stage === 'timer' && g.timer !== null && isDone(g.timer, now);

    switch (op) {
      case 'assign': {
        if (!(g.stage === 'lobby' || g.stage === 'assigned' || g.stage === 'result' || g.stage === 'ended' || timerDone)) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const active = [...this.people.values()].filter((p) => !p.removed);
        if (active.length === 0) return this.reject(ws, att, op, 'no-participants');
        const roles = assignRoles(
          active.map((p) => p.pid),
          ROLES.map((r) => ({ ...r, weight: g.ratio[r.id] })),
        );
        // 1人に2つ：捕まったとき鳴らす番号（code）と、牢屋の人を助けるとき鳴らす番号（rcode）。部屋の中で重ならない
        const codes = pickCodes(active.length * 2);
        const codeOf = new Map(active.map((p, i) => [p.pid, codes[i]] as const));
        const rcodeOf = new Map(active.map((p, i) => [p.pid, codes[active.length + i]] as const));
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
          resultAuto: false,
          allCaughtAt: null,
          counts: { oni, runner },
        };
        this.ctx.storage.transactionSync(() => {
          for (const [pid, role] of roles) {
            this.sql.exec(
              `UPDATE participants SET role = ?, assign_id = ?, ack_id = 0, code = ?, rcode = ?, free_until = NULL WHERE pid = ?`,
              role,
              nextAssignId,
              codeOf.get(pid) ?? null,
              rcodeOf.get(pid) ?? null,
              pid,
            );
          }
          this.sql.exec(
            `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            JSON.stringify(next),
          );
          this.dropClaims();
          this.dropJail();
          this.game = next;
          for (const [pid, role] of roles) {
            const p = this.people.get(pid)!;
            this.log('role', { p, at: now, data: { role, code: codeOf.get(pid), rcode: rcodeOf.get(pid) } });
          }
          this.log('assign', { at: now, data: { oni, runner, reroll: isReroll } });
        });
        for (const [pid, role] of roles) {
          const p = this.people.get(pid)!;
          p.role = role;
          p.assignId = nextAssignId;
          p.ackId = 0;
          p.code = codeOf.get(pid) ?? null;
          p.rcode = rcodeOf.get(pid) ?? null;
          p.freeUntil = null;
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
        // 時間が0になってアプリが結果を出したあとも、やり直せる
        if (g.stage !== 'timer' && !(g.stage === 'result' && g.assignId > 0)) return this.reject(ws, att, op, 'not-allowed');
        // やり直しなので、この配役の捕獲と押した記録も消す（ログには残る）
        this.ctx.storage.transactionSync(() => {
          this.log('reset', { at: now });
          this.sql.exec(
            `UPDATE participants SET caught_assign = 0, caught_by = NULL, caught_at = NULL, caught_via = NULL WHERE caught_assign = ?`,
            g.assignId,
          );
          this.sql.exec(`UPDATE participants SET free_until = NULL`);
          this.dropClaims();
        });
        this.dropJail();
        for (const p of this.people.values()) {
          p.freeUntil = null;
          if (p.caughtAssign === g.assignId) {
            p.caughtAssign = 0;
            p.caughtBy = null;
            p.caughtAt = null;
            p.caughtVia = null;
          }
        }
        this.commit({ stage: 'assigned', timer: null, result: null, allCaughtAt: null, resultAuto: false });
        break;
      }
      case 'end': {
        // 夜を終える：試合中はできない（時間が0になったあとは押せる）。すでに終わっていれば何もしない
        if (g.stage === 'ended' || (g.stage === 'timer' && !timerDone)) return this.reject(ws, att, op, 'not-allowed');
        // 答え待ちの「捕まった」も長押しも閉じる（最後の画面に捕獲の板が残らないように）
        this.ctx.storage.transactionSync(() => {
          this.log('end', { at: now, data: { round: g.round } });
          this.dropClaims();
        });
        this.commit({ stage: 'ended', timer: null });
        break;
      }
      case 'mission': {
        // ミッション成功：牢屋の人を出す。ゲームの段階の間だけ（止めている間も押せる）。全員が入ったあとは出せない
        const n = msg.n === undefined || msg.n === null ? null : Number(msg.n);
        if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 999)) return this.reject(ws, att, op, 'bad-input');
        const pos = g.stage === 'timer' && g.timer ? positionAt(g.timer, now) : null;
        if (!pos || pos.kind !== 'phase' || pos.index !== CAPTURE_PHASE_INDEX || g.allCaughtAt != null) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const jailed = [...this.people.values()]
          .filter((q) => !q.removed && q.assignId === g.assignId && q.role === 'runner' && this.isCaught(q))
          .sort((a, b) => (a.caughtAt ?? 0) - (b.caughtAt ?? 0) || a.num - b.num);
        if (jailed.length === 0) return this.reject(ws, att, op, 'nobody-jailed');
        const out = n === null ? jailed : jailed.slice(0, n);
        // 二度押し（ほかの主催者画面の同時押し）で2回出さないよう、版番号を進める
        this.commit({});
        this.log('mission', { at: now, data: { n, released: out.length, jailed: jailed.length } });
        for (const q of out) this.freeFromJail(q, null, 'mission', now, { mission: n ?? 'all' });
        break;
      }
      case 'result': {
        if (msg.winner !== 'oni' && msg.winner !== 'runner') return this.reject(ws, att, op, 'bad-input');
        if (!(g.stage === 'result' || timerDone)) return this.reject(ws, att, op, 'not-allowed');
        this.log('result', { at: now, data: { winner: msg.winner, caught: this.caughtCount(), auto: false } });
        this.commit({ stage: 'result', result: msg.winner, resultAuto: false });
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
      case 'ratio': {
        if (!(g.stage === 'lobby' || g.stage === 'assigned' || g.stage === 'result')) {
          return this.reject(ws, att, op, 'not-allowed');
        }
        const r = msg.ratio;
        if (!isValidRatio(r)) return this.reject(ws, att, op, 'bad-input');
        this.commit({ ratio: { oni: r.oni, runner: r.runner } });
        this.log('ratio', { at: now, data: { ratio: r } });
        break;
      }
      case 'mic': {
        // いつでも切り替えられる（どちらがいいか試すため）。試合中に変えても、そのときから全員のスマホに効く
        if (!isMicMode(msg.mic)) return this.reject(ws, att, op, 'bad-input');
        if (msg.mic === g.micMode) break;
        this.commit({ micMode: msg.mic });
        this.log('mic', { at: now, data: { mic: msg.mic } });
        break;
      }
      case 'clear': {
        // 新しい夜を始める（部屋を空にする）：今夜の参加者を全員外し、配役前に戻す。
        // 名簿・時間の設定・名簿の番号は残す。試合中はできない
        if (g.stage === 'timer' && !timerDone) return this.reject(ws, att, op, 'not-allowed');
        const next: GameState = {
          ...g,
          round: 0,
          assignId: 0,
          stage: 'lobby',
          cv: g.cv + 1,
          timer: null,
          result: null,
          resultAuto: false,
          allCaughtAt: null,
          counts: { oni: 0, runner: 0 },
          night: g.night + 1,
          nightAt: now,
        };
        this.dropJail();
        this.ctx.storage.transactionSync(() => {
          this.log('clear', { at: now, data: { people: this.people.size, night: next.night } });
          this.sql.exec(`DELETE FROM participants`);
          this.dropClaims();
          this.sql.exec(
            `INSERT INTO meta (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            JSON.stringify(next),
          );
        });
        this.people.clear();
        this.game = next;
        // つながっている参加者には、名前のボタンを出してもらう（名簿にいない人だけ入室画面へ）
        for (const sock of this.ctx.getWebSockets()) {
          const a = sock.deserializeAttachment() as Attachment | null;
          if (!a?.pid) continue;
          const m = this.members.get(a.pid);
          if (m) {
            this.markKnown(sock, a, m);
          } else {
            delete a.pid;
            delete a.syncErr;
            sock.serializeAttachment(a);
            this.send(sock, { t: 'unknown' });
          }
        }
        break;
      }
      default:
        return this.reject(ws, att, op, 'bad-input');
    }
    this.hostCv = this.game.cv;
    // 一時停止・やり直し・配役・部屋を空にする・次に進む → 光っている人は消す（ゲームの段階が動いている間だけ光る）
    this.sweepRuns(now);
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

  private runnerCount(): number {
    const g = this.game;
    if (g.assignId === 0) return g.counts.runner;
    let n = 0;
    for (const p of this.people.values()) if (!p.removed && p.assignId === g.assignId && p.role === 'runner') n++;
    return n;
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
      // 逃走者の数は、いま配役に残っている人（途中で外された人は数えない。全員が牢屋かを正しく見るため）
      counts: { oni: g.counts.oni, runner: this.runnerCount(), total: this.activePeople().length, caught: this.caughtCount() },
      result: g.result,
      durations: g.durations,
      nightAt: g.nightAt,
      ratio: g.ratio,
      allCaughtAt: g.allCaughtAt ?? null,
      resultAuto: g.resultAuto === true,
      micMode: g.micMode,
    };
  }

  private meView(pid: string, now = Date.now()): MeView | undefined {
    const p = this.people.get(pid);
    if (!p) return undefined;
    const g = this.game;
    const inCurrent = p.assignId === g.assignId && g.assignId > 0;
    const live = inCurrent && !p.removed;
    const by = p.caughtBy ? this.people.get(p.caughtBy) : undefined;
    const catches = live && p.role === 'oni' ? (this.catches.get(p.pid) ?? 0) : 0;
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
      rcode: live && p.role === 'runner' ? p.rcode : null,
      freeUntil: live && p.role === 'runner' && !this.isCaught(p) && p.freeUntil !== null && p.freeUntil > now ? p.freeUntil : null,
      rescues: live && p.role === 'runner' ? (this.rescues.get(p.pid) ?? 0) : 0,
    };
  }

  private hostCapture(): HostCapture | null {
    const g = this.game;
    if (g.assignId === 0) return null;
    const now = Date.now();
    const inRound = [...this.people.values()].filter((p) => !p.removed && p.assignId === g.assignId && p.role);
    const catches = this.catches;
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
            freeUntil: !caught && p.freeUntil !== null && p.freeUntil > now ? p.freeUntil : null,
            rescues: this.rescues.get(p.pid) ?? 0,
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
    /** 名簿の人として（今夜に入っていなくても）つながっている pid */
    const present = new Set<string>();
    const asks: { rid: string; mid: string; at: number }[] = [];
    /** 走ると光る：今の配役に入っていてつながっている人のうち、動きのセンサー・位置が使える人 */
    const glowIn = new Set<string>();
    const motionOk = new Set<string>();
    const geoOk = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.reclaim) asks.push(a.reclaim);
      if (a?.mid) present.add(a.mid);
      if (!a?.pid) continue;
      connected.add(a.pid);
      present.add(a.pid);
      if (typeof a.syncErr === 'number' && a.syncErr <= SYNC_OK_MS) synced.add(a.pid);
      if (this.inRound(a.pid)) {
        glowIn.add(a.pid);
        if (a.sense?.motion === 'ok') motionOk.add(a.pid);
        if (a.sense?.geo === 'ok') geoOk.add(a.pid);
      }
    }
    const reclaims = asks
      .map((r) => ({ r, m: this.members.get(r.mid) }))
      .filter((x): x is { r: (typeof asks)[number]; m: Member } => x.m !== undefined)
      .sort((x, y) => x.r.at - y.r.at)
      .map(({ r, m }) => ({ rid: r.rid, name: m.name, at: r.at, here: present.has(m.pid) }));
    const g = this.game;
    const inAssign = g.assignId > 0 ? active.filter((p) => p.assignId === g.assignId && p.role !== null) : [];
    const groups = new Map<string, Participant[]>();
    for (const p of active) {
      const k = nameKey(p.name);
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
        .map((ps) => ({ name: ps[0].name, people: ps.map((p) => ({ pid: p.pid, num: p.num, joinedAt: p.joinedAt })) })),
      capture: this.hostCapture(),
      reclaims,
      registry: this.members.size,
      glow: { total: glowIn.size, motion: motionOk.size, geo: geoOk.size, lit: this.runs.size },
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

  private notify(pid: string, kind: NoticeKind, other?: Participant, via?: CaptureVia | RescueVia): void {
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

/** 走ると光る：届いた位置を確かめて丸める（緯度・経度は小数5桁＝約1m、誤差は m の整数）。おかしければ null */
function cleanPos(lat: unknown, lon: unknown, acc: unknown): { lat: number; lon: number; acc: number } | null {
  const a = Number(lat);
  const o = Number(lon);
  const c = Number(acc);
  if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 90 || Math.abs(o) > 180) return null;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  return { lat: r5(a), lon: r5(o), acc: Number.isFinite(c) && c >= 0 ? Math.min(9_999, Math.round(c)) : 9_999 };
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
