/**
 * 公開先で、つなぎ直しが「誰の判断で・いつ・なぜ」起きたかを1本ずつ記録する診断。
 * 主催者の操作はしない。入室したまま DIAG_MIN 分放っておき、切れた接続を全部分類する。
 *
 *   LIVE_URL=https://urafess.<サブドメイン>.workers.dev DIAG_N=300 DIAG_MIN=6 \
 *     npx vitest run --config vitest.sim.config.ts sim/diag.test.ts
 *
 * 分類：
 * - 回線側：サーバーか途中の回線が閉じた（閉じコードと理由を残す）
 * - アプリ：つながりかけで止まった（8秒）／問い合わせに返事が来ない（8秒）／試合中の合図が途切れた（6秒）／その他
 *
 * 部屋を試合中（配役済み）にすると、合図（hb）の届き方も測る。サーバーが出した間隔（hb に入っているサーバーの時刻）と、
 * 受け取り側での間を分けて出すので、遅れがサーバー（アラーム）側か回線側かを見分けられる。主催者の操作は外のブラウザから。
 * 結果は sim/diag-report.md（DIAG_REPORT で名前を変えられる）
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore, type WebSocketLike } from '../src/client/core/game-client';

const BASE = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const N = Number(process.env.DIAG_N ?? 300);
const MINUTES = Number(process.env.DIAG_MIN ?? 6);
const GAME = (process.env.DIAG_GAME ?? `diag-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const WS_URL = `${BASE.replace(/^http/, 'ws')}/api/game/${GAME}/ws`;
const PROGRESS = join(process.cwd(), 'sim', 'diag-progress.log');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' })} +${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`;
  appendFileSync(PROGRESS, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

type Cause = 'network' | 'connect-timeout' | 'pong-timeout' | 'silence' | 'replaced' | 'stop' | 'other';

interface SockRec {
  bot: number;
  seq: number;
  createdAt: number;
  openAt?: number;
  closedAt?: number;
  cause?: Cause;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  lastMsgAt?: number;
  oldestPendingPingMs?: number;
  detail?: string;
  /** 試合中の合図（hb）を最後に受け取った時刻と、合図どうしの最長の間 */
  lastHbAt?: number;
  maxHbGap?: number;
}

const recs: SockRec[] = [];
const rtts: number[] = [];
/** 合図（hb）：サーバーが送った時刻 s ごとに、各接続が受け取った時刻 */
const hbRecv = new Map<number, number[]>();
/** 同じ接続で、合図と合図の間（受け取り側の時計） */
const hbGaps: number[] = [];
let firstHbAt: number | null = null;

class DiagSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly inner: WebSocket;
  private closedByUs = false;
  private readonly pingSentAt = new Map<number, number>();
  readonly rec: SockRec;

  constructor(url: string, bot: number, seq: number) {
    this.rec = { bot, seq, createdAt: Date.now() };
    recs.push(this.rec);
    this.inner = new WebSocket(url);
    this.inner.onopen = () => {
      this.rec.openAt = Date.now();
      this.onopen?.({});
    };
    this.inner.onmessage = (ev) => {
      const now = Date.now();
      this.rec.lastMsgAt = now;
      const data = String(ev.data);
      if (data.startsWith('{"t":"pong"')) {
        try {
          const m = JSON.parse(data) as { id: number };
          const sent = this.pingSentAt.get(m.id);
          if (sent !== undefined) {
            rtts.push(now - sent);
            this.pingSentAt.delete(m.id);
          }
        } catch {
          // 無視
        }
      } else if (data.startsWith('{"t":"hb"')) {
        try {
          const m = JSON.parse(data) as { s: number };
          const list = hbRecv.get(m.s);
          if (list) list.push(now);
          else hbRecv.set(m.s, [now]);
        } catch {
          // 無視
        }
        if (firstHbAt === null) {
          firstHbAt = now;
          log('合図（hb）が届き始めた＝試合中の見張りが始まった');
        }
        if (this.rec.lastHbAt !== undefined) {
          const g = now - this.rec.lastHbAt;
          hbGaps.push(g);
          if (g > (this.rec.maxHbGap ?? 0)) this.rec.maxHbGap = g;
        }
        this.rec.lastHbAt = now;
      }
      this.onmessage?.({ data });
    };
    this.inner.onclose = (ev) => {
      if (this.rec.closedAt !== undefined) return;
      this.rec.closedAt = Date.now();
      this.rec.cause = 'network';
      this.rec.code = ev.code;
      this.rec.reason = ev.reason;
      this.rec.wasClean = ev.wasClean;
      logClose(this.rec);
      this.onclose?.({});
    };
    this.inner.onerror = () => this.onerror?.({});
  }

  get readyState(): number {
    return this.closedByUs ? 3 : this.inner.readyState;
  }

  send(data: string): void {
    if (data.startsWith('{"t":"ping"')) {
      try {
        const m = JSON.parse(data) as { id: number };
        this.pingSentAt.set(m.id, Date.now());
      } catch {
        // 無視
      }
    }
    this.inner.send(data);
  }

  close(): void {
    if (this.rec.closedAt === undefined) {
      const now = Date.now();
      this.rec.closedAt = now;
      const stack = new Error().stack ?? '';
      const state = this.inner.readyState;
      const pending = [...this.pingSentAt.values()];
      if (pending.length) this.rec.oldestPendingPingMs = now - Math.min(...pending);
      let cause: Cause = 'other';
      if (/\bstop\b/.test(stack)) cause = 'stop';
      else if (/\btick\b/.test(stack)) {
        // tick で切るのは：つながりかけで8秒／問い合わせに8秒返事なし／試合中の合図が6秒途切れた（見る順も同じ）
        if (state === 0) cause = 'connect-timeout';
        else if ((this.rec.oldestPendingPingMs ?? 0) >= 7_900) cause = 'pong-timeout';
        else cause = 'silence';
      } else if (/\bconnect\b/.test(stack)) cause = 'replaced';
      this.rec.cause = cause;
      if (cause === 'other') this.rec.detail = stack.split('\n').slice(2, 6).map((s) => s.trim()).join(' | ');
      if (cause !== 'stop') logClose(this.rec);
    }
    this.closedByUs = true;
    try {
      this.inner.close();
    } catch {
      // 閉じている
    }
  }
}

