/**
 * 配役の希望を入れる前の版から入れ替えたときの確認。前の版で入って配役まで済んだ部屋が、
 * 入れ替えたあともそのまま続き（役は変わらない）、次の配役から希望が使えるかを、本物のサーバーで確かめる。
 *
 * 前の版の app/ を OLD_APP_DIR に置いて流す（無ければ飛ばす）。例：
 *   git worktree add /tmp/urafess-old <前の版のコミット>
 *   ln -s "$PWD/node_modules" /tmp/urafess-old/app/node_modules
 *   OLD_APP_DIR=/tmp/urafess-old/app npx vitest run --config vitest.sim.config.ts sim/wish-migrate.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const OLD = process.env.OLD_APP_DIR ?? '';
const PORT = Number(process.env.WISH_MIGRATE_PORT ?? 8813);
const TOKEN = 'wishmigratetoken';
const GAME = `wishmig${Date.now()}`;
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

describe.skipIf(!OLD)('配役の希望を入れる前の版から入れ替える', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
  });

  it('入れ替えても役はそのまま。希望はまだ無く、次の配役から使える', async () => {
    // --- 前の版：10人が入って配役 ---
    await startServer(OLD);
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = Array.from({ length: 10 }, (_, i) => {
      const p = client('player');
      p.join(`にん${i}`);
      return p;
    });
    await waitFor('10人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);
    // 前の版は、決め方も希望も送ってこない。希望を送っても何も起きない（壊れない）
    expect(host.state.game!.wishMode).toBeUndefined();
    expect(players[0].state.me!.wish).toBeUndefined();
    players[0].wish('runner');
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const before = players.map((p) => ({ pid: p.state.identity!.pid, role: p.state.me!.role }));

    // --- 希望の版に入れ替える（同じ保存場所） ---
    await stopServer();
    await startServer(process.cwd());
    await waitFor('全員がつなぎ直す', () => players.every((p) => p.state.online && p.state.phase === 'ready' && p.state.game?.wishMode === 'wish'), 60_000);
    await waitFor('主催者がつなぎ直す', () => host.state.online && host.state.game?.wishMode === 'wish' && host.state.host?.total === 10, 60_000);
    players.forEach((p, i) => {
      expect(p.state.identity?.pid).toBe(before[i].pid);
      expect(p.state.me?.role).toBe(before[i].role);
      expect(p.state.me?.wish).toBe(null);
      expect(p.state.me?.wishMiss).toBe(0);
      expect(p.state.me?.wishMissed).toBe(false);
    });
    expect(host.state.game!.stage).toBe('assigned');
    expect(host.state.game!.wishes).toEqual({ oni: 0, runner: 0 });
    // 前の版で決めた配役は、くじだけで決めた配役として扱う
    expect(host.state.host!.wishStat).toBe(null);

    // 結果まで進めて（やり直し→開始は長いので、勝ちを押せる状態＝時間切れを待たず、夜を終える→再開で次の配役へ）希望を選ぶ
    host.command('end');
    await waitFor('夜を終える', () => host.state.game?.stage === 'ended');
    for (const p of players) p.wish('runner');
    await waitFor('希望が届く', () => host.state.game?.wishes?.runner === 10 && players.every((p) => p.state.me?.wish === 'runner'));
    host.command('assign');
    await waitFor('希望を聞いた配役', () => host.state.game?.stage === 'assigned' && players.every((p) => p.state.me?.assignId === host.state.game?.assignId));
    expect(host.state.game!.counts).toMatchObject({ oni: 3, runner: 7 });
    expect(players.filter((p) => p.state.me!.wishMissed)).toHaveLength(3);
    await waitFor('主催者に数が届く', () => host.state.host?.wishStat?.missed === 3);

    // もう一度入れ替えても（サーバーが入れ替わっても）、希望と外れた回数は残る
    const missed = players.filter((p) => p.state.me!.wishMissed).map((p) => p.state.identity!.pid);
    await stopServer();
    await startServer(process.cwd());
    await waitFor('全員がつなぎ直す', () => players.every((p) => p.state.online && p.state.phase === 'ready' && p.state.me?.wish === 'runner'), 60_000);
    for (const p of players) {
      const out = missed.includes(p.state.identity!.pid);
      expect(p.state.me!.wishMiss).toBe(out ? 1 : 0);
      expect(p.state.me!.wishMissed).toBe(out);
    }
  }, 300_000);
});
