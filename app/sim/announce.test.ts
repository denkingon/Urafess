/**
 * 捕まったときの全員への知らせの確認。手元に本物のサーバー（wrangler dev）を立て、主催者1人と参加者4人で、
 * 試し・確保（設定ごとに名前が出る／出ない）・本人の印・取り消し・「なし」・リセットで消える、を確かめる。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.ANN_PORT ?? 8812);
const TOKEN = 'anntoken';
const GAME = `ann${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-ann-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

describe('捕まったときの全員への知らせ', () => {
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

  it('設定に合わせて全員に配り、名前を出さない設定では名前を送らない', async () => {
    await startServer();
    const host = client('host');
    clients.push(host);
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか', 'しろ'].map((name) => {
      const c = client('player');
      c.join(name);
      clients.push(c);
      return c;
    });
    await waitFor('4人が入室', () => players.every((p) => p.state.me) && host.state.host?.total === 4);

    // 最初の値：鬼も・全員鳴らす
    expect(players[0].state.game?.announce).toEqual({ show: 'both', sound: 'all' });
    const everyone = [host, ...players];
    const seqOf = (c: GameClient) => c.state.game?.news?.seq ?? 0;

    // 待合室で試す：全員に試しの知らせ。出す瞬間は約1秒後
    const t0 = Date.now();
    host.command('announce-test');
    await waitFor('試しが全員に届く', () => everyone.every((c) => c.state.game?.news?.kind === 'test'));
    const test = players[0].state.game!.news!;
    expect(test.showAt - t0).toBeGreaterThan(500);
    expect(test.showAt - t0).toBeLessThan(2500);
    expect(test.runner).toBeNull();
    expect(players.every((p) => p.state.me?.newsAbout == null)).toBe(true);

    // 鬼1：逃走者3 で配役 → 試しの知らせは消える
    host.command('ratio', { ratio: { oni: 1, runner: 3 } });
    await waitFor('割合', () => host.state.game?.ratio?.oni === 1 && host.state.game?.ratio?.runner === 3);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role) && players.every((p) => p.state.game?.news == null));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');

    // 試合中は試せない
    host.command('announce-test');
    await waitFor('試合中の試しは断られる', () => host.state.lastReject?.op === 'announce-test');
    expect(host.state.lastReject?.reason).toBe('not-allowed');

    const oni = players.find((p) => p.state.me?.role === 'oni')!;
    const runners = players.filter((p) => p.state.me?.role === 'runner');
    expect(runners.length).toBe(3);
    const pid = (c: GameClient) => c.state.me!.pid;
    const name = (c: GameClient) => c.state.me!.name;

    // 1人目（鬼も）：さむ → ゆいか の形。本人2人には newsAbout が付く
    let before = seqOf(players[0]);
    host.command('capture', { pid: pid(runners[0]), by: pid(oni) });
    await waitFor('確保が全員に届く', () => everyone.every((c) => seqOf(c) > before));
    let n = players[0].state.game!.news!;
    expect(n.kind).toBe('capture');
    expect(n.runner?.name).toBe(name(runners[0]));
    expect(n.oni?.name).toBe(name(oni));
    expect([n.left, n.total]).toEqual([2, 3]);
    expect(n.sound).toBe('all');
    await waitFor('本人の印', () => runners[0].state.me?.newsAbout === n.seq && oni.state.me?.newsAbout === n.seq);
    expect(runners[1].state.me?.newsAbout ?? null).toBeNull();

    // 取り消し：確保の取り消しが全員に届き、残りが戻る
    before = n.seq;
    host.command('release', { pid: pid(runners[0]) });
    await waitFor('取り消しが届く', () => everyone.every((c) => seqOf(c) > before));
    n = players[1].state.game!.news!;
    expect(n.kind).toBe('release');
    expect(n.left).toBe(3);

    // 人数だけ・逃走者以外：名前は送らない
    host.command('announce', { announce: { show: 'count', sound: 'oni' } });
    await waitFor('設定が全員に届く', () => everyone.every((c) => c.state.game?.announce?.show === 'count'));
    before = seqOf(players[0]);
    host.command('capture', { pid: pid(runners[1]), by: pid(oni) });
    await waitFor('人数だけの確保', () => everyone.every((c) => seqOf(c) > before));
    n = players[2].state.game!.news!;
    expect(n.runner).toBeNull();
    expect(n.oni).toBeNull();
    expect(n.sound).toBe('oni');
    expect(n.left).toBe(2);
    expect(JSON.stringify(players.map((p) => p.state.game?.news))).not.toContain(name(runners[1]));
    // 名前は出なくても、本人には印が付く（帯を重ねないため）
    await waitFor('人数だけでも本人の印', () => runners[1].state.me?.newsAbout === n.seq);

    // 捕まった人だけ：鬼の名前は送らない
    host.command('announce', { announce: { show: 'runner', sound: 'all' } });
    await waitFor('設定2', () => everyone.every((c) => c.state.game?.announce?.show === 'runner'));
    before = seqOf(players[0]);
    host.command('capture', { pid: pid(runners[0]), by: pid(oni) });
    await waitFor('捕まった人だけの確保', () => everyone.every((c) => seqOf(c) > before));
    n = players[3].state.game!.news!;
    expect(n.runner?.name).toBe(name(runners[0]));
    expect(n.oni).toBeNull();
    expect(n.left).toBe(1);

    // なし：知らせは増えない（人数は減る）
    host.command('announce', { announce: { show: 'off', sound: 'all' } });
    await waitFor('設定3', () => everyone.every((c) => c.state.game?.announce?.show === 'off'));
    before = seqOf(players[0]);
    host.command('capture', { pid: pid(runners[2]) });
    await waitFor('全員捕まって終わる', () => players.every((p) => p.state.game?.counts.caught === 3));
    await sleep(500);
    expect(everyone.every((c) => seqOf(c) === before)).toBe(true);

    // リセットで知らせは消える。設定は残る
    host.command('reset');
    await waitFor('リセットで消える', () => everyone.every((c) => c.state.game?.stage === 'assigned' && c.state.game?.news == null));
    expect(players[0].state.game?.announce).toEqual({ show: 'off', sound: 'all' });

    // 変な設定は断る
    host.command('announce', { announce: { show: 'loud', sound: 'all' } as never });
    await waitFor('変な設定は断られる', () => host.state.lastReject?.op === 'announce');
    expect(host.state.lastReject?.reason).toBe('bad-input');
  }, 150_000);
});
