/**
 * 範囲の縮小の機械テスト：縮み方が全員に届く・試合中は変えられない・始めると段と縮む先が決まる・
 * 主催者の手とミッションの成功で1段ずつ足される（写真ごとに1回）・配役で消える・新しい夜でも縮み方は残る・記録に残る。
 * 実行：npx vitest run --config vitest.sim.config.ts sim/shrink.test.ts
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
import { DEFAULT_SHRINK_PLAN, ZONE_STEP_AREA, zoneAt, type ShrinkPlan } from '../src/shared/shrink';

const PORT = Number(process.env.SHRINK_PORT ?? 8839);
const TOKEN = 'glowtoken';
const GAME = `shrink${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで3秒・追跡開始まで3秒・ゲーム2分・広場に戻るまで3秒 */
const DUR = [3_000, 3_000, 120_000, 3_000];
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-shrink-')), '--var', `HOST_TOKEN:${TOKEN}`],
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



const sq = (r: number): [number, number][] => [at(r, -r), at(r, r), at(-r, r), at(-r, -r)].map((p) => [p.lat, p.lon]);
const areaOf = (c: GameClient) => JSON.stringify(c.state.game?.area?.pts ?? null);
void litNums;
void MATES_STALE_MS;
void RUN_STALE_MS;
void START_LEAD_MS;


