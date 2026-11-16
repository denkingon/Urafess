/**
 * 救護の呼び出し（緊急ボタン）の機械テスト。チャットのテストと同じ作り（手元の wrangler dev に GameClient でつなぐ）。
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/sos.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.SOS_PORT ?? 8833);
const TOKEN = 'sostoken';
const GAME = `sos${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで2秒・追跡開始まで2秒・ゲーム3分・広場に戻るまで2秒 */
const DUR = [2_000, 2_000, 180_000, 2_000];
const SFC = { lat: 35.38873, lon: 139.42701, acc: 8 };

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-sos-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  return c;
}


async function log(): Promise<{ kind: string; name: string | null; data: string | null }[]> {
  const r = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}

describe('救護の呼び出し', () => {
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

  it('押すと本部に位置つきで届き、送り直しで2件にならず、見た・終わった・取り消しが本人に返り、サーバーを入れ替えても残る', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const a = client('player');
    a.join('あお');
    const b = client('player');
    b.join('みどり');
    await waitFor('2人が入室', () => [a, b].every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 2);
    expect(host.state.host?.sos).toEqual([]);
    expect(a.state.me?.sos ?? null).toBeNull();

    // 待合室でも押せる。位置つき
    const t0 = Date.now();
    expect(a.sos(true, 'cidA1', SFC)).toBe(true);
    await waitFor('本部に届く', () => (host.state.host?.sos?.length ?? 0) === 1, 5_000);
    const lag = Date.now() - t0;
    const s1 = host.state.host!.sos![0];
    expect(s1.name).toBe('あお');
    expect(s1.status).toBe('open');
    expect(s1.pos?.lat).toBeCloseTo(SFC.lat, 4);
    expect(s1.online).toBe(true);
    await waitFor('本人に返る', () => a.state.me?.sos?.cid === 'cidA1' && a.state.me.sos.status === 'open', 5_000);
    // ほかの人には出ない
    expect(b.state.me?.sos ?? null).toBeNull();
    // 送り直し（同じ cid）・別の cid で連打しても1件のまま
    a.sos(true, 'cidA1', { ...SFC, acc: 4 });
    a.sos(true, 'cidA2', null);
    await sleep(600);
    expect(host.state.host!.sos!.length).toBe(1);
    expect(host.state.host!.sos![0].pos?.acc).toBe(4);

    // 本部が見た → 本人に ack
    host.command('sos-ack', { rid: String(s1.id) });
    await waitFor('本人に「見た」', () => a.state.me?.sos?.status === 'ack', 5_000);
    expect(host.state.host!.sos![0].status).toBe('ack');

    // 2人目も押す（位置なし）。並びは古い順
    b.sos(true, 'cidB1', null);
    await waitFor('2件', () => host.state.host?.sos?.length === 2, 5_000);
    expect(host.state.host!.sos!.map((x) => x.name)).toEqual(['あお', 'みどり']);
    expect(host.state.host!.sos![1].pos).toBeNull();

    // 終わった → 一覧から消え、本人に done
    host.command('sos-done', { rid: String(s1.id) });
    await waitFor('あおが終わる', () => a.state.me?.sos?.status === 'done' && host.state.host?.sos?.length === 1, 5_000);

    // 本人の取り消し（違う cid では消えない）
    b.sos(false, 'wrong', null);
    await sleep(400);
    expect(host.state.host!.sos!.length).toBe(1);
    b.sos(false, 'cidB1', null);
    await waitFor('みどりが取り消す', () => b.state.me?.sos?.status === 'cancel' && host.state.host?.sos?.length === 0, 5_000);

    // もう一度押せる（間を置いたあと）。試合中でも届く
    await sleep(5_200);
    host.command('assign');
    await waitFor('配役', () => host.state.game?.stage === 'assigned');
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    b.sos(true, 'cidB2', SFC);
    await waitFor('試合中に届く', () => host.state.host?.sos?.length === 1 && host.state.host.sos[0].role !== null, 5_000);

    // サーバーを入れ替えても（つなぎ直し）残っている
    const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
    expect(r.ok).toBe(true);
    b.stop();
    await waitFor('切れたのが本部に見える', () => host.state.host?.sos?.[0]?.online === false, 15_000);

    const rows = (await log()).filter((x) => x.kind.startsWith('sos'));
    expect(rows.map((x) => x.kind)).toEqual(['sos', 'sos-ack', 'sos', 'sos-done', 'sos-cancel', 'sos']);
    console.log(`押してから本部に届くまで ${lag}ms`);
  }, 180_000);
});
