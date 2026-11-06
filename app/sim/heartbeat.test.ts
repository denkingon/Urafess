/**
 * 試合中の合図（hb）が「配役からタイマーが0になるまで」だけ出ることの確認。手元に本物のサーバー（wrangler dev）を立てる。
 *
 * - 配役済み・タイマーの間は、2秒ごとに合図が届く
 * - 時間が0になったら、主催者が結果を押す前でも合図が止まる（結果待ちのまま放っておかれても、リクエストを使わない）
 * - 合図が止まっても、参加者は切断とみなさない（つなぎ直しが起きない）
 * - 次のラウンドの配役で、合図がまた始まる
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { boundaryTimes } from '../src/shared/schedule';

const PORT = Number(process.env.HB_PORT ?? 8798);
const TOKEN = 'hbtoken';
const GAME = `hb${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 1段階1秒（設定できる最短）。開始の2秒後から4秒で0になる */
const SHORT = [1_000, 1_000, 1_000, 1_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`時間切れ：${label}`);
}

let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-hb-')), '--var', `HOST_TOKEN:${TOKEN}`],
    { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
      if (r.ok) return;
    } catch {
      // まだ立ち上がっていない
    }
    await sleep(300);
  }
  throw new Error('サーバーが立ち上がらない');
}

/** 受け取った合図：受け取った時刻（手元）と、合図に入っているサーバーの時刻 */
interface Hb {
  at: number;
  s: number;
}

interface Watched {
  client: GameClient;
  hbs: Hb[];
  sockets: number;
}

function watched(kind: 'player' | 'host'): Watched {
  const w: Watched = { client: null as unknown as GameClient, hbs: [], sockets: 0 };
  w.client = new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: () => Date.now(),
      storage: memoryStore(),
      createSocket: (u) => {
        w.sockets++;
        const ws = new WebSocket(u);
        ws.addEventListener('message', (ev) => {
          const data = String(ev.data);
          if (!data.startsWith('{"t":"hb"')) return;
          w.hbs.push({ at: Date.now(), s: (JSON.parse(data) as { s: number }).s });
        });
        return ws as never;
      },
    },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  w.client.start();
  return w;
}

const all: Watched[] = [];

describe('試合中の合図は、配役からタイマーが0になるまで', () => {
  afterAll(async () => {
    for (const w of all) w.client.stop();
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // 終わっている
      }
    }
    await sleep(500);
  });

  it('0になったら結果を押す前でも合図が止まり、つなぎ直しも起きない。次の配役でまた始まる', async () => {
    await startServer();
    const host = watched('host');
    all.push(host);
    await waitFor('主催者がつながる', () => host.client.state.phase === 'ready');
    const players = ['あお', 'みどり'].map((name) => {
      const w = watched('player');
      w.client.join(name);
      all.push(w);
      return w;
    });
    await waitFor('2人が入室', () => players.every((p) => p.client.state.phase === 'ready' && p.client.state.me) && host.client.state.host?.total === 2);

    host.client.command('durations', { durations: SHORT });
    await waitFor('時間の設定', () => JSON.stringify(host.client.state.game?.durations) === JSON.stringify(SHORT));

    // 待合室では合図は出ない
    await sleep(3_000);
    expect(players[0].hbs.length).toBe(0);

    // 配役済み：2秒ごとに届く
    host.client.command('assign');
    await waitFor('配役', () => players.every((p) => p.client.state.me?.role));
    const assignedAt = Date.now();
    await sleep(5_000);
    expect(players[0].hbs.filter((h) => h.at >= assignedAt).length).toBeGreaterThanOrEqual(2);

    // 開始：0になるまで届き、0になったら止まる（結果はまだ押さない）
    const socketsBefore = players.map((p) => p.sockets);
    host.client.command('start');
    await waitFor('開始', () => host.client.state.game?.stage === 'timer' && !!host.client.state.game.timer);
    const timer = host.client.state.game!.timer!;
    const endServer = boundaryTimes(timer)!.at(-1)!; // 0になる時刻（サーバーの時計）
    const offset = host.client.serverNow()! - Date.now();
    const endLocal = endServer - offset; // 同じ瞬間（手元の時計）
    await sleep(Math.max(0, endLocal - Date.now()) + 10_000); // 0のあと10秒、結果を押さずに待つ

    const during = players[0].hbs.filter((h) => h.at >= assignedAt);
    expect(during.length).toBeGreaterThanOrEqual(3);
    // サーバーが合図を出したのは、すべて0になる前
    expect(Math.max(...during.map((h) => h.s))).toBeLessThan(endServer);
    // 0の3秒後から10秒後まで、誰にも合図が届いていない
    for (const w of all) expect(w.hbs.filter((h) => h.at >= endLocal + 3_000).length).toBe(0);
    // 合図が止まっても、参加者はつなぎ直していない（見張りも0でやめている）
    expect(players.map((p) => p.sockets)).toEqual(socketsBefore);
    expect(players.every((p) => p.client.state.online)).toBe(true);
    expect(host.client.state.game?.stage).toBe('timer');

    // 結果を押しても止まったまま。次のラウンドの配役で、また始まる
    host.client.command('result', { winner: 'oni' });
    await waitFor('結果', () => host.client.state.game?.stage === 'result');
    const nextAt = Date.now();
    host.client.command('assign');
    await waitFor('次の配役', () => host.client.state.game?.stage === 'assigned' && (host.client.state.game?.round ?? 0) >= 2);
    await waitFor('合図がまた届く', () => players[0].hbs.some((h) => h.at >= nextAt), 6_000);
  }, 120_000);
});
