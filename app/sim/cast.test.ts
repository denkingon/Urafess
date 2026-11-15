/**
 * 主催者が配役をいじる確認。手元に本物のサーバー（wrangler dev）を立てる。
 *
 * - 配役の前に指名した人は、希望やくじより先にその役になる。希望の枠は指名の分だけ減る
 * - 希望とちがう役に指名された人は、次の配役で優先される
 * - 配役のあと（開始の前）に動かすと、その場で役と人数が変わり、本人はもう一度受け取る
 * - 片方の役が0人になる動かし方・試合中の操作は断る。指名は開始で消える
 * - 印（男・女…）は名簿に残り、新しい夜のあとも付いている
 * - 捕まるまでの時間・鬼で捕まえた数が、記録から出る
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import type { RoleId } from '../src/shared/rules';

const PORT = Number(process.env.CAST_PORT ?? 8814);
const TOKEN = 'casttoken';
const GAME = `cast${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** ゲームだけ4秒（開始の2秒を足して、約9秒で結果） */
const DUR = [1_000, 1_000, 4_000, 1_000];

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-cast-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

const roleOf = (p: GameClient) => p.state.me?.role ?? null;
const missOf = (p: GameClient) => p.state.me?.wishMiss ?? -1;

const castOf = (host: GameClient, p: GameClient) => host.state.host!.cast!.find((c) => c.pid === p.state.me!.pid)!;
const pidOf = (p: GameClient) => p.state.me!.pid;

