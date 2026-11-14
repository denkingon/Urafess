/**
 * 自分のページ（/api/game/<id>/me）。手元に本物のサーバー（wrangler dev）を立てて確かめる。
 * - 合い鍵が合わなければ断る。記録（来た夜・役）が数えられる
 * - 名前を変える：名簿のほかの人の名前・空の名前・試合中は断る。変えると開いているスマホにも届き、古い名前は空く
 * - 新しいスマホへ移す：合言葉で合い鍵が作り直され、古いスマホは入室画面に戻る。合言葉は1回だけ
 *   （答えが届かず打ち直したときは、少しの間だけ同じ合い鍵を返す）。打ち間違いが多いと止まる
 * - 名簿から消える：試合中は断る。消えると名前が空き、記録の名前（中身に残る前の名前も）は「消えた人」になる
 * - 「消えた人」は名乗れない
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type Identity, type KeyValueStore } from '../src/client/core/game-client';
import { GONE_NAME, HANDOFF_MAX_FAILS, type AccountView } from '../src/shared/account';

const PORT = Number(process.env.ACCOUNT_PORT ?? 8799);
const TOKEN = 'accttoken';
const GAME = `acct${Date.now()}`;
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
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-account-'));

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

describe('自分のページ', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
  });

  it('記録・名前を変える・新しいスマホへ移す・名簿から消える', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか'].map((name) => {
      const c = client('player');
      c.join(name);
      return c;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.phase === 'ready') && host.state.host?.total === 3);
    const [ao, midori, aka] = players;

    // --- 合い鍵が合わなければ断る ---
    expect((await me(null)).status).toBe(403);
    expect((await me({ ...ao.state.identity!, key: 'nope' })).json.error).toBe('unknown');

    // --- 1ラウンド遊ぶ（役が数えられる）。時間は短く ---
    host.command('durations', { durations: [1_000, 1_000, 6_000, 1_000] });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify([1_000, 1_000, 6_000, 1_000]));
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    const roleOfAo = ao.state.me!.role!;

    // 試合中は名前を変えられない・消えられない。移すのはできる（合言葉を出すだけ）
    let r = await me(ao.state.identity, { op: 'rename', name: 'あおい' });
    expect(r.json.error).toBe('busy');
    r = await me(ao.state.identity, { op: 'leave' });
    expect(r.json.error).toBe('busy');
    const view = (await me(ao.state.identity)).json as unknown as AccountView;
    expect(view.busy).toBe(true);

    // 時間が0になってから結果を押す
    await sleep(9_500);
    host.command('result', { winner: 'oni' });
    await waitFor('結果', () => host.state.game?.stage === 'result', 20_000);

    const after = (await me(ao.state.identity)).json as unknown as AccountView;
    expect(after.name).toBe('あお');
    expect(after.busy).toBe(false);
    expect(after.stats.nightsHere).toBe(1);
    expect(after.stats.nights.filter((n) => n.here)).toHaveLength(1);
    expect(after.stats.roles).toEqual(roleOfAo === 'oni' ? { oni: 1, runner: 0 } : { oni: 0, runner: 1 });

    // --- 名前を変える ---
    expect((await me(ao.state.identity, { op: 'rename', name: 'ミドリ' })).json.error).toBe('taken'); // みどり と同じ名前とみなす
    expect((await me(ao.state.identity, { op: 'rename', name: '   ' })).json.error).toBe('invalid');
    r = await me(ao.state.identity, { op: 'rename', name: 'あおい' });
    expect(r.json.name).toBe('あおい');
    await waitFor('開いているスマホにも新しい名前が届く', () => ao.state.identity?.name === 'あおい');
    // 古い名前は空いたので、新しい人が使える
    const newcomer = client('player');
    newcomer.join('あお');
    await waitFor('古い名前で新しい人が入れる', () => newcomer.state.phase === 'ready' && newcomer.state.identity?.name === 'あお');

    // --- 新しいスマホへ移す ---
    const oldId = midori.state.identity!;
    const code = (await me(oldId, { op: 'handoff' })).json.code as string;
    expect(code).toMatch(/^\d{6}$/);
    const fresh = client('player');
    await waitFor('新しいスマホが入室画面', () => fresh.state.phase === 'need-name');
    r = await me(null, { op: 'take', code });
    expect(r.status).toBe(200);
    expect(r.json.pid).toBe(oldId.pid);
    expect(r.json.key).not.toBe(oldId.key); // 合い鍵は作り直す
    fresh.adopt(r.json as unknown as Identity);
    await waitFor('新しいスマホは同じ人として今夜にいる', () => fresh.state.phase === 'ready' && fresh.state.me?.pid === oldId.pid);
    await waitFor('古いスマホは入室画面に戻る', () => midori.state.phase === 'need-name' && midori.state.identity === null);
    expect((await me(oldId)).json.error).toBe('unknown'); // 古い合い鍵はもう使えない
    // 答えが届かなかったつもりで打ち直す：同じ合い鍵が返り、新しいスマホは締め出されない
    const again = await me(null, { op: 'take', code });
    expect(again.status).toBe(200);
    expect(again.json.key).toBe(r.json.key);
    expect((await me(fresh.state.identity)).status).toBe(200);
    // 新しいスマホでまた合言葉を出すと、前の合言葉はもう効かない（1回だけ）
    expect((await me(fresh.state.identity, { op: 'handoff' })).status).toBe(200);
    expect((await me(null, { op: 'take', code })).json.error).toBe('bad-code');
    // 今夜の人数は変わらない（あおい・みどり・あか・新しい「あお」）
    await waitFor('今夜の人数は4のまま', () => host.state.host?.total === 4 && host.state.host?.registry === 4);

    // --- 「消えた人」は名乗れない ---
    expect((await me(aka.state.identity, { op: 'rename', name: GONE_NAME })).json.error).toBe('invalid');

    // --- 名簿から消える（前の名前も記録から消える） ---
    expect((await me(aka.state.identity, { op: 'rename', name: 'あかね' })).json.name).toBe('あかね');
    await waitFor('名前が変わる', () => aka.state.identity?.name === 'あかね');
    const akaId = aka.state.identity!;
    r = await me(akaId, { op: 'leave' });
    expect(r.json.ok).toBe(true);
    await waitFor('消えた人のスマホは入室画面', () => aka.state.phase === 'need-name' && aka.state.identity === null);
    await waitFor('今夜の人数が減る', () => host.state.host?.total === 3 && host.state.host?.registry === 3);
    const log = (await (await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } })).json()) as {
      kind: string;
      pid: string | null;
      name: string | null;
      data: string | null;
    }[];
    expect(log.filter((e) => e.pid === akaId.pid).every((e) => e.name === GONE_NAME)).toBe(true);
    const akaRename = log.find((e) => e.pid === akaId.pid && e.kind === 'rename');
    expect(JSON.parse(akaRename!.data!).from).toBe(GONE_NAME);
    expect(log.filter((e) => e.pid === akaId.pid).some((e) => (e.data ?? '').includes('あか'))).toBe(false);
    expect((await me(akaId)).json.error).toBe('unknown');
    expect(log.some((e) => e.kind === 'rename')).toBe(true);
    expect(log.some((e) => e.kind === 'handoff')).toBe(true);
    // 名前が空いたので、別の人が同じ名前で新しく入れる
    const other = client('player');
    other.join('あかね');
    await waitFor('空いた名前で入れる', () => other.state.phase === 'ready' && other.state.identity?.pid !== akaId.pid);

    // --- 合言葉の当てずっぽうは止まる（上で効かなくなった合言葉を打った1回も数える） ---
    for (let i = 1; i < HANDOFF_MAX_FAILS; i++) {
      const bad = await me(null, { op: 'take', code: '000000' });
      expect(bad.json.error).toBe('bad-code');
    }
    expect((await me(null, { op: 'take', code: '000000' })).json.error).toBe('locked');
  }, 240_000);
});
