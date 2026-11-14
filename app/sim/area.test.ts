/**
 * 遊ぶ範囲の機械テスト：主催者が決めた範囲が全員に届く・おかしな形は断る・試合中は変えられない・時間が0になれば変えられる・
 * 新しい夜を始めても残る・範囲なしにできる・記録に残る。
 * 実行：npx vitest run --config vitest.sim.config.ts sim/area.test.ts
 *
 * （以下はもとにした全体の地図のテストの説明）全体の地図（仲間の居場所）の機械テスト。走ると光るのテストと同じ作り（手元の wrangler dev に GameClient でつなぐ）。
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

const PORT = Number(process.env.AREA_PORT ?? 8837);
const TOKEN = 'glowtoken';
const GAME = `area${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-area-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

describe('遊ぶ範囲', () => {
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

  it('ゲームの前に決めて全員に届く。試合中は変えられない', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者', () => host.state.phase === 'ready');
    const p = client('player');
    p.join('あお');
    const q = client('player');
    q.join('みどり');
    await waitFor('入室', () => host.state.host?.total === 2);
    expect(p.state.game?.area ?? null).toBe(null);

    // 待合室で決める → 全員に届く
    host.command('area', { area: sq(200) });
    await waitFor('範囲が届く', () => areaOf(p) === JSON.stringify(sq(200).map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6])));
    expect(areaOf(q)).toBe(areaOf(p));
    // おかしな形は断る（2点・遠すぎる点）
    host.command('area', { area: sq(200).slice(0, 2) });
    await waitFor('2点は断る', () => host.state.lastReject?.op === 'area' && host.state.lastReject.reason === 'bad-input');
    host.command('area', { area: [...sq(200), [35.0, 135.0]] });
    await sleep(500);
    expect(areaOf(p)).toBe(areaOf(q));
    expect(p.state.game!.area!.pts.length).toBe(4);

    // 試合中は変えられない
    host.command('durations', { durations: DUR });
    await waitFor('時間', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('assign');
    await waitFor('配役', () => !!p.state.me?.role);
    host.command('start');
    await waitFor('開始', () => p.state.game?.timer?.status === 'running');
    const before = areaOf(p);
    host.command('area', { area: sq(300) });
    await waitFor('試合中は断る', () => host.state.lastReject?.op === 'area' && host.state.lastReject.reason === 'not-allowed');
    host.command('area', { area: null });
    await sleep(600);
    expect(areaOf(p)).toBe(before);

    // 時間が0になったら変えられる
    host.command('skip');
    await sleep(2_500);
    host.command('skip');
    await sleep(2_500);
    host.command('skip');
    await waitFor('時間が0', () => phaseOf(p) === 'done', 15_000);
    await sleep(600);
    host.command('area', { area: sq(300) });
    await waitFor('0のあとは変えられる', () => p.state.game!.area!.pts.length === 4 && areaOf(p) !== before);

    // 新しい夜を始めても残る
    const kept = areaOf(p);
    host.command('result', { winner: 'runner' });
    await sleep(500);
    host.command('clear');
    await waitFor('新しい夜', () => host.state.host?.total === 0);
    expect(areaOf(host)).toBe(kept);

    // 範囲なし
    host.command('area', { area: null });
    await waitFor('範囲なし', () => host.state.game?.area === null);

    // 牢屋の場所：同じ道具（layer＝jail）。遊ぶ範囲とは別に持つ
    host.command('area', { area: sq(200), layer: 'area' });
    await waitFor('範囲を戻す', () => !!host.state.game?.area);
    host.command('area', { area: sq(15), layer: 'jail' });
    await waitFor('牢屋が届く', () => host.state.game?.jail?.pts.length === 4);
    expect(host.state.game!.area!.pts.length).toBe(4);
    expect(JSON.stringify(host.state.game!.jail!.pts)).not.toBe(JSON.stringify(host.state.game!.area!.pts));
    host.command('area', { area: sq(15).slice(0, 2), layer: 'jail' });
    await waitFor('牢屋も2点は断る', () => host.state.lastReject?.op === 'area' && host.state.lastReject.reason === 'bad-input');
    host.command('area', { area: null, layer: 'jail' });
    await waitFor('牢屋なし', () => host.state.game?.jail === null);
    expect(host.state.game!.area).not.toBe(null);

    // 記録に残る
    const rows = await log();
    expect(rows.filter((r) => r.kind === 'area').length).toBe(4);
    expect(rows.filter((r) => r.kind === 'jail-place').length).toBe(2);
  }, 120_000);
});
