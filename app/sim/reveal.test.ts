import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { REVEAL_COUNT_MS, REVEAL_LEAD_MS } from '../src/shared/rules';
import { participantView } from '../src/shared/viewmodel';

const PORT = Number(process.env.REVEAL_PORT ?? 8823);
const TOKEN = 'revealtoken';
const GAME = `reveal${Date.now()}`;
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
const clients: GameClient[] = [];

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-reveal-')), '--var', `HOST_TOKEN:${TOKEN}`],
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


/** その人の画面のドラムロール（流れていなければ null） */
const drumOf = (c: GameClient, seen = false) => participantView(c.state.game!, c.state.me!, c.serverNow()!, true, seen).drum ?? null;

describe('配役の出し方（ドラムロール）', () => {
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

  it('全員同時：全員が同じ時刻に止まり、3・2・1 を数える。タップ：押した人だけ止まり、開始で全員止まる', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'きいろ'].map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 3);
    // 既定は全員同時
    expect(host.state.game?.revealMode).toBe('sync');

    // ---- 全員同時 ----
    const pressedAt = host.serverNow()!;
    host.command('assign');
    await waitFor('配役が届く', () => players.every((p) => p.state.me?.role && p.state.game?.reveal));
    const hitAt = players[0].state.game!.reveal!.hitAt!;
    expect(players.every((p) => p.state.game!.reveal!.mode === 'sync' && p.state.game!.reveal!.hitAt === hitAt)).toBe(true);
    expect(hitAt - pressedAt).toBeGreaterThanOrEqual(REVEAL_LEAD_MS + REVEAL_COUNT_MS - 300);
    expect(hitAt - pressedAt).toBeLessThan(REVEAL_LEAD_MS + REVEAL_COUNT_MS + 1_000);
    // 流れている間：役は隠れている（画面の役は「なし」）。数え始める前は数字なし
    const v0 = participantView(players[0].state.game!, players[0].state.me!, players[0].serverNow()!, true);
    expect(v0.role).toBe('なし');
    expect(v0.drum).toEqual({ mode: 'sync', count: null });
    // 3・2・1
    await waitFor('3 を数える', () => players.every((p) => drumOf(p)?.count === 3), 8_000);
    await waitFor('1 を数える', () => players.every((p) => drumOf(p)?.count === 1), 8_000);
    // 止まる：全員の画面に役が出る
    await waitFor('全員同時に止まる', () => players.every((p) => drumOf(p) === null), 3_000);
    const stopped = host.serverNow()!;
    expect(stopped - hitAt).toBeGreaterThanOrEqual(-150);
    expect(stopped - hitAt).toBeLessThan(800);
    for (const p of players) {
      expect(participantView(p.state.game!, p.state.me!, p.serverNow()!, true).role).not.toBe('なし');
      p.seen(p.state.game!.assignId);
    }
    await waitFor('役が出た人数が主催者に届く', () => host.state.host?.seen === 3);

    // ---- タップで自分の ----
    host.command('reveal', { reveal: 'tap' });
    await waitFor('切り替えが届く', () => host.state.game?.revealMode === 'tap');
    // いまの配役は全員同時のまま（次の配役から効く）
    expect(host.state.game?.reveal?.mode).toBe('sync');
    const prevAssign = host.state.game!.assignId;
    host.command('assign');
    await waitFor('引き直しが届く', () => players.every((p) => (p.state.game?.assignId ?? 0) > prevAssign && p.state.me?.assignId === p.state.game?.assignId));
    expect(host.state.host?.seen).toBe(0);
    expect(players.every((p) => p.state.game!.reveal!.mode === 'tap' && p.state.game!.reveal!.hitAt === null)).toBe(true);
    await sleep(2_000);
    // 押すまでは、いつまでも流れている
    expect(players.every((p) => drumOf(p)?.mode === 'tap')).toBe(true);
    // 1人だけ押す
    expect(drumOf(players[0], true)).toBeNull();
    players[0].seen(players[0].state.game!.assignId);
    await waitFor('押した1人だけ数える', () => host.state.host?.seen === 1);
    // 開始で、押していない人も止まる
    host.command('start');
    await waitFor('開始', () => players.every((p) => p.state.game?.stage === 'timer'));
    expect(players.every((p) => drumOf(p) === null)).toBe(true);

    // ---- 記録 ----
    const csv = await (await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': TOKEN } })).text();
    expect(csv).toContain('配役の出し方');
    expect(csv.split('\n').filter((l) => l.includes('役が出た')).length).toBe(4);
  }, 120_000);
});
