import { DurableObject } from 'cloudflare:workers';
import PAGE from './probe.html';
import type { Env } from './room';

/**
 * 夜テスト（/api/probe）。本番と同じ夜に、何台かのスマホを持ってキャンパスを歩き、
 * 位置の精度と更新間隔・Cloudflare までの往復・回線（IP と AS）・接続の切れ目を記録して、1か所に集める。
 *
 * /api/probe                 … 記録する画面（Service Worker を通らないよう /api/ の下に置く）
 * /api/probe/who             … 今の回線（IP・AS・Cloudflare の拠点・TCP の往復）
 * /api/probe/ping            … 往復を測るだけ（Worker だけで返す）
 * /api/probe/ws?s=回         … 接続の切れ目を見る WebSocket（サーバーが2秒ごとに合図を出す）
 * /api/probe/log?s=回        … 記録を送る（POST）
 * /api/probe/summary?s=回    … 集計（画面の「結果」とClaudeの分析用）
 * /api/probe/data?s=回       … 生データ（JSON）
 * /api/probe/clear?s=回      … 記録を消す（POST）
 *
 * 記録は「テスト回」ごとに1つの Durable Object（SQLite）に入る。回のIDを知っている人だけが見られる。
 */

const SESSION_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{6,40}$/;
const HB_EVERY_MS = 2_000;
const MAX_BODY = 512 * 1024;
const MAX_EVENTS_PER_POST = 3_000;

const noStore = { 'cache-control': 'no-store' };

export async function handleProbe(request: Request, env: Env, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/api\/probe\/?/, '');
  if (rest === '') {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', ...noStore } });
  }
  if (rest === 'ping') return Response.json({ s: Date.now() }, { headers: noStore });
  if (rest === 'who') return Response.json(who(request), { headers: noStore });

  if (['ws', 'log', 'summary', 'data', 'clear'].includes(rest)) {
    const session = url.searchParams.get('s') ?? '';
    if (!SESSION_RE.test(session)) return new Response('bad session', { status: 400 });
    const stub = env.PROBE.get(env.PROBE.idFromName(session), { locationHint: 'apac-ne' });
    return stub.fetch(request);
  }
  return new Response('not found', { status: 404 });
}

/** 今の回線。キャンパスの Wi-Fi（慶應は AS38635）か、携帯会社かを見分けるのに使う */
function who(request: Request) {
  const cf = (request.cf ?? {}) as Record<string, unknown>;
  return {
    s: Date.now(),
    ip: request.headers.get('cf-connecting-ip') ?? '',
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    org: typeof cf.asOrganization === 'string' ? cf.asOrganization : null,
    colo: typeof cf.colo === 'string' ? cf.colo : null,
    country: typeof cf.country === 'string' ? cf.country : null,
    http: typeof cf.httpProtocol === 'string' ? cf.httpProtocol : null,
    tcpRtt: typeof cf.clientTcpRtt === 'number' ? cf.clientTcpRtt : null,
  };
}

type EventRow = {
  d: string;
  q: number;
  t: number;
  k: string;
  v: string;
};

type DeviceRow = {
  d: string;
  label: string;
  ua: string;
  first: number;
  last: number;
};

type Ev = { d: string; q: number; t: number; k: string } & Record<string, unknown>;

