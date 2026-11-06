/**
 * 「夜を終える」の確認。手元に本物のサーバー（wrangler dev）を立て、3人が入室・配役されたあと
 * 主催者が部屋を空にすると、全員が入室画面に戻り、主催者画面の参加が0になり、入り直せることを確かめる。
 * 試合中は空にできないことも確かめる。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.END_PORT ?? 8798);
const TOKEN = 'endtoken';
const GAME = `end${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-end-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

describe('夜を終える', () => {
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

  it('試合中は終えられず、終えると全員が最後の段階になる。配役で再開できる', async () => {
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

    // 試合中は終えられない
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('end');
    await waitFor('試合中の「夜を終える」は断られる', () => host.state.lastReject?.op === 'end');
    expect(host.state.lastReject?.reason).toBe('not-allowed');
    expect(host.state.game?.stage).toBe('timer');

    // やり直して（リセット）から終える：全員の段階が ended になり、参加者はそのまま残る
    host.command('reset');
    await waitFor('リセット', () => host.state.game?.stage === 'assigned');
    host.command('end');
    await waitFor('全員が最後の段階', () => host.state.game?.stage === 'ended' && players.every((p) => p.state.game?.stage === 'ended'));
    expect(host.state.host?.total).toBe(3);

    // 終えたあとは勝ち負けも開始もできない
    host.command('start');
    await waitFor('開始は断られる', () => host.state.lastReject?.op === 'start');
    expect(host.state.game?.stage).toBe('ended');

    // 配役で再開できる（次のラウンド）
    host.command('assign');
    await waitFor('再開', () => host.state.game?.stage === 'assigned' && players.every((p) => p.state.me?.role));
    expect(host.state.game?.round).toBe(2);
  }, 120_000);
});