describe('主催者が配役をいじる', () => {
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

  it('指名・動かす・印・数字', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const stores = Array.from({ length: 10 }, () => memoryStore());
    const players = stores.map((st, i) => {
      const p = client('player', st);
      p.join(`にん${i}`);
      return p;
    });
    await waitFor('10人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => host.state.game?.durations[2] === 4_000);
    expect(host.state.host!.cast!.length).toBe(10);
    expect(host.state.game!.wishSlots).toEqual({ oni: 3, runner: 7 });

    // にん0 は逃走者を希望。主催者は にん0・にん1 を鬼に、にん2 を逃走者に指名する
    players[0].wish('runner');
    players[3].wish('runner');
    await waitFor('希望が届く', () => host.state.game!.wishes?.runner === 2);
    host.command('cast', { pids: [pidOf(players[0]), pidOf(players[1])], role: 'oni' });
    await waitFor('鬼に指名', () => castOf(host, players[1]).pin === 'oni');
    host.command('cast', { pids: [pidOf(players[2])], role: 'runner' });
    await waitFor('逃走者に指名', () => castOf(host, players[2]).pin === 'runner');
    // 指名した人は希望の数にも枠にも入らない
    await waitFor('枠が減る', () => host.state.game!.wishSlots?.oni === 1);
    expect(host.state.game!.wishSlots).toEqual({ oni: 1, runner: 6 });
    expect(host.state.game!.wishes).toEqual({ oni: 0, runner: 1 });
    await waitFor('本人に届く', () => players[0].state.me!.hostCast === true);
    expect(players[4].state.me!.hostCast).toBe(false);

    // 印：にん0・にん1 に「男」
    host.command('tag', { pids: [pidOf(players[0]), pidOf(players[1])], tag: '男', on: true });
    await waitFor('印が付く', () => castOf(host, players[1]).tags?.includes('男') === true);
    host.command('tag', { pids: [pidOf(players[1])], tag: '男', on: false });
    await waitFor('印が外れる', () => castOf(host, players[1]).tags === undefined);
    host.command('tag', { pids: [pidOf(players[1])], tag: 'ながすぎる印です', on: true });
    await waitFor('長い印は断る', () => host.state.lastReject?.op === 'tag');
    expect(host.state.lastReject!.reason).toBe('bad-input');

    // 配役：指名どおり。人数は割合のまま
    host.command('assign');
    await waitFor('配役', () => host.state.game?.stage === 'assigned' && players.every((p) => p.state.me?.role));
    expect(players[0].state.me!.role).toBe('oni');
    expect(players[1].state.me!.role).toBe('oni');
    expect(players[2].state.me!.role).toBe('runner');
    expect(players[3].state.me!.role).toBe('runner');
    expect(host.state.game!.counts.oni).toBe(3);
    expect(host.state.game!.counts.runner).toBe(7);
    // にん0 は希望（逃走者）とちがう役に指名された：次は優先
    expect(players[0].state.me!.wishMiss).toBe(1);
    expect(players[0].state.me!.wishMissed).toBe(true);
    expect(castOf(host, players[0]).prio).toBe(true);

    // 配役のあとに動かす：逃走者の にん3 を鬼へ。その場で人数が変わり、本人はもう一度受け取る
    await waitFor('全員が受け取る', () => host.state.host!.received === 10);
    host.command('cast', { pids: [pidOf(players[3])], role: 'oni' });
    await waitFor('動いた', () => players[3].state.me!.role === 'oni');
    expect(players[3].state.me!.hostCast).toBe(true);
    expect(players[3].state.me!.wishMiss).toBe(1);
    await waitFor('人数', () => host.state.game!.counts.oni === 4 && host.state.game!.counts.runner === 6);
    await waitFor('動いた人がもう一度受け取る', () => host.state.host!.received === 10);
    // にん0 を希望どおりの逃走者へ戻す：外れた回数は 0 に戻る
    host.command('cast', { pids: [pidOf(players[0])], role: 'runner' });
    await waitFor('戻した', () => players[0].state.me!.role === 'runner');
    expect(players[0].state.me!.wishMiss).toBe(0);
    expect(players[0].state.me!.wishMissed).toBe(false);

    // 鬼を全員逃走者にする動かし方は断る
    const onis = players.filter((p) => p.state.me!.role === 'oni');
    expect(onis.length).toBe(3);
    host.command('cast', { pids: onis.map(pidOf), role: 'runner' });
    await waitFor('断る', () => host.state.lastReject?.op === 'cast');
    expect(host.state.lastReject!.reason).toBe('empty-role');
    expect(host.state.game!.counts.oni).toBe(3);

    // 開始：指名は消える。試合中は動かせない
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    await waitFor('指名が消える', () => host.state.host!.cast!.every((c) => c.pin === null));
    expect(players[1].state.me!.hostCast).toBe(false);
    host.command('cast', { pids: [pidOf(players[5])], role: 'oni' });
    await waitFor('試合中は断る', () => host.state.lastReject?.reason === 'not-allowed');

    // ゲームの段階（開始2秒＋2秒のあと）に、鬼の にん1 が逃走者の1人を捕まえたことにする
    await sleep(5_200);
    host.command('capture', { pid: pidOf(runners[0]), by: pidOf(players[1]) });
    await waitFor('結果', () => host.state.game?.stage === 'result', 20_000);
    await waitFor('数字が出る', () => castOf(host, runners[0]).stat?.caught === 1);
    const caught = castOf(host, runners[0]).stat!;
    expect(caught.runs).toBe(1);
    expect(caught.holdMs).toBeGreaterThan(300);
    expect(caught.holdMs).toBeLessThan(3_800);
    const free = castOf(host, runners[1]).stat!;
    expect(free).toMatchObject({ runs: 1, caught: 0, holdMs: 4_000 });
    expect(castOf(host, players[1]).stat).toMatchObject({ oni: 1, catches: 1, runs: 0 });

    // 次の配役：枠（3）より多く鬼に指名したら、指名のとおりの人数になる
    host.command('cast', { pids: players.slice(0, 5).map(pidOf), role: 'oni' });
    await waitFor('5人を指名', () => host.state.host!.cast!.filter((c) => c.pin === 'oni').length === 5);
    expect(host.state.game!.wishSlots).toEqual({ oni: 0, runner: 5 });
    host.command('assign');
    await waitFor('次の配役', () => host.state.game?.stage === 'assigned' && host.state.game.round === 2);
    await waitFor('役が届く', () => players.every((p) => p.state.me?.assignId === host.state.game!.assignId));
    expect(host.state.game!.counts.oni).toBe(5);
    expect(players.slice(0, 5).every((p) => p.state.me!.role === 'oni')).toBe(true);
    expect(players.slice(5).every((p) => p.state.me!.role === 'runner')).toBe(true);
    // 指名を外して引き直すと、割合に戻る
    host.command('cast', { pids: players.map(pidOf), role: null });
    await waitFor('指名を外す', () => host.state.host!.cast!.every((c) => c.pin === null));
    host.command('assign');
    await waitFor('引き直し', () => host.state.game!.counts.oni === 3);

    // 新しい夜：印は名簿に残る
    host.command('clear');
    await waitFor('新しい夜', () => host.state.host?.total === 0);
    players[0].enter();
    await waitFor('入り直す', () => host.state.host?.total === 1 && (host.state.host.cast?.length ?? 0) === 1);
    expect(host.state.host!.cast![0].tags).toEqual(['男']);
    expect(host.state.host!.cast![0].pin).toBeNull();
  }, 120_000);
});
