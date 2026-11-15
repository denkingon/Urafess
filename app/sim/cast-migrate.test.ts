/**
 * 「配役をいじる」を入れる前の版（希望の版）から入れ替える確認。同じ保存場所で、前の版 → この版。
 * 前の版の app/ を OLD_APP_DIR に置いて流す（無ければ飛ばす）。例：
 *   git worktree add /tmp/urafess-old origin/main && (cd /tmp/urafess-old/app && npm ci && npm run build)
 *   OLD_APP_DIR=/tmp/urafess-old/app npx vitest run --config vitest.sim.config.ts sim/cast-migrate.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const OLD = process.env.OLD_APP_DIR ?? '';
const PORT = Number(process.env.CAST_MIGRATE_PORT ?? 8815);
const TOKEN = 'wishmigratetoken';
const GAME = `castmig${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-wish-migrate-'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`時間切れ：${label}`);
}

let server: ChildProcess | null = null;
const clients: GameClient[] = [];

async function startServer(cwd: string): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--var', `HOST_TOKEN:${TOKEN}`],
    { cwd, detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  const end = Date.now() + 120_000;
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

async function stopServer(): Promise<void> {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // 終わっている
    }
  }
  server = null;
  await sleep(1_500);
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

describe.skipIf(!OLD)('配役をいじる版に入れ替える', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
  });

  it('入れ替えても役・希望はそのまま。指名と印はまだ無く、すぐ使える', async () => {
    await startServer(OLD);
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = Array.from({ length: 10 }, (_, i) => {
      const p = client('player');
      p.join(`にん${i}`);
      return p;
    });
    await waitFor('10人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);
    // 前の版は、主催者の一覧を送ってこない。指名を送っても断られるだけ（壊れない）
    expect(host.state.host!.cast).toBeUndefined();
    for (const p of players) p.wish('runner');
    await waitFor('希望が届く', () => host.state.game?.wishes?.runner === 10);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const before = players.map((p) => ({ pid: p.state.identity!.pid, role: p.state.me!.role, miss: p.state.me!.wishMiss }));

    await stopServer();
    await startServer(process.cwd());
    await waitFor('主催者がつなぎ直す', () => host.state.online && host.state.host?.cast?.length === 10, 60_000);
    await waitFor('全員がつなぎ直す', () => players.every((p) => p.state.online && p.state.phase === 'ready' && p.state.me?.hostCast === false), 60_000);
    players.forEach((p, i) => {
      expect(p.state.identity?.pid).toBe(before[i].pid);
      expect(p.state.me?.role).toBe(before[i].role);
      expect(p.state.me?.wish).toBe('runner');
      expect(p.state.me?.wishMiss).toBe(before[i].miss);
    });
    expect(host.state.game!.stage).toBe('assigned');
    for (const c of host.state.host!.cast!) {
      expect(c.pin).toBeNull();
      expect(c.tags).toBeUndefined();
      expect(c.role).toBe(before.find((b) => b.pid === c.pid)!.role);
    }

    // すぐ使える：鬼の1人を逃走者へ動かす（希望どおりになるので、外れた回数は 0）。印も付く
    const oni = players.find((p) => p.state.me!.role === 'oni')!;
    host.command('cast', { pids: [oni.state.identity!.pid], role: 'runner' });
    await waitFor('動いた', () => oni.state.me!.role === 'runner');
    expect(oni.state.me!.wishMiss).toBe(0);
    expect(host.state.game!.counts).toMatchObject({ oni: 2, runner: 8 });
    host.command('tag', { pids: [oni.state.identity!.pid], tag: '速い', on: true });
    await waitFor('印', () => host.state.host!.cast!.find((c) => c.pid === oni.state.identity!.pid)?.tags?.[0] === '速い');

    // もう一度入れ替えても残る
    await stopServer();
    await startServer(process.cwd());
    await waitFor('主催者がつなぎ直す', () => host.state.online && host.state.host?.cast?.length === 10, 60_000);
    const again = host.state.host!.cast!.find((c) => c.pid === oni.state.identity!.pid)!;
    expect(again).toMatchObject({ pin: 'runner', role: 'runner', tags: ['速い'] });
  }, 300_000);
});
