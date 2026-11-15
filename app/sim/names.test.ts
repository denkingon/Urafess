/**
 * 名前の見張り：自動で弾く・主催者が言葉を足す・付け直させる・切り替える。手元に本物のサーバー（wrangler dev）を立てて確かめる
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type Identity, type KeyValueStore } from '../src/client/core/game-client';
import type { AccountView } from '../src/shared/account';
import { REDO_NAME, SHAME_NAME } from '../src/shared/badnames';

const PORT = Number(process.env.NAMES_PORT ?? 8803);
const TOKEN = 'namestoken';
const GAME = `names${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
const ME = `${BASE}/api/game/${GAME}/me`;

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
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-names-'));

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--var', `HOST_TOKEN:${TOKEN}`],
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

const clients: GameClient[] = [];
function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  return c;
}

async function me(id: Identity | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (id) {
    headers['x-pid'] = id.pid;
    headers['x-key'] = id.key;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(ME, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe('名前の見張り', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
  });

  it('自動で弾く・主催者が足す・付け直させる・切り替える', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');

    // --- 自動：使えない言葉の名前は入れない（打ち分けてもだめ） ---
    const bad = client('player');
    bad.join('チ ン コ');
    await waitFor('弾かれる', () => bad.state.phase === 'need-name' && (bad.state.joinError ?? '').includes('使えない'));
    expect(bad.state.identity).toBeNull();
    // 主催者が付ける名前は名乗れない
    bad.join(SHAME_NAME);
    await waitFor('名乗れない', () => bad.state.phase === 'need-name' && (bad.state.joinError ?? '').includes('1〜20'));
    // ふつうの名前なら入れる
    bad.join('たろう');
    await waitFor('入れる', () => bad.state.phase === 'ready');
    const taro = bad;
    const hana = client('player');
    hana.join('はなこ');
    await waitFor('2人', () => hana.state.phase === 'ready' && host.state.host?.total === 2);

    // 主催者の見張りに今夜の2人が出る。最初から入っている言葉の数も届く
    await waitFor('見張りの一覧', () => (host.state.host?.names ?? []).length === 2);
    expect(host.state.host!.bans!.builtin).toBeGreaterThan(30);

    // --- 主催者が言葉を足す：足した言葉を含む名前に変えられない・今いる名前は「引っかかる」になる ---
    host.command('ban-add', { word: 'はな' });
    await waitFor('言葉が足される', () => (host.state.host?.bans?.custom ?? []).includes('はな'));
    await waitFor('はなこが引っかかる', () => host.state.host!.names!.find((n) => n.name === 'はなこ')?.hit === 'はな');
    expect(host.state.host!.names![0].name).toBe('はなこ'); // 引っかかる人が先
    let r = await me(taro.state.identity, { op: 'rename', name: 'ハナタロウ' });
    expect(r.json.error).toBe('banned');
    host.command('ban-remove', { word: 'はな' });
    await waitFor('言葉が消える', () => (host.state.host?.bans?.custom ?? []).length === 0);
    await waitFor('引っかからない', () => host.state.host!.names!.every((n) => n.hit === null));

    // --- 付け直させる：試合中でも、本人のスマホは名前を入れ直す状態になる ---
    host.command('durations', { durations: [1_000, 1_000, 20_000, 1_000] });
    await waitFor('時間', () => host.state.game?.durations?.[2] === 20_000);
    host.command('assign');
    await waitFor('配役', () => taro.state.me?.role != null && hana.state.me?.role != null);
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('name-redo', { pid: taro.state.identity!.pid });
    await waitFor('付け直し中', () => taro.state.nameState === 'due' && taro.state.identity?.name === REDO_NAME);
    await waitFor('主催者にも', () => host.state.host!.names!.find((n) => n.pid === taro.state.identity!.pid)?.state === 'due');
    const v = (await me(taro.state.identity)).json as unknown as AccountView;
    expect(v.nameState).toBe('due');
    expect(v.busy).toBe(false); // 試合中でも付け直せる
    r = await me(taro.state.identity, { op: 'rename', name: 'ﾁﾝｺ' });
    expect(r.json.error).toBe('banned');
    r = await me(taro.state.identity, { op: 'rename', name: 'じろう' });
    expect(r.json.name).toBe('じろう');
    await waitFor('付け直せた', () => taro.state.nameState === 'ok' && taro.state.identity?.name === 'じろう');
    // 前の名前「たろう」は空いた。仮の名前は何人いてもいい
    host.command('name-redo', { pid: hana.state.identity!.pid });
    await waitFor('はなこも付け直し中', () => hana.state.identity?.name === REDO_NAME);

    // --- 切り替える：本人は変えられない。付け直させると戻せる ---
    host.command('name-shame', { pid: taro.state.identity!.pid });
    await waitFor('切り替わる', () => taro.state.nameState === 'shamed' && taro.state.identity?.name === SHAME_NAME);
    r = await me(taro.state.identity, { op: 'rename', name: 'さぶろう' });
    expect(r.json.error).toBe('name-locked');
    // 今夜の一覧（主催者の捕獲の一覧）にも新しい名前
    await waitFor('主催者の一覧に新しい名前', () => {
      const cap = host.state.host?.capture;
      return !!cap && [...cap.oni, ...cap.runners].some((p) => p.name === SHAME_NAME);
    });
    host.command('name-redo', { pid: taro.state.identity!.pid });
    await waitFor('付け直し待ちに戻る', () => taro.state.nameState === 'due');
    r = await me(taro.state.identity, { op: 'rename', name: 'さぶろう' });
    expect(r.json.name).toBe('さぶろう');

    // --- 記録に残る ---
    const log = (await (await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } })).json()) as { kind: string }[];
    const kinds = new Set(log.map((e) => e.kind));
    for (const k of ['bad-name', 'ban-add', 'ban-remove', 'name-redo', 'name-shame', 'rename']) expect(kinds.has(k), k).toBe(true);

    // --- 再起動しても状態と足した言葉は残る ---
    host.command('ban-add', { word: '=ぽち' });
    await waitFor('足した', () => (host.state.host?.bans?.custom ?? []).includes('=ぽち'));
    host.command('name-shame', { pid: hana.state.identity!.pid });
    await waitFor('はなこ切り替え', () => hana.state.nameState === 'shamed');
    await stopServer();
    await startServer();
    await waitFor('つなぎ直し', () => hana.state.phase === 'ready' && host.state.phase === 'ready', 30_000);
    await waitFor('状態が残る', () => hana.state.nameState === 'shamed' && (host.state.host?.bans?.custom ?? []).includes('=ぽち'), 30_000);
    const p = client('player');
    p.join('ポチ');
    await waitFor('足した言葉で弾く', () => p.state.phase === 'need-name' && (p.state.joinError ?? '').includes('使えない'));
    p.join('ぽちたま');
    await waitFor('= なので入れる', () => p.state.phase === 'ready');
  }, 240_000);
});