function logClose(r: SockRec): void {
  const age = ((r.closedAt! - (r.openAt ?? r.createdAt)) / 1000).toFixed(1);
  const quiet = r.lastMsgAt ? ((r.closedAt! - r.lastMsgAt) / 1000).toFixed(1) : '—';
  const what =
    r.cause === 'network'
      ? `回線側が閉じた code=${r.code} reason="${r.reason ?? ''}" clean=${r.wasClean}`
      : r.cause === 'pong-timeout'
        ? `アプリが切った：問い合わせに返事なし（いちばん古い問い合わせから ${((r.oldestPendingPingMs ?? 0) / 1000).toFixed(1)}秒）`
        : r.cause === 'silence'
          ? `アプリが切った：試合中の合図が途切れた（最後の合図から ${r.lastHbAt ? ((r.closedAt! - r.lastHbAt) / 1000).toFixed(1) : '—'}秒、それまでの合図どうしの最長の間 ${((r.maxHbGap ?? 0) / 1000).toFixed(1)}秒）`
        : r.cause === 'connect-timeout'
          ? 'アプリが切った：つながりかけのまま8秒'
          : r.cause === 'replaced'
            ? 'アプリが切った：つなぎ直しで古い接続を捨てた'
            : `その他 ${r.detail ?? ''}`;
  log(`bot${r.bot} 接続#${r.seq}：${what}（つながって ${age}秒、最後に受け取ってから ${quiet}秒）`);
}

const clients: GameClient[] = [];

