/**
 * 名簿を入れる前の版から入れ替えたときの確認。前の版で入った人（本番の部屋に残っている人）が、
 * 入り直さずに名簿へ移り、新しい夜を始めても名前のボタンで同じ人として戻れるかを、本物のサーバーで確かめる。
 *
 * 前の版の app/ を OLD_APP_DIR に置いて流す（無ければ飛ばす）。例：
 *   git worktree add /tmp/urafess-old <前の版のコミット>
 *   ln -s "$PWD/node_modules" /tmp/urafess-old/app/node_modules
 *   OLD_APP_DIR=/tmp/urafess-old/app npx vitest run --config vitest.sim.config.ts sim/migrate.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const OLD = process.env.OLD_APP_DIR ?? '';
const PORT = Number(process.env.MIGRATE_PORT ?? 8796);
const TOKEN = 'migratetoken';
const GAME = `migrate${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-migrate-'));

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

type Debug = {
  game: { nightAt?: number };
  people: { pid: string; num: number; name: string; removed: boolean; joinedAt: number }[];
  members?: { pid: string; num: number; name: string; nights: number }[];
};

async function debug(): Promise<Debug> {
  const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as Debug;
}

const clients: GameClient[] = [];

function client(kind: 'player' | 'host'): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage: memoryStore(), createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  return c;
}

describe.skipIf(!OLD)('前の版から名簿の版へ入れ替える', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
  });

  it('前の版で入った人は入り直さずに名簿へ移り、新しい夜でも名前のボタンで同じ人として戻れる', async () => {
    // --- 前の版：3人と、同じ名前の1人（外される）が入って1ラウンド配役 ---
    await startServer(OLD);
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか'].map((name) => {
      const c = client('player');
      c.join(name);
      return c;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.phase === 'ready') && host.state.host?.total === 3);
    const dup = client('player');
    dup.join('あお');
    await waitFor('同じ名前の人が入る（前の版は断らない）', () => dup.state.phase === 'ready' && host.state.host?.total === 4);
    host.command('remove', { pid: dup.state.identity!.pid });
    await waitFor('外す', () => host.state.host?.total === 3);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const before = players.map((p) => ({ pid: p.state.identity!.pid, num: p.state.identity!.num, role: p.state.me!.role }));

    // --- 名簿の版に入れ替える（同じ保存場所） ---
    await stopServer();
    await startServer(process.cwd());
    await waitFor('3人がつなぎ直し、入り直さずに戻る', () => players.every((p) => p.state.online && p.state.phase === 'ready'), 60_000);
    players.forEach((p, i) => {
      expect(p.state.identity?.pid).toBe(before[i].pid);
      expect(p.state.me?.role).toBe(before[i].role);
    });
    const d = await debug();
    // 外された人は名簿へ移さない。番号は前の版のまま
    expect(d.members?.map((m) => [m.pid, m.num]).sort()).toEqual(before.map((b) => [b.pid, b.num]).sort());
    // 夜の始まりは、前の版で最初に入った人の時刻とみなして保存する（入れ替えのたびに「今」に戻らない）
    const firstJoin = Math.min(...d.people.map((p) => p.joinedAt));
    expect(d.game.nightAt).toBe(firstJoin);
    await stopServer();
    await startServer(process.cwd());
    expect((await debug()).game.nightAt).toBe(firstJoin);

    // --- 新しい夜を始める：3人は名前のボタン、外された人は入室画面へ ---
    await waitFor('主催者がつなぎ直す', () => host.state.online && host.state.host?.registry === 3, 60_000);
    host.command('clear');
    await waitFor('3人に名前のボタンが出る', () => players.every((p) => p.state.phase === 'known') && host.state.host?.total === 0);
    await waitFor('外された人は入室画面へ', () => dup.state.phase === 'need-name' && dup.state.identity === null);
    for (const p of players) p.enter();
    await waitFor('3人が同じ人として今夜に入る', () => players.every((p, i) => p.state.phase === 'ready' && p.state.me?.pid === before[i].pid));
    await waitFor('主催者画面の参加が3', () => host.state.host?.total === 3);

    // 名簿にある名前は、合い鍵のないスマホでは入れない（前の版から移った名前も）
    const other = client('player');
    other.join('アカ');
    await waitFor('taken（あか）', () => other.state.phase === 'taken' && other.state.takenName === 'あか');
  }, 300_000);
});
