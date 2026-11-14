/**
 * 偽の群衆の機械テスト。手元に本物のサーバー（wrangler dev）を立て、画面と同じ係（Crowd）で偽の参加者を入れて、
 * 自動で1ラウンド回す。サーバーから見て「本物と同じ」になっているかを、主催者に届くもので確かめる。
 *
 * - 全員が名簿に入り、配役を受け取る
 * - ゲームの段階で、主催者の地図に全員の位置が届く（役つき）。走った人は光る
 * - 偽の人どうしで捕獲が記録される（同時に長押し）。牢屋の人が助け出される
 * - 開き直す（同じ合い鍵）と、同じ人として戻る（名簿が増えない）
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/crowd.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Crowd } from '../src/client/crowd/driver';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.CROWD_PORT ?? 8823);
const N = Number(process.env.SIM_N ?? 24);
const TOKEN = 'crowdtoken';
const GAME = `crowd${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
const SFC = { lat: 35.38873, lon: 139.42701 };
/** 逃走開始まで2秒・追跡開始まで6秒・ゲーム75秒・広場に戻るまで4秒 */
const DUR = [2_000, 6_000, 75_000, 4_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`時間切れ：${label}`);
}

let server: ChildProcess | null = null;
let crowd: Crowd | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let watcher: GameClient | null = null;
const stores = new Map<number, KeyValueStore>();
const storeFor = (i: number) => stores.get(i) ?? (stores.set(i, memoryStore()), stores.get(i)!);

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-crowd-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

function makeCrowd(): Crowd {
  const c = new Crowd({
    url: WS_URL,
    gameId: GAME,
    count: N,
    center: SFC,
    reach: 60,
    createSocket: (u) => new WebSocket(u) as never,
    now: () => Date.now(),
    storeFor,
    hostToken: TOKEN,
    seed: 42,
  });
  // 短いゲームの中で捕獲と解放まで起きるよう、動きは3倍
  c.speed = 3;
  return c;
}

afterAll(() => {
  if (ticker) clearInterval(ticker);
  crowd?.stop();
  watcher?.stop();
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // もう止まっている
    }
  }
});

describe(`偽の群衆 ${N}人`, () => {
  it('入室 → 自動で1ラウンド：位置・光る・捕獲・解放が、本物と同じ道で届く', async () => {
    await startServer();
    watcher = new GameClient({ url: WS_URL, gameId: GAME, createSocket: (u) => new WebSocket(u) as never, now: () => Date.now(), storage: memoryStore() }, { kind: 'host', token: TOKEN });
    watcher.start();
    await waitFor('主催者がつながる', () => watcher!.state.phase === 'ready');

    crowd = makeCrowd();
    crowd.start();
    ticker = setInterval(() => crowd?.tick(), 250);
    await waitFor('全員が入る', () => crowd!.snapshot().ready === N);
    await waitFor('主催者の集計に全員', () => watcher!.state.host?.total === N && watcher!.state.host?.registry === N);

    expect(crowd.setDurations(DUR)).toBe(true);
    await waitFor('時間が変わる', () => watcher!.state.game?.durations[2] === DUR[2]);
    crowd.auto = true;
    await waitFor('自動で配役される', () => watcher!.state.game?.stage === 'assigned', 20_000);
    await waitFor('全員が役を受け取る', () => watcher!.state.host?.received === N);
    const snap = crowd.snapshot();
    expect(snap.members.filter((m) => m.role === 'oni').length).toBe(snap.counts!.oni);
    expect(snap.members.filter((m) => m.role === 'runner').length).toBe(snap.counts!.runner);

    await waitFor('自動で始まる', () => watcher!.state.game?.stage === 'timer', 20_000);
    await waitFor('ゲームの段階', () => crowd!.snapshot().phase === 'game', 20_000);

    // 全体の地図：主催者には全員が役つきで届く
    await waitFor('主催者の地図に全員', () => (watcher!.state.mates?.people.length ?? 0) >= N - 2, 15_000);
    expect(watcher.state.mates?.scope).toBe('all');
    expect(watcher.state.mates?.people.every((p) => p.role === 'oni' || p.role === 'runner')).toBe(true);
    expect(watcher.state.host?.glow?.geo).toBe(N);

    // 走ると光る：追いかけっこが起きて、誰かが光る
    let litMax = 0;
    let caughtMax = 0;
    let sawRescue = false;
    const end = Date.now() + 60_000;
    while (Date.now() < end && !(litMax > 0 && caughtMax > 0 && sawRescue)) {
      litMax = Math.max(litMax, watcher.state.glow?.runs.length ?? 0);
      const cap = watcher.state.host?.capture;
      caughtMax = Math.max(caughtMax, cap?.runners.filter((r) => r.caught || r.via !== null).length ?? 0);
      sawRescue ||= (cap?.runners ?? []).some((r) => (r.rescues ?? 0) > 0);
      await sleep(200);
    }
    expect(litMax).toBeGreaterThan(0);
    expect(caughtMax).toBeGreaterThan(0);
    expect(sawRescue).toBe(true);
    const cap = watcher.state.host!.capture!;
    expect(cap.oni.reduce((a, o) => a + o.catches, 0)).toBeGreaterThan(0);
    // 音は鳴らせないので、記録は「同時に長押し」の道
    expect(cap.runners.filter((r) => r.via !== null).every((r) => r.via === 'together')).toBe(true);
  }, 240_000);

  it('開き直すと同じ人として戻る（名簿は増えない）', async () => {
    if (ticker) clearInterval(ticker);
    const names = crowd!.snapshot().members.map((m) => m.name).sort();
    crowd!.stop();
    await sleep(1_000);
    crowd = makeCrowd();
    crowd.start();
    ticker = setInterval(() => crowd?.tick(), 250);
    await waitFor('全員が戻る', () => crowd!.snapshot().ready === N);
    expect(crowd.snapshot().members.map((m) => m.name).sort()).toEqual(names);
    await sleep(1_500);
    expect(watcher!.state.host?.registry).toBe(N);
  }, 60_000);
});
