/**
 * 範囲の外で失格の機械テスト：スマホが「失格」を送ると、逃走者は「捕まった」扱い（理由＝範囲の外）になって全員の人数に入る。
 * 牢屋の助け（ミッション）では出られない。鬼は記録だけ。同じ配役のうちは1回だけ数える。範囲が無いとき・段階の外では受け付けない。
 * 実行：npx vitest run --config vitest.sim.config.ts sim/dq.test.ts
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

const PORT = Number(process.env.DQ_PORT ?? 8857);
const TOKEN = 'glowtoken';
const GAME = `dqt${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-dq-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

async function log(): Promise<{ kind: string; num: number | null; data: string | null; phase: number | null; via?: string | null }[]> {
  const r = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}



const sq = (r: number): [number, number][] => [at(r, -r), at(r, r), at(-r, r), at(-r, -r)].map((p) => [p.lat, p.lon]);
const areaOf = (c: GameClient) => JSON.stringify(c.state.game?.area?.pts ?? null);
void litNums;
void MATES_STALE_MS;
void RUN_STALE_MS;
void START_LEAD_MS;


describe('範囲の外で失格', () => {
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

  it('逃走者は捕まった扱い・助けでは出られない。鬼は記録だけ。1回だけ数える', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者', () => host.state.phase === 'ready');
    const ps = ['あお', 'みどり', 'あか', 'きいろ', 'しろ'].map((n) => {
      const c = client('player');
      c.join(n);
      return c;
    });
    await waitFor('入室', () => host.state.host?.total === 5);
    await sleep(400);
    host.command('durations', { durations: [2_000, 2_000, 120_000, 3_000] });
    await waitFor('時間', () => JSON.stringify(host.state.game?.durations) === JSON.stringify([2_000, 2_000, 120_000, 3_000]));
    host.command('assign');
    await waitFor('配役', () => ps.every((p) => !!p.state.me?.role));
    const runners = ps.filter((p) => p.state.me!.role === 'runner');
    const onis = ps.filter((p) => p.state.me!.role === 'oni');
    expect(runners.length).toBeGreaterThanOrEqual(2);
    expect(onis.length).toBeGreaterThanOrEqual(1);
    const [r1, r2] = runners;
    const [o1] = onis;

    // 範囲が無いときは受け付けない
    host.command('start');
    await waitFor('ゲームの段階', () => phaseOf(r1) === 2, 20_000);
    r1.disqualified();
    await sleep(700);
    expect(r1.state.me!.caught ?? null).toBeNull();

    // 範囲を決める：試合中は決められないので、いったん時間を0まで飛ばしてやり直す
    for (let i = 0; i < 3; i++) {
      host.command('skip');
      await sleep(400);
    }
    await waitFor('時間が0', () => phaseOf(r1) === 'done', 15_000);
    host.command('area', { area: sq(200) });
    await waitFor('範囲が届く', () => !!r1.state.game?.area);
    host.command('reset');
    await sleep(600);
    host.command('durations', { durations: [2_000, 2_000, 120_000, 3_000] });
    await sleep(600);
    host.command('assign');
    await waitFor('配役2', () => ps.every((p) => !!p.state.me?.role));
    const rs = ps.filter((p) => p.state.me!.role === 'runner');
    const os = ps.filter((p) => p.state.me!.role === 'oni');
    const [a, b] = rs;
    const [o] = os;
    void r2;
    void o1;
    await sleep(500);
    host.command('start');
    // 逃げ始めの前（0:20 のあいだ）は受け付けない
    a.disqualified();
    await sleep(500);
    expect(a.state.me!.caught ?? null).toBeNull();
    await waitFor('ゲームの段階', () => phaseOf(a) === 2, 20_000);

    // 逃走者の失格：捕まった扱い（理由＝範囲の外）。全員の人数に入る
    a.disqualified();
    await waitFor('失格で捕まった扱い', () => a.state.me?.caught != null && ps.every((p) => p.state.game?.counts.caught === 1));
    expect(a.state.me!.caught!.via).toBe('out');
    // 何度送っても1回だけ
    a.disqualified();
    a.disqualified();
    await sleep(600);
    expect(ps[0].state.game!.counts.caught).toBe(1);

    // 鬼の失格は記録だけ（人数は変わらない）
    o.disqualified();
    await sleep(600);
    expect(o.state.me!.caught ?? null).toBeNull();
    expect(host.state.game!.counts.caught).toBe(1);

    // ミッションの成功でも、失格した人は出ない
    host.command('mission-free', {});
    await waitFor('出せる人がいないと断る', () => host.state.lastReject?.reason === 'nobody-jailed');
    expect(a.state.me!.caught).not.toBeNull();

    // ふつうに捕まって牢屋にいる人が失格したら、その人も助けでは出られなくなる
    host.command('capture', { pid: b.state.me!.pid });
    await waitFor('b が牢屋', () => b.state.me?.caught != null && b.state.me.caught.via !== 'out');
    host.command('mission-free', { n: 1 });
    await waitFor('b がミッションで出る', () => b.state.me?.caught == null);
    host.command('capture', { pid: b.state.me!.pid });
    await waitFor('b がまた牢屋', () => b.state.me?.caught != null);
    b.disqualified();
    await waitFor('b も範囲の外の扱いに', () => b.state.me?.caught?.via === 'out');
    host.command('mission-free', {});
    await waitFor('出せる人がいないと断る（2回目）', () => host.state.lastReject?.reason === 'nobody-jailed');
    expect(b.state.me!.caught).not.toBeNull();
    expect(a.state.me!.caught).not.toBeNull();

    // 記録
    const rows = await log();
    expect(rows.filter((r) => r.kind === 'dq').length).toBe(3);
    const cap = rows.filter((r) => r.kind === 'capture' && r.via === 'out');
    expect(cap.length).toBe(1);
  }, 180_000);
});
