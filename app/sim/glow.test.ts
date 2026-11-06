/**
 * 走ると光るの機械テスト。手元に本物のサーバー（wrangler dev）を立て、ブラウザと同じしくみ（GameClient）で
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
import type { GlowEntry } from '../src/shared/protocol';
import { RUN_STALE_MS, START_LEAD_MS } from '../src/shared/rules';
import { positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.GLOW_PORT ?? 8807);
const TOKEN = 'glowtoken';
const GAME = `glow${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-glow-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

describe('走ると光る', () => {
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

  it('ゲームの段階だけ、走っている人の名前と場所が全員に届き、止まる・途切れる・捕まる・段階が終わるで消える', async () => {
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
    // センサー：4人は両方使える、1人は動きが許可されていない、1人は位置が許可されていない
    players.forEach((p, i) => p.sense(i === 4 ? 'denied' : 'ok', i === 5 ? 'denied' : 'ok'));
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    await waitFor('主催者にセンサーの数', () => {
      const g = host.state.host?.glow;
      return !!g && g.total === 6 && g.motion === 5 && g.geo === 5;
    });

    // ---- ゲームの段階の前は光らない ----
    host.command('start');
    await waitFor('開始', () => players.every((p) => p.state.game?.timer?.status === 'running'));
    await waitFor('逃走開始まで', () => phaseOf(players[0]) === 0);
    players[0].run(true, at(10, 10));
    await sleep(800);
    await waitFor('追跡開始まで', () => phaseOf(players[0]) === 1, 10_000);
    players[0].run(true, at(20, 10));
    await sleep(800);
    expect(players.every((p) => litOf(p).length === 0)).toBe(true);
    expect(host.state.glow === null || host.state.glow.runs.length === 0).toBe(true);

    // ---- ゲームの段階：光った人が全員に届く（役は入らない） ----
    await waitFor('ゲームの段階', () => phaseOf(players[0]) === 2 && phaseOf(host) === 2, 10_000);
    await sleep(300);
    const [a, b, , d] = players;
    let c = players[2];
    const sentAt = Date.now();
    a.run(true, at(50, 0));
    await waitFor('あおが全員に光る', () => [...players.slice(1), host].every((x) => litNums(x).includes(a.state.me!.num)), 3_000);
    const delay = Date.now() - sentAt;
    expect(delay).toBeLessThan(1_000);
    const entry = litOf(b).find((r) => r.num === a.state.me!.num)!;
    expect(Object.keys(entry).sort()).toEqual(['acc', 'at', 'lat', 'lon', 'name', 'num', 'since']);
    expect(entry.name).toBe('あお');
    expect(entry.lat).toBeCloseTo(at(50, 0).lat, 5);
    expect(entry.acc).toBe(8);
    expect(JSON.stringify(b.state.glow)).not.toMatch(/oni|runner|role/);
    // 光っている本人にも届く（画面の「全員に見えている」の確かめ）
    expect(litNums(a)).toContain(a.state.me!.num);
    await waitFor('主催者の数：光っている1人', () => host.state.host?.glow?.lit === 1, 3_000);

    // ---- 2人が走り続ける：位置が更新され、知らせはまとめて届く ----
    const seq0 = c.state.glow!.seq;
    for (let i = 1; i <= 4; i++) {
      a.run(true, at(50 + i * 4, 0));
      b.run(true, at(-30, 10 + i * 4));
      await sleep(1_000);
    }
    await waitFor('2人とも光っている', () => litNums(c).length === 2, 2_000);
    const latest = litOf(c).find((r) => r.num === a.state.me!.num)!;
    expect(latest.lat).toBeCloseTo(at(66, 0).lat, 5);
    // 同じ瞬間に届いた2人の更新は、まとめて1本で配る（4回×2人＝8回の更新に対して、知らせは4本ほど）
    const pushes = c.state.glow!.seq - seq0;
    expect(pushes).toBeGreaterThanOrEqual(3);
    expect(pushes).toBeLessThanOrEqual(5);
    // 1人が立て続けに送っても（4回を 100ms の間に）、知らせは 250ms に1本まで
    const seq1 = c.state.glow!.seq;
    for (let i = 0; i < 4; i++) {
      a.run(true, at(70 + i, 0));
      await sleep(25);
    }
    await sleep(600);
    expect(c.state.glow!.seq - seq1).toBeLessThanOrEqual(2);

    // ---- 止まった：すぐ消える ----
    a.run(false);
    await waitFor('あおが消える', () => !litNums(c).includes(a.state.me!.num), 2_000);
    expect(litNums(c)).toEqual([b.state.me!.num]);

    // ---- 途切れた（電波・画面を消した）：RUN_STALE_MS ＋合図の間隔のうちに消える ----
    const silentFrom = Date.now();
    await waitFor('みどりが途切れて消える（サーバーの一覧から）', () => c.state.glow!.runs.every((r) => r.num !== b.state.me!.num), RUN_STALE_MS + 5_000);
    const gone = Date.now() - silentFrom;
    expect(gone).toBeGreaterThan(RUN_STALE_MS - 1_500);
    expect(gone).toBeLessThan(RUN_STALE_MS + 3_500);

    // ---- あとから来た人・つなぎ直した人にも、いま光っている人がすぐ届く ----
    d.run(true, at(0, 80));
    await waitFor('しろが光る', () => litNums(c).includes(d.state.me!.num), 2_000);
    // あかの画面を閉じて開き直す（同じスマホの合い鍵で戻る）
    c.stop();
    const c2 = client('player', stores.get(c)!);
    await waitFor('開き直したあかに届く', () => c2.state.phase === 'ready' && c2.state.me?.num === c.state.me!.num && litNums(c2).includes(d.state.me!.num), 3_000);
    players[2] = c2;
    c = c2;
    const late = client('player');
    late.join('おそい');
    await waitFor('あとから来た人に届く', () => late.state.phase === 'ready' && litNums(late).includes(d.state.me!.num), 3_000);
    // 見学の人は光らない
    late.run(true, at(1, 1));
    await sleep(800);
    expect(litNums(c).includes(late.state.me!.num)).toBe(false);

    // ---- 捕まった人は消え、そのあと走っても光らない ----
    const runnerP = players.find((p) => p.state.me?.role === 'runner' && p !== d)!;
    runnerP.run(true, at(-60, -60));
    await waitFor('逃走者が光る', () => litNums(c).includes(runnerP.state.me!.num), 2_000);
    host.command('capture', { pid: runnerP.state.me!.pid });
    await waitFor('捕まって消える', () => !litNums(c).includes(runnerP.state.me!.num) && runnerP.state.me?.caught != null, 3_000);
    runnerP.run(true, at(-61, -61));
    await sleep(800);
    expect(litNums(c).includes(runnerP.state.me!.num)).toBe(false);

    // ---- 止めている間は誰も光らない。再開したらまた光る ----
    d.run(true, at(0, 82));
    host.command('pause');
    await waitFor('一時停止で消える', () => host.state.game?.timer?.status === 'paused' && litNums(c).length === 0, 3_000);
    d.run(true, at(0, 84));
    await sleep(800);
    expect(litNums(c)).toEqual([]);
    host.command('resume');
    await waitFor('再開', () => host.state.game?.timer?.status === 'running');
    await sleep(START_LEAD_MS + 300);
    d.run(true, at(0, 86));
    await waitFor('再開したらまた光る', () => litNums(c).includes(d.state.me!.num), 2_000);

    // ---- ゲームの段階が終わったら消える（次に進む → 広場に戻るまで） ----
    for (const p of players) if (p !== runnerP && p !== d) p.run(true, at(5, 5));
    await waitFor('何人も光る', () => litNums(c).length >= 3, 2_000);
    host.command('skip');
    await waitFor('広場に戻るまで', () => phaseOf(c) === 3, START_LEAD_MS + 3_000);
    await waitFor('段階が終わって全員消える', () => c.state.glow!.runs.length === 0, 4_000);
    d.run(true, at(0, 90));
    await sleep(800);
    expect(c.state.glow!.runs.length).toBe(0);

    // ---- 記録：光った・消えた（理由つき）が残る ----
    const rows = await log();
    const runs = rows.filter((r) => r.kind === 'run');
    const ends = rows.filter((r) => r.kind === 'run-end');
    const reasons = new Set(ends.map((r) => (JSON.parse(r.data!) as { reason: string }).reason));
    expect([...reasons].sort()).toEqual(['caught', 'closed', 'stale', 'stop']);
    expect(runs.length).toBe(ends.length);
    // 段階の外で送った分は記録に無い（光っていないので）
    expect(runs.every((r) => r.phase === 2)).toBe(true);
    // 止まった分は、走った距離と道すじが残る
    const stop = ends.map((r) => JSON.parse(r.data!) as { reason: string; m: number; ms: number; path: number[][] }).find((x) => x.reason === 'stop')!;
    expect(stop.ms).toBeGreaterThan(3_000);
    expect(stop.m).toBeGreaterThan(10);
    expect(stop.path.length).toBeGreaterThanOrEqual(2);
    const csv = await (await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': TOKEN } })).text();
    for (const w of ['光った（走り出した）', '消えた（止まった）', '消えた（位置が届かなくなった）', '消えた（捕まった）', '消えた（ゲームの段階の外）']) {
      expect(csv).toContain(w);
    }
    process.stdout.write(`走ると光る：光ってから全員に届くまで ${delay}ms／途切れてから消えるまで ${gone}ms／4秒間・2人の更新8回に対する知らせ ${pushes}回／記録 光った ${runs.length}・消えた ${ends.length}\n`);
  }, 180_000);
});
