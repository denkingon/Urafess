/**
 * プリセットごとの遊ぶ範囲の機械テスト：範囲つきのプリセットをデッキへ入れると全員の範囲が変わる・そのまま（null）は触らない・
 * 範囲なしは消える・前の版のプリセット（area が無い）はそのまま・試合中は入れられない・記録に残る。
 * 実行：npx vitest run --config vitest.sim.config.ts sim/preset-area.test.ts
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

const PORT = Number(process.env.PRESET_AREA_PORT ?? 8861);
const TOKEN = 'glowtoken';
const GAME = `parea${Date.now()}`;
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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-parea-')), '--var', `HOST_TOKEN:${TOKEN}`],
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


const clean = (pts: [number, number][]) => JSON.stringify(pts.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]));

describe('プリセットごとの遊ぶ範囲', () => {
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

  it('デッキへ入れると範囲も入る。そのままは触らない。範囲なしは消える', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者', () => host.state.phase === 'ready');
    const p = client('player');
    p.join('あお');
    const q = client('player');
    q.join('みどり');
    await waitFor('入室', () => host.state.host?.total === 2);
    await waitFor('プリセット', () => (host.state.host?.presets?.length ?? 0) >= 2);
    const base = host.state.host!.presets!;

    // プリセットに範囲を持たせる：広い・狭い・そのまま・範囲なし
    const wide = { ...base[0], id: 'wide', name: '広い', area: sq(200) };
    const small = { ...base[0], id: 'small', name: '狭い', area: sq(60) };
    const keep = { ...base[0], id: 'keep', name: 'そのまま', area: null };
    const none = { ...base[0], id: 'none', name: '範囲なし', area: 'none' as const };
    // 前の版のプリセット（area が無い）
    const old: Record<string, unknown> = { ...base[0], id: 'old', name: '前の版' };
    delete old.area;
    host.command('presets', { presets: [wide, small, keep, none, old] as never });
    await waitFor('プリセットが入る', () => host.state.host?.presets?.length === 5);
    expect(JSON.stringify(host.state.host!.presets!.find((x) => x.id === 'wide')!.area)).toBe(clean(sq(200)));
    expect(host.state.host!.presets!.find((x) => x.id === 'old')!.area).toBeNull();
    // おかしな範囲のプリセットは断る
    host.command('presets', { presets: [{ ...wide, area: sq(200).slice(0, 2) }] as never });
    await waitFor('2点は断る', () => host.state.lastReject?.op === 'presets');
    expect(host.state.host?.presets?.length).toBe(5);

    // 範囲つき → 全員に届く
    expect(areaOf(p)).toBe('null');
    host.command('preset-apply', { preset: 'wide' });
    await waitFor('広いが届く', () => areaOf(p) === clean(sq(200)));
    expect(areaOf(q)).toBe(areaOf(p));
    host.command('preset-apply', { preset: 'small' });
    await waitFor('狭いが届く', () => areaOf(p) === clean(sq(60)) && areaOf(q) === clean(sq(60)));

    // そのまま・前の版 → 触らない
    host.command('preset-apply', { preset: 'keep' });
    host.command('preset-apply', { preset: 'old' });
    await sleep(800);
    expect(areaOf(p)).toBe(clean(sq(60)));

    // 範囲なし → 消える
    host.command('preset-apply', { preset: 'none' });
    await waitFor('範囲が消える', () => areaOf(p) === 'null' && areaOf(q) === 'null');

    // 配役のあとは入れられる。試合中は入れられない（範囲も変わらない）
    host.command('preset-apply', { preset: 'wide', durations: DUR });
    await waitFor('広い', () => areaOf(p) === clean(sq(200)));
    host.command('assign');
    await waitFor('配役', () => !!p.state.me?.role);
    host.command('preset-apply', { preset: 'small', durations: DUR });
    await waitFor('配役のあとは入る', () => areaOf(p) === clean(sq(60)));
    host.command('start');
    await waitFor('開始', () => p.state.game?.timer?.status === 'running');
    host.command('preset-apply', { preset: 'wide', durations: DUR });
    await waitFor('試合中は断る', () => host.state.lastReject?.op === 'preset-apply' && host.state.lastReject.reason === 'not-allowed');
    await sleep(500);
    expect(areaOf(p)).toBe(clean(sq(60)));

    // 記録：プリセットから入った範囲には preset の印
    const rows = (await log()).filter((r) => r.kind === 'area');
    const via = rows.map((r) => (JSON.parse(r.data ?? '{}') as { preset?: string }).preset);
    expect(via).toEqual(['wide', 'small', 'none', 'wide', 'small']);
    void phaseOf;
  });
});
