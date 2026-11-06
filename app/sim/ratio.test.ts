/**
 * 鬼：逃走者の割合を主催者が変える確認。手元に本物のサーバー（wrangler dev）を立てる。
 *
 * - 変えた割合は全員に届き、次の配役（引き直しも）から効く
 * - 不正な値は断る。試合中は変えられない
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.RATIO_PORT ?? 8804);
const TOKEN = 'ratiotoken';
const GAME = `ratio${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで20秒・追跡開始まで20秒・ゲーム60秒・広場に戻るまで20秒 */
const DUR = [20_000, 20_000, 60_000, 20_000];

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
const clients: GameClient[] = [];

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-ratio-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

function client(kind: 'player' | 'host'): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage: memoryStore(), createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  return c;
}

describe('主催者が鬼と逃走者の割合を変える', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // 終わっている
      }
    }
    await sleep(500);
  });

  it('割合が全員に届き、次の配役から効く。不正な値と試合中は断る', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = Array.from({ length: 10 }, (_, i) => {
      const p = client('player');
      p.join(`にん${i}`);
      return p;
    });
    await waitFor('10人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);
    expect(host.state.game!.ratio).toEqual({ oni: 3, runner: 7 });

    host.command('ratio', { ratio: { oni: 1, runner: 4 } });
    await waitFor('割合が全員に届く', () => players.every((p) => p.state.game?.ratio?.oni === 1 && p.state.game?.ratio?.runner === 4));

    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    expect(host.state.game!.counts).toMatchObject({ oni: 2, runner: 8 });
    expect(players.filter((p) => p.state.me!.role === 'oni')).toHaveLength(2);

    // 配役後（引き直し前）に変えても、いまの役は変わらず、引き直しから効く
    host.command('ratio', { ratio: { oni: 1, runner: 1 } });
    await waitFor('割合が変わる', () => host.state.game?.ratio?.runner === 1);
    expect(host.state.game!.counts).toMatchObject({ oni: 2, runner: 8 });
    host.command('assign');
    await waitFor('引き直し', () => host.state.game?.assignId === 2);
    expect(host.state.game!.counts).toMatchObject({ oni: 5, runner: 5 });

    // 不正な値は断る
    for (const bad of [{ oni: 0, runner: 5 }, { oni: 2.5, runner: 5 }, { oni: 100, runner: 1 }]) {
      host.command('ratio', { ratio: bad });
      await waitFor('不正な値は断られる', () => host.state.lastReject?.op === 'ratio' && host.state.lastReject.reason === 'bad-input');
      expect(host.state.game!.ratio).toEqual({ oni: 1, runner: 1 });
      host.command('ratio', { ratio: { oni: 1, runner: 1 } }); // lastReject を進めるための有効な操作
      await sleep(200);
    }

    // 試合中は変えられない
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('ratio', { ratio: { oni: 1, runner: 9 } });
    await waitFor('試合中は断られる', () => host.state.lastReject?.op === 'ratio' && host.state.lastReject.reason === 'not-allowed');
    expect(host.state.game!.ratio).toEqual({ oni: 1, runner: 1 });
  });
});
