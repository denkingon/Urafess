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

  it('主催者画面で合言葉を変える：新しい合言葉で入れる。最初の合言葉も予備として効く。前に決めた合言葉は効かなくなる', async () => {
    const change = (current: string | null, key: unknown) =>
      fetch(`${BASE}/api/game/${GAME}/key`, {
        method: 'POST',
        headers: { ...(current === null ? {} : { 'x-host-token': encodeHostKey(current) }), 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });

    // 主催者でなければ変えられない
    expect((await change(null, 'Urafess no')).status).toBe(403);
    expect((await change('ちがう合言葉', 'Urafess no')).status).toBe(403);
    expect((await check('Urafess no')).status).toBe(403);

    // 短い・長い・字でないものは受けない（変わらない）
    for (const bad of ['urafess', '1234', 'u r a f', '', 12345678]) {
      const res = await change(TOKEN, bad);
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('short');
    }
    expect(((await (await change(TOKEN, 'a'.repeat(65))).json()) as { error: string }).error).toBe('long');
    expect((await check('urafess')).status).toBe(403);

    // 変える
    expect((await change(TOKEN, 'Urafess no')).status).toBe(204);
    for (const typed of ['Urafess no', 'urafessno', 'URAFESS NO', 'ｕｒａｆｅｓｓ　ｎｏ']) expect((await check(typed)).status, typed).toBe(204);
    expect((await check('urafess')).status).toBe(403);
    // 最初の合言葉（サーバーに入れてあるもの）は予備の鍵として効く
    expect((await check(TOKEN)).status).toBe(204);

    // 新しい合言葉でつなげる・記録も取れる
    const fresh = host('urafessno');
    await waitFor('新しい合言葉で主催者として入る', () => fresh.state.phase === 'ready' && fresh.state.host !== null);
    const csv = await (await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': encodeHostKey('Urafess no') } })).text();
    expect(csv).toContain('主催者の合言葉を変えた');
    expect(csv).not.toContain('Urafess no');
    expect(csv.toLowerCase()).not.toContain('urafessno');

    // 新しい合言葉で、もう一度変えられる。前に決めた合言葉は効かなくなる
    expect((await change('urafessno', 'noprecedent')).status).toBe(204);
    expect((await check('noprecedent')).status).toBe(204);
    expect((await check('Urafess no')).status).toBe(403);
    expect((await check(TOKEN)).status).toBe(204);

    // ほかの部屋には効かない（部屋ごとのもの）
    expect((await fetch(`${BASE}/api/game/${GAME}other/key`, { headers: { 'x-host-token': encodeHostKey('noprecedent') } })).status).toBe(403);
    expect((await fetch(`${BASE}/api/game/${GAME}other/key`, { headers: { 'x-host-token': encodeHostKey(TOKEN) } })).status).toBe(204);
  });
});