function fakeJpeg(size: number): Uint8Array {
  const b = new Uint8Array(size).fill(7);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

async function upload(c: GameClient, missionId: number): Promise<string> {
  const id = c.state.identity!;
  const r = await fetch(`${BASE}/api/game/${GAME}/photo?m=${missionId}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-pid': id.pid, 'x-key': id.key },
    body: new Blob([fakeJpeg(3000) as BlobPart]),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
}

const planOf = (c: GameClient) => JSON.stringify(c.state.game?.shrinkPlan ?? null);

describe('範囲の縮小', () => {
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

  it('縮み方は全員に届き、試合中は変えられない。始めると段と縮む先が決まり、主催者の手・ミッションの成功で1段ずつ足される', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者', () => host.state.phase === 'ready');
    const p = client('player');
    p.join('あお');
    const q = client('player');
    q.join('みどり');
    await waitFor('入室', () => host.state.host?.total === 2);
    expect(p.state.game?.shrinkPlan).toEqual(DEFAULT_SHRINK_PLAN);

    host.command('area', { area: sq(200) });
    await waitFor('範囲', () => (p.state.game?.area?.pts.length ?? 0) === 4);
    // 縮み方：おかしな形は断る
    host.command('shrink-plan', { plan: { ...DEFAULT_SHRINK_PLAN, times: 9 } });
    await waitFor('断る', () => host.state.lastReject?.op === 'shrink-plan' && host.state.lastReject.reason === 'bad-input');
    const plan: ShrinkPlan = { times: 2, finalArea: 0.25, to: 'pick', pick: [at(80, 40).lat, at(80, 40).lon], mission: true };
    host.command('shrink-plan', { plan });
    await waitFor('縮み方が届く', () => p.state.game?.shrinkPlan?.times === 2);
    expect(planOf(q)).toBe(planOf(p));
    expect(p.state.game?.shrink ?? null).toBe(null);

    host.command('durations', { durations: DUR });
    await waitFor('時間', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('assign');
    await waitFor('配役', () => !!p.state.me?.role && !!q.state.me?.role);
    // 始める前は「今すぐ」は断る
    host.command('shrink-now');
    await waitFor('始める前は断る', () => host.state.lastReject?.op === 'shrink-now' && host.state.lastReject.reason === 'not-allowed');
    host.command('start');
    await waitFor('段と縮む先が届く', () => !!p.state.game?.shrink && !!q.state.game?.shrink);
    const live = p.state.game!.shrink!;
    expect(live.steps.filter((s) => s.why === 'time').length).toBe(2);
    expect(live.center).toEqual(p.state.game!.shrinkPlan!.pick);
    expect(live.center[0]).toBeCloseTo(plan.pick![0], 5);
    expect(JSON.stringify(q.state.game!.shrink)).toBe(JSON.stringify(live));

    // 試合中は縮み方を変えられない
    host.command('shrink-plan', { plan: { ...plan, times: 1 } });
    await waitFor('試合中は断る', () => host.state.lastReject?.op === 'shrink-plan' && host.state.lastReject.reason === 'not-allowed');

    // 逃げ始めのあとなら、主催者の手で1段
    await waitFor('逃げ始め', () => phaseOf(p) === 1, 10_000);
    host.command('shrink-now');
    await waitFor('1段足される', () => (p.state.game?.shrink?.steps.length ?? 0) === 3);
    const hostStep = p.state.game!.shrink!.steps[2];
    expect(hostStep.why).toBe('host');
    // 全員の手元で同じ範囲（予告中：大きさは変わらず、行き先が出る）
    const zp = zoneAt(p.state.game!.area, p.state.game!.shrink, p.state.game!.timer, p.serverNow()!)!;
    const zq = zoneAt(q.state.game!.area, q.state.game!.shrink, q.state.game!.timer, q.serverNow()!)!;
    expect(zp.status.kind).toBe('warn');
    expect(zp.scale).toBe(1);
    expect(zp.target ** 2).toBeCloseTo(ZONE_STEP_AREA, 4);
    expect(zq.status.kind).toBe('warn');

    // ミッションの成功で1段（1枚の写真で1回だけ。やり直し→成功でも増えない）
    host.command('mission', { title: '集合写真' });
    await waitFor('ミッション', () => p.state.game?.mission?.open === true);
    const photo = await upload(p, p.state.game!.mission!.id);
    host.command('judge', { photo, ok: true, free: false });
    await waitFor('成功で1段', () => (q.state.game?.shrink?.steps.length ?? 0) === 4);
    expect(q.state.game!.shrink!.steps[3].why).toBe('mission');
    expect(q.state.game!.shrink!.byPhoto).toEqual([photo]);
    host.command('judge', { photo, ok: false });
    await sleep(400);
    host.command('judge', { photo, ok: true, free: false });
    await sleep(800);
    expect(q.state.game!.shrink!.steps.length).toBe(4);

    // 時間が0になったら「今すぐ」は断り、縮み方は変えられる
    host.command('skip');
    await sleep(2_500);
    host.command('skip');
    await waitFor('時間が0', () => phaseOf(p) === 'done' || phaseOf(p) === 3, 15_000);
    host.command('shrink-now');
    await waitFor('戻る段階では断る', () => host.state.lastReject?.op === 'shrink-now');
    host.command('skip');
    await waitFor('時間が0', () => phaseOf(p) === 'done', 15_000);
    await sleep(600);
    host.command('shrink-plan', { plan: { ...plan, times: 1, to: 'random' } });
    await waitFor('0のあとは変えられる', () => p.state.game?.shrinkPlan?.times === 1);

    // 配役し直すと、このラウンドの縮小は消える。縮み方は残る
    host.command('assign');
    await waitFor('配役で消える', () => p.state.game?.shrink === null && p.state.game?.stage === 'assigned');
    expect(p.state.game?.shrinkPlan?.to).toBe('random');
    // 毎回ランダム：範囲の中のどこか
    host.command('start');
    await waitFor('新しい縮む先', () => !!p.state.game?.shrink);
    const c = p.state.game!.shrink!.center;
    expect(Math.abs(c[0] - SFC.lat)).toBeLessThan(200 / 111_195);

    // 新しい夜でも縮み方は残る
    host.command('reset');
    await waitFor('やり直しで消える', () => p.state.game?.shrink === null);
    host.command('clear');
    await waitFor('新しい夜', () => host.state.host?.total === 0);
    expect(host.state.game?.shrinkPlan?.to).toBe('random');

    // 記録に残る
    const rows = await log();
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'shrink').length).toBe(2);
    expect(kinds.filter((k) => k === 'shrink-plan').length).toBeGreaterThanOrEqual(3);
  }, 150_000);
});
