/**
 * 全体の地図（仲間の居場所）の機械テスト。走ると光るのテストと同じ作り（手元の wrangler dev に GameClient でつなぐ）。
 *
 * - ゲームの段階の外では、送った位置は捨てられ、誰にも届かない
 * - 鬼には鬼どうし、逃走者には逃走者どうしだけが届く（相手の役の位置は入らない）。参加者に届く分に役は入らない
 * - 主催者には全員が役つきで届く。配役に入っていない人（見学）には誰も届かない
 * - 捕まった逃走者は地図から消える。位置が届かなくなった人は MATES_STALE_MS で消える。段階が終わると全員消える
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/mates.test.ts
 *
 * （以下はもとの走ると光るのテストの説明）走ると光るの機械テスト。手元に本物のサーバー（wrangler dev）を立て、ブラウザと同じしくみ（GameClient）で
 * 仮想参加者をつなぐ。走っているかの判定はスマホの中の話（test/run.test.ts）なので、ここでは「走っている」を直接送る。
 *
 * - ゲームの段階の外（逃走開始まで・追跡開始まで・止めている間・広場に戻るまで）は光らない
 * - 光った人は、名前と場所だけが全員（参加者・見学・主催者）に届く。役は入らない
 * - 止まった・位置が届かなくなった・捕まった・段階が終わった で消え、理由つきで記録に残る
 * - あとから来た人・開き直した人（同じスマホの合い鍵で戻る）にも、いま光っている人がすぐ届く
 * - 主催者には、動きのセンサー・位置が使える人の数が出る
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/glow.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import type { GlowEntry, MateEntry } from '../src/shared/protocol';
import { MATES_STALE_MS, RUN_STALE_MS, START_LEAD_MS } from '../src/shared/rules';
import { positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.MATES_PORT ?? 8817);
const TOKEN = 'glowtoken';
const GAME = `mates${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで3秒・追跡開始まで3秒・ゲーム3分・広場に戻るまで3秒 */
const DUR = [3_000, 3_000, 180_000, 3_000];
/** SFC の鴨池のあたり */
const SFC = { lat: 35.38873, lon: 139.42701 };

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-mates-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

const stores = new Map<GameClient, KeyValueStore>();

function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  stores.set(c, storage);
  return c;
}

function phaseOf(c: GameClient): number | 'done' {
  const timer = c.state.game?.timer;
  const now = c.serverNow();
  if (!timer || now === null) return -1;
  const pos = positionAt(timer, now);
  return pos.kind === 'done' ? 'done' : pos.index;
}

/** その人の手元で、いま光っている人（古い分は画面と同じく捨てる） */
function litOf(c: GameClient): GlowEntry[] {
  const now = c.serverNow() ?? Date.now();
  return (c.state.glow?.runs ?? []).filter((r) => now - r.at <= RUN_STALE_MS);
}
const litNums = (c: GameClient) => litOf(c).map((r) => r.num).sort((a, b) => a - b);

/** 北へ m、東へ m の位置 */
const at = (north: number, east: number) => ({
  lat: SFC.lat + north / 111_195,
  lon: SFC.lon + east / (111_195 * Math.cos((SFC.lat * Math.PI) / 180)),
  acc: 8,
});

async function log(): Promise<{ kind: string; num: number | null; data: string | null; phase: number | null }[]> {
  const r = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}


/** その人の手元の地図に出ている人（古い分は画面と同じく捨てる） */
function matesOf(c: GameClient): MateEntry[] {
  const now = c.serverNow() ?? Date.now();
  return (c.state.mates?.people ?? []).filter((m) => now - m.at <= MATES_STALE_MS);
}
const mateNums = (c: GameClient) => matesOf(c).map((m) => m.num).sort((a, b) => a - b);
void litOf;
void litNums;
void log;
void START_LEAD_MS;

