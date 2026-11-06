/**
 * 主催者の「次に進む」の確認。手元に本物のサーバー（wrangler dev）を立てる。
 *
 * - 押すと、いまの段階がちょうど2秒後に終わり、次の段階が本来の長さで始まる（全員が同じ区切りを持つ）
 * - 二度押し（同じ画面からの続けての操作）は1回分しか進まない
 * - 一時停止中は進めない。最後の段階で押すと、2秒後に結果発表待ちになる
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { START_LEAD_MS } from '../src/shared/rules';
import { boundaryTimes, positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.NEXT_PORT ?? 8803);
const TOKEN = 'nexttoken';
const GAME = `next${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで20秒・追跡開始まで20秒・ゲーム60秒・広場に戻るまで20秒 */
const DUR = [20_000, 20_000, 60_000, 20_000];

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-next-')), '--var', `HOST_TOKEN:${TOKEN}`],
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
  clients.push(c);
  return c;
}

/** その人の手元で見えている段階（サーバーの時計に直して計算する） */
function phaseOf(c: GameClient): number | 'done' {
  const timer = c.state.game?.timer;
  const now = c.serverNow();
  if (!timer || now === null) return -1;
  const pos = positionAt(timer, now);
  return pos.kind === 'done' ? 'done' : pos.index;
}

describe('主催者の「次に進む」', () => {
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

  it('いまの段階が2秒後に終わり、全員そろって次へ。二度押しは1回分。止めている間は進まない', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり'].map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('2人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 2);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer' && players.every((p) => p.state.game?.timer?.status === 'running'));
    await sleep(1_000);

    // 逃走開始まで → 追跡開始まで
    let cv = host.state.game!.cv;
    let pressedAt = host.serverNow()!;
    host.command('skip');
    await waitFor('次に進む が届く', () => players.every((p) => (p.state.game?.cv ?? 0) > cv));
    const timer = players[0].state.game!.timer!;
    // 全員が同じ区切りを持つ
    expect(JSON.stringify(players[1].state.game!.timer)).toBe(JSON.stringify(timer));
    // 次の段階は、押してからちょうど2秒後に始まる（サーバーが受け取るまでの時間だけ遅れてよい）
    const b = boundaryTimes(timer)!;
    expect(b[1] - pressedAt).toBeGreaterThanOrEqual(START_LEAD_MS);
    expect(b[1] - pressedAt).toBeLessThan(START_LEAD_MS + 1_000);
    // 後ろの段階の長さは変わらない
    expect([b[2] - b[1], b[3] - b[2], b[4] - b[3]]).toEqual([DUR[1], DUR[2], DUR[3]]);
    await sleep(START_LEAD_MS + 500);
    expect(players.map(phaseOf)).toEqual([1, 1]);

    // 二度押し：同じ画面から続けて2回 → 1回分だけ（追跡開始まで → ゲーム）
    cv = host.state.game!.cv;
    host.command('skip');
    host.command('skip');
    await waitFor('二度押しの2回目は断られる', () => host.state.lastReject?.reason === 'stale');
    await sleep(START_LEAD_MS + 500);
    expect(players.map(phaseOf)).toEqual([2, 2]);
    expect(host.state.game!.cv).toBe(cv + 1);

    // 一時停止中は進めない
    host.command('pause');
    await waitFor('一時停止', () => host.state.game?.timer?.status === 'paused');
    host.command('skip');
    await waitFor('止めている間は断られる', () => host.state.lastReject?.reason === 'not-allowed');
    host.command('resume');
    await waitFor('再開', () => host.state.game?.timer?.status === 'running');
    await sleep(START_LEAD_MS + 300);

    // ゲーム → 広場に戻るまで → 結果発表待ち
    host.command('skip');
    await sleep(START_LEAD_MS + 500);
    expect(players.map(phaseOf)).toEqual([3, 3]);
    pressedAt = host.serverNow()!;
    host.command('skip');
    await waitFor('最後の段階で押すと、2秒後に終わる', () => players.every((p) => phaseOf(p) === 'done'), 6_000);
    expect(host.serverNow()! - pressedAt).toBeGreaterThanOrEqual(START_LEAD_MS - 200);
    expect(host.state.game?.stage).toBe('timer');
  }, 120_000);
});