describe.skipIf(!BASE)(`つなぎ直しの診断（${N}人、${MINUTES}分、部屋 ${GAME}）`, () => {
  afterAll(() => {
    for (const c of clients) c.stop();
    const closes = recs.filter((r) => r.closedAt !== undefined && r.cause !== 'stop');
    const by = (c: Cause) => closes.filter((r) => r.cause === c);
    const codes = new Map<string, number>();
    for (const r of by('network')) {
      const k = `code=${r.code}${r.reason ? ` "${r.reason}"` : ''}`;
      codes.set(k, (codes.get(k) ?? 0) + 1);
    }
    // 10秒ごとの切れた数（同じ瞬間に大勢が切れたか＝サーバーや入口の出来事か）
    const buckets = new Map<number, number>();
    for (const r of closes) {
      const b = Math.floor((r.closedAt! - t0) / 10_000) * 10;
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    const sorted = [...rtts].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
    const pct = (xs: number[], q: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
    };
    const stats = (xs: number[]) => `中央値 ${pct(xs, 0.5)}ms / 95% ${pct(xs, 0.95)}ms / 99% ${pct(xs, 0.99)}ms / 最大 ${xs.length ? Math.max(...xs) : NaN}ms`;
    // 合図：サーバーが出した間隔（サーバーの時計）と、受け取り側での間（受け取り側の時計）を分けて見る
    const sent = [...hbRecv.keys()].sort((a, b) => a - b);
    const sentGaps = sent.slice(1).map((s, i) => s - sent[i]);
    // 同じ合図を全員が受け取るまでの幅（最初に受け取った人から最後の人まで）。半分以上が受け取った合図だけ
    const spreads = [...hbRecv.values()].filter((l) => l.length >= N / 2).map((l) => Math.max(...l) - Math.min(...l));
    const sockGapOver = recs.filter((r) => (r.maxHbGap ?? 0) > 6_000).length;
    const lines = [
      `つなぎ直しの診断（${BASE}、部屋 ${GAME}、${N}人、${MINUTES}分、${new Date().toISOString()}）`,
      `- 接続の本数：${recs.length}（最初の ${N}本を除くと ${recs.length - N}本のつなぎ直し）`,
      `- 切れた接続：${closes.length}本`,
      `  - 回線側が閉じた：${by('network').length}本 ${[...codes].map(([k, v]) => `${k}×${v}`).join('、')}`,
      `  - アプリ：返事なし ${by('pong-timeout').length}本、試合中の合図が途切れた ${by('silence').length}本、つながりかけで止まった ${by('connect-timeout').length}本、古い接続を捨てた ${by('replaced').length}本、その他 ${by('other').length}本`,
      `- 10秒ごとの切れた数：${[...buckets].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}s:${v}`).join(' ')}`,
      `- 往復時間（問い合わせ ${sorted.length}回）：中央値 ${at(0.5)}ms / 95% ${at(0.95)}ms / 99% ${at(0.99)}ms / 最大 ${sorted[sorted.length - 1]}ms、2秒超 ${sorted.filter((x) => x > 2000).length}回、8秒超 ${sorted.filter((x) => x > 8000).length}回`,
      firstHbAt === null
        ? '- 合図（hb）：届かなかった（試合に入っていない）'
        : `- 合図（hb）：見張りの時間 ${((Date.now() - firstHbAt) / 1000).toFixed(0)}秒、サーバーが出した合図 ${sent.length}回`,
      ...(firstHbAt === null
        ? []
        : [
            `  - サーバーが出した間隔（サーバーの時計）：${stats(sentGaps)}、3秒超 ${sentGaps.filter((g) => g > 3_000).length}回、6秒超 ${sentGaps.filter((g) => g > 6_000).length}回`,
            `  - 同じ合図を全員が受け取るまでの幅：${stats(spreads)}`,
            `  - 受け取り側で合図と合図の間：${stats(hbGaps)}、4秒超 ${hbGaps.filter((g) => g > 4_000).length}回、6秒超 ${hbGaps.filter((g) => g > 6_000).length}回（6秒超があった接続 ${sockGapOver}本）`,
          ]),
      '',
    ];
    const text = lines.join('\n');
    writeFileSync(join(process.cwd(), 'sim', process.env.DIAG_REPORT ?? 'diag-report.md'), text);
    process.stdout.write(`\n${text}\n`);
  });

  it('入室したまま放っておき、切れた接続を全部分類する', async () => {
    writeFileSync(PROGRESS, '');
    log(`開始：${BASE} の部屋「${GAME}」に ${N}人つなぎ、${MINUTES}分放っておく`);
    const seqs = new Array<number>(N).fill(0);
    for (let i = 0; i < N; i++) {
      const c = new GameClient(
        {
          url: WS_URL,
          gameId: GAME,
          now: () => Date.now(),
          storage: memoryStore(),
          createSocket: (url) => new DiagSocket(url, i, ++seqs[i]),
        },
        { kind: 'player' },
      );
      clients.push(c);
      c.join(`diag${String(i).padStart(3, '0')}`);
      c.start();
      if (i % 25 === 24) await sleep(150);
    }
    const end = Date.now() + 180_000;
    while (Date.now() < end && !clients.every((c) => c.state.identity && c.state.phase === 'ready')) await sleep(200);
    log(`入室：${clients.filter((c) => c.state.identity).length}/${N}人`);

    const stopAt = Date.now() + MINUTES * 60_000;
    while (Date.now() < stopAt) {
      await sleep(30_000);
      const closed = recs.filter((r) => r.closedAt !== undefined && r.cause !== 'stop').length;
      log(`経過：つながっている ${clients.filter((c) => c.state.online).length}/${N}人、接続の本数 ${recs.length}、切れた ${closed}本`);
    }
    expect(clients.length).toBe(N);
  }, 60 * 60_000);
});