describe('全体の地図', () => {
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

  it('ゲームの段階だけ、同じ役どうしの位置が届き、主催者には全員。捕まる・途切れる・段階の終わりで消える', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const names = ['あお', 'みどり', 'あか', 'しろ', 'くろ', 'きい'];
    const players = names.map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('6人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 6);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('ratio', { ratio: { oni: 1, runner: 2 } });
    await waitFor('割合', () => host.state.game?.ratio?.oni === 1 && host.state.game?.ratio?.runner === 2);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    // 配役のあとに来た人＝見学
    const watcher = client('player');
    watcher.join('みる');
    await waitFor('見学がつながる', () => watcher.state.phase === 'ready' && !!watcher.state.me);

    const oni = players.filter((p) => p.state.me!.role === 'oni');
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    expect(oni.length).toBe(2);
    expect(runners.length).toBe(4);
    const numsOf = (ps: GameClient[]) => ps.map((p) => p.state.me!.num).sort((a, b) => a - b);
    const sendAll = (k: number) => players.forEach((p, i) => p.pos(at(10 * i + k, 5 * i)));

    // ---- ゲームの段階の前：送っても届かない ----
    host.command('start');
    await waitFor('開始', () => players.every((p) => p.state.game?.timer?.status === 'running'));
    await waitFor('逃走開始まで', () => phaseOf(players[0]) === 0);
    sendAll(0);
    await sleep(800);
    expect([...players, host, watcher].every((x) => matesOf(x).length === 0)).toBe(true);

    // ---- ゲームの段階：同じ役どうしだけ ----
    await waitFor('ゲームの段階', () => phaseOf(players[0]) === 2 && phaseOf(host) === 2, 15_000);
    await sleep(300);
    const sentAt = Date.now();
    sendAll(1);
    await waitFor('主催者に全員', () => matesOf(host).length === 6, 3_000);
    expect(Date.now() - sentAt).toBeLessThan(1_500);
    await waitFor('鬼に鬼どうし', () => oni.every((p) => JSON.stringify(mateNums(p)) === JSON.stringify(numsOf(oni))), 3_000);
    await waitFor('逃走者に逃走者どうし', () => runners.every((p) => JSON.stringify(mateNums(p)) === JSON.stringify(numsOf(runners))), 3_000);
    for (const p of oni) expect(p.state.mates?.scope).toBe('oni');
    for (const p of runners) expect(p.state.mates?.scope).toBe('runner');
    expect(host.state.mates?.scope).toBe('all');
    // 参加者に届く分には役が入らない。主催者には役が入る
    for (const p of players) expect(JSON.stringify(p.state.mates)).not.toMatch(/"role"/);
    for (const m of matesOf(host)) {
      const owner = players.find((p) => p.state.me!.num === m.num)!;
      expect(m.role).toBe(owner.state.me!.role);
    }
    const e = matesOf(runners[0]).find((m) => m.num === runners[1].state.me!.num)!;
    expect(Object.keys(e).sort()).toEqual(['acc', 'at', 'lat', 'lon', 'name', 'num']);
    const i1 = players.indexOf(runners[1]);
    expect(e.lat).toBeCloseTo(at(10 * i1 + 1, 5 * i1).lat, 5);
    // 見学には誰も
    expect(watcher.state.mates?.scope ?? 'none').toBe('none');
    expect(matesOf(watcher).length).toBe(0);
    // 見学が位置を送っても、誰の地図にも出ない
    watcher.pos(at(0, 0));
    await sleep(600);
    expect(mateNums(host)).not.toContain(watcher.state.me!.num);

    // ---- 位置の更新は1秒ごとにまとめて届く ----
    const seq0 = runners[0].state.mates!.seq;
    for (let k = 0; k < 5; k++) {
      runners[1].pos(at(200 + k, 0));
      await sleep(50);
    }
    await sleep(1_300);
    const pushes = runners[0].state.mates!.seq - seq0;
    expect(pushes).toBeGreaterThanOrEqual(1);
    expect(pushes).toBeLessThanOrEqual(2);
    expect(matesOf(runners[0]).find((m) => m.num === runners[1].state.me!.num)!.lat).toBeCloseTo(at(204, 0).lat, 5);

    // ---- あとから開き直した人にも、すぐ届く ----
    const reopened = client('player', stores.get(runners[2])!);
    await waitFor('開き直した逃走者に仲間', () => reopened.state.phase === 'ready' && mateNums(reopened).length === 4, 5_000);

    // ---- 捕まった逃走者は地図から消える（仲間の地図・主催者の地図の両方） ----
    const caught = runners[3];
    host.command('capture', { pid: caught.state.me!.pid, by: oni[0].state.me!.pid });
    await waitFor('捕まった人が消える', () => !mateNums(host).includes(caught.state.me!.num) && !mateNums(runners[0]).includes(caught.state.me!.num), 3_000);
    // 捕まった人が送っても戻らない
    caught.pos(at(0, 0));
    await sleep(600);
    expect(mateNums(host)).not.toContain(caught.state.me!.num);
    // 捕まった人にも、仲間はまだ見える
    await sleep(1_200);
    expect(matesOf(caught).length).toBeGreaterThanOrEqual(2);

    // ---- 位置が届かなくなった人は消える（ほかの人は送り続ける） ----
    const silent = oni[1];
    const keepers = players.filter((p) => p !== silent && p !== caught);
    const t0 = Date.now();
    while (Date.now() - t0 < MATES_STALE_MS + 4_500) {
      keepers.forEach((p) => p.pos(at(1, 1)));
      await sleep(2_500);
      if (!mateNums(host).includes(silent.state.me!.num)) break;
    }
    expect(mateNums(host)).not.toContain(silent.state.me!.num);
    expect(mateNums(oni[0])).not.toContain(silent.state.me!.num);
    expect(mateNums(host).length).toBe(4);

    // ---- 段階が終わる（次に進む）と全員消える ----
    host.command('skip');
    await waitFor('段階の終わりで地図が空に', () => [host, ...keepers].every((x) => matesOf(x).length === 0), 8_000);
    keepers.forEach((p) => p.pos(at(2, 2)));
    await sleep(800);
    expect(matesOf(host).length).toBe(0);
  }, 180_000);
});