export class ProbeHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS events (d TEXT NOT NULL, q INTEGER NOT NULL, t INTEGER NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (d, q))`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS devices (d TEXT PRIMARY KEY, label TEXT NOT NULL, ua TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL)`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rest = url.pathname.replace(/^\/api\/probe\/?/, '');
    switch (rest) {
      case 'ws':
        return this.openSocket(request, url);
      case 'log':
        return this.log(request);
      case 'summary':
        return Response.json(summarize(this.devices(), this.events()), { headers: noStore });
      case 'data': {
        const body = JSON.stringify({ devices: this.devices(), events: this.events() });
        const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', ...noStore };
        if (url.searchParams.get('download')) {
          headers['content-disposition'] = `attachment; filename="urafess-probe-${url.searchParams.get('s')}.json"`;
        }
        return new Response(body, { headers });
      }
      case 'clear':
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        this.sql.exec(`DELETE FROM events`);
        this.sql.exec(`DELETE FROM devices`);
        return Response.json({ ok: true }, { headers: noStore });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ---------- 接続の切れ目 ----------

  private async openSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const device = url.searchParams.get('d') ?? '';
    if (!DEVICE_RE.test(device)) return new Response('bad device', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ d: device });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HB_EVERY_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** つながっている間だけ、2秒ごとに全員へ同じ合図を送る（アプリ本体の合図と同じ間隔） */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const msg = JSON.stringify({ t: 'hb', s: Date.now() });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // 閉じかけ
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + HB_EVERY_MS);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 512) return;
    try {
      const m = JSON.parse(raw) as { t?: string; id?: number };
      if (m.t === 'p') ws.send(JSON.stringify({ t: 'q', id: Number(m.id), s: Date.now() }));
    } catch {
      // 壊れた送信は捨てる
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // すでに閉じている
    }
  }

  // ---------- 記録 ----------

  private async log(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response('too large', { status: 413 });
    let body: { d?: unknown; label?: unknown; ua?: unknown; events?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return new Response('bad json', { status: 400 });
    }
    const device = typeof body.d === 'string' && DEVICE_RE.test(body.d) ? body.d : null;
    if (!device || !Array.isArray(body.events)) return new Response('bad body', { status: 400 });
    const label = typeof body.label === 'string' ? body.label.slice(0, 40) : '';
    const ua = typeof body.ua === 'string' ? body.ua.slice(0, 300) : '';
    const events = body.events.slice(0, MAX_EVENTS_PER_POST);
    const now = Date.now();
    let stored = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO devices (d, label, ua, first, last) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(d) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN devices.label ELSE excluded.label END, ua = CASE WHEN excluded.ua = '' THEN devices.ua ELSE excluded.ua END, last = excluded.last`,
        device,
        label,
        ua,
        now,
        now,
      );
      for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        const { q, t, k, ...v } = e as Record<string, unknown>;
        if (!Number.isInteger(q) || typeof t !== 'number' || typeof k !== 'string' || k.length > 20) continue;
        const json = JSON.stringify(v);
        if (json.length > 2_000) continue;
        this.sql.exec(`INSERT OR IGNORE INTO events (d, q, t, k, v) VALUES (?, ?, ?, ?, ?)`, device, q, t, k, json);
        stored += 1;
      }
    });
    return Response.json({ ok: true, stored }, { headers: noStore });
  }

  private devices(): DeviceRow[] {
    return this.sql.exec<DeviceRow>(`SELECT d, label, ua, first, last FROM devices ORDER BY first`).toArray();
  }

  private events(): Ev[] {
    const out: Ev[] = [];
    for (const r of this.sql.exec<EventRow>(`SELECT d, q, t, k, v FROM events ORDER BY d, q`)) {
      let v: Record<string, unknown> = {};
      try {
        v = JSON.parse(r.v) as Record<string, unknown>;
      } catch {
        // 壊れた行は中身なしで残す
      }
      out.push({ ...v, d: r.d, q: r.q, t: r.t, k: r.k });
    }
    return out;
  }
}

// ---------- 集計 ----------

function quantile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return Math.round(s[i] * 10) / 10;
}

function share(xs: number[], ok: (x: number) => boolean): number | null {
  if (xs.length === 0) return null;
  return Math.round((xs.filter(ok).length / xs.length) * 100);
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 回線の名前：本人が選んだ回線（セルラー／keiomobile2 など）と、実際の AS をつなげたもの */
function netKey(label: string, org: string | null): string {
  return org ? `${label}｜${org}` : label;
}

export function summarize(devices: DeviceRow[], events: Ev[]) {
  const byDevice = new Map<string, Ev[]>();
  for (const e of events) byDevice.set(e.d, [...(byDevice.get(e.d) ?? []), e]);

  const perNet = new Map<string, { rtt: number[]; idle: Map<number, number[]>; wsRtt: number[]; closes: number; gaps: number[] }>();
  const netOf = (key: string) => {
    let n = perNet.get(key);
    if (!n) {
      n = { rtt: [], idle: new Map(), wsRtt: [], closes: 0, gaps: [] };
      perNet.set(key, n);
    }
    return n;
  };

  const deviceSummaries = devices.map((dev) => {
    const evs = (byDevice.get(dev.d) ?? []).sort((a, b) => a.q - b.q);
    let label = '不明';
    let org: string | null = null;
    const acc: number[] = [];
    const intervals: number[] = [];
    let lastFixTs: number | null = null;
    const rtt: number[] = [];
    const wsRtt: number[] = [];
    const gaps: number[] = [];
    let opens = 0;
    let closes = 0;
    let stale = 0;
    let hiddenMs = 0;
    let hiddenAt: number | null = null;
    let geoErrors = 0;
    let marks = 0;
    const orgs = new Set<string>();
    const labels = new Set<string>();
    for (const e of evs) {
      switch (e.k) {
        case 'start':
        case 'net':
          if (typeof e.net === 'string') {
            label = e.net;
            labels.add(label);
          }
          break;
        case 'who':
          if (typeof e.org === 'string') {
            org = e.org;
            orgs.add(org);
          }
          break;
        case 'fix': {
          const a = num(e.acc);
          if (a !== null) acc.push(a);
          const ts = num(e.ts);
          if (ts !== null) {
            if (lastFixTs !== null && ts > lastFixTs) intervals.push((ts - lastFixTs) / 1000);
            lastFixTs = ts;
          }
          break;
        }
        case 'ping': {
          const r = num(e.rtt);
          if (r !== null && e.ok !== false) {
            rtt.push(r);
            netOf(netKey(label, org)).rtt.push(r);
          }
          break;
        }
        case 'sleep': {
          // 電波の眠りの測定：無通信の秒数ごとの往復
          const r = num(e.rtt);
          const idle = num(e.idle);
          if (r !== null && idle !== null && e.ok !== false) {
            const n = netOf(netKey(label, org));
            n.idle.set(idle, [...(n.idle.get(idle) ?? []), r]);
          }
          break;
        }
        case 'wsping': {
          const r = num(e.rtt);
          if (r !== null) {
            wsRtt.push(r);
            netOf(netKey(label, org)).wsRtt.push(r);
          }
          break;
        }
        case 'ws':
          if (e.ev === 'open') opens += 1;
          // close＝回線側・ブラウザが閉じた、stale＝合図が10秒届かず画面側で張り直した（見えない切断）
          if (e.ev === 'close' || e.ev === 'stale') {
            closes += 1;
            if (e.ev === 'stale') stale += 1;
            netOf(netKey(label, org)).closes += 1;
          }
          break;
        case 'hbgap': {
          const g = num(e.gap);
          if (g !== null) {
            gaps.push(g / 1000);
            netOf(netKey(label, org)).gaps.push(g / 1000);
          }
          break;
        }
        case 'vis':
          if (e.state === 'hidden') hiddenAt = e.t;
          else if (e.state === 'visible' && hiddenAt !== null) {
            hiddenMs += e.t - hiddenAt;
            hiddenAt = null;
          }
          break;
        case 'geoerr':
          geoErrors += 1;
          break;
        case 'mark':
          marks += 1;
          break;
      }
    }
    const first = evs.length ? evs[0].t : dev.first;
    const last = evs.length ? evs[evs.length - 1].t : dev.last;
    return {
      device: dev.d,
      label: dev.label,
      ua: dev.ua,
      minutes: Math.round((last - first) / 6000) / 10,
      networks: [...labels],
      orgs: [...orgs],
      fixes: acc.length,
      fixIntervalSec: { median: quantile(intervals, 0.5), p90: quantile(intervals, 0.9) },
      accuracyM: { median: quantile(acc, 0.5), p90: quantile(acc, 0.9), within10mPct: share(acc, (x) => x <= 10), within20mPct: share(acc, (x) => x <= 20) },
      httpRttMs: { n: rtt.length, median: quantile(rtt, 0.5), p90: quantile(rtt, 0.9) },
      wsRttMs: { n: wsRtt.length, median: quantile(wsRtt, 0.5), p90: quantile(wsRtt, 0.9) },
      wsOpens: opens,
      wsCloses: closes,
      wsSilentDrops: stale,
      hbGapsOver4s: gaps.length,
      longestSilenceSec: gaps.length ? Math.max(...gaps) : 0,
      hiddenSec: Math.round(hiddenMs / 1000),
      geoErrors,
      marks,
    };
  });

  const networks = [...perNet.entries()].map(([key, n]) => ({
    network: key,
    httpRttMs: { n: n.rtt.length, median: quantile(n.rtt, 0.5), p90: quantile(n.rtt, 0.9) },
    httpRttByIdleSec: Object.fromEntries(
      [...n.idle.entries()].sort((a, b) => a[0] - b[0]).map(([idle, xs]) => [String(idle), { n: xs.length, median: quantile(xs, 0.5) }]),
    ),
    wsRttMs: { n: n.wsRtt.length, median: quantile(n.wsRtt, 0.5), p90: quantile(n.wsRtt, 0.9) },
    wsCloses: n.closes,
    hbGapsOver4s: n.gaps.length,
  }));

  return { generatedAt: Date.now(), devices: deviceSummaries, networks };
}
