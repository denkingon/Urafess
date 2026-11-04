/**
 * 「部屋を空にする」の確認。手元に本物のサーバー（wrangler dev）を立て、3人が入室・配役されたあと
 * 主催者が部屋を空にすると、全員が入室画面に戻り、主催者画面の参加が0になり、入り直せることを確かめる。
 * 試合中は空にできないことも確かめる。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.CLEAR_PORT ?? 8797);
const TOKEN = 'cleartoken';
const GAME = `clear${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-clear-')), '--var', `HOST_TOKEN:${TOKEN}`],
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
  return c;
}

const clients: GameClient[] = [];

describe('部屋を空にする', () => {
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

  it('全員が入室画面に戻り、主催者画面の参加が0になり、入り直せる。試合中は空にできない', async () => {
    await startServer();
    const host = client('host');
    clients.push(host);
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');

    const players = ['あお', 'みどり', 'あか'].map((name) => {
      const c = client('player');
      c.join(name);
      clients.push(c);
      return c;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.identity) && host.state.host?.total === 3);

    // 試合中は空にできない
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('clear');
    await waitFor('試合中の「空にする」は断られる', () => host.state.lastReject?.op === 'clear');
    expect(host.state.lastReject?.reason).toBe('not-allowed');
    expect(host.state.host?.total).toBe(3);

    // 試合を止めて（リセット）から空にする
    host.command('reset');
    await waitFor('リセット', () => host.state.game?.stage === 'assigned');
    host.command('clear');
    await waitFor(
      '全員が入室画面に戻る',
      () => players.every((p) => p.state.phase === 'need-name' && p.state.identity === null) && host.state.host?.total === 0,
    );
    expect(host.state.game?.stage).toBe('lobby');
    expect(host.state.game?.round).toBe(0);
    expect(host.state.game?.counts.total).toBe(0);

    // 入り直せる（番号は1から）
    players[0].join('あお');
    await waitFor('入り直し', () => players[0].state.identity !== null && host.state.host?.total === 1);
    expect(players[0].state.identity?.num).toBe(1);
  }, 120_000);
});
