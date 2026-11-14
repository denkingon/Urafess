/**
 * 主催者の合言葉の確認。手元に本物のサーバー（wrangler dev）を、日本語と空白の入った合言葉で立てる。
 * - 空白なし・大文字・全角で打っても主催者として入れる。1字ちがえば入れない
 * - 合言葉を確かめる口（/key）は 204 か 403 だけを返す
 * - 記録の保存（/log）は、合言葉を % の形でヘッダーに載せて通る（日本語はそのままではヘッダーに載せられない）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { encodeHostKey } from '../src/shared/hostkey';

const PORT = Number(process.env.HOSTKEY_PORT ?? 8805);
const TOKEN = 'urafess with no 前例';
const GAME = `key${Date.now()}`;
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

const check = (typed: string) => fetch(`${BASE}/api/game/${GAME}/key`, { headers: { 'x-host-token': encodeHostKey(typed) } });

let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-key-')), '--var', `HOST_TOKEN:${TOKEN}`],
    { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      if ((await check(TOKEN)).status === 204) return;
    } catch {
      // まだ立ち上がっていない
    }
    await sleep(300);
  }
  throw new Error('サーバーが立ち上がらない');
}

const clients: GameClient[] = [];

function host(token: string): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage: memoryStore(), createSocket: (u) => new WebSocket(u) as never },
    { kind: 'host', token },
  );
  clients.push(c);
  c.start();
  return c;
}

describe('主催者の合言葉', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // 終わっている
      }
    }
  });

  it('打ち方がちがっても入れる。字がちがえば入れない。記録の保存も通る', async () => {
    await startServer();

    // 確かめる口
    for (const typed of [TOKEN, 'urafesswithno前例', 'Urafess With No 前例', 'ｕｒａｆｅｓｓ　ｗｉｔｈ　ｎｏ　前例']) {
      expect((await check(typed)).status, typed).toBe(204);
    }
    for (const typed of ['urafess with no 前列', 'urafess with no', '前例']) {
      expect((await check(typed)).status, typed).toBe(403);
    }
    expect((await fetch(`${BASE}/api/game/${GAME}/key`)).status).toBe(403);

    // つなぐ：打ち方がちがっても主催者として状態が届く
    const loose = host('URAFESSWITHNO前例');
    await waitFor('空白なし・大文字で主催者として入る', () => loose.state.phase === 'ready' && loose.state.host !== null);
    const wrong = host('urafess with no 前列');
    await waitFor('1字ちがいは断られる', () => wrong.state.phase === 'denied');

    // 記録の保存：% の形のヘッダーで通る。ヘッダーなしは断られる
    const log = await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': encodeHostKey('urafesswithno前例') } });
    expect(log.status).toBe(200);
    expect(log.headers.get('content-type')).toContain('text/csv');
    expect((await fetch(`${BASE}/api/game/${GAME}/log`)).status).toBe(403);
    expect((await fetch(`${BASE}/api/game/${GAME}/photos`, { headers: { 'x-host-token': encodeHostKey(TOKEN) } })).status).toBe(200);
    expect((await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': encodeHostKey(TOKEN) } })).status).toBe(200);
  });
});
