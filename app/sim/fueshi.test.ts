/**
 * 増やし鬼の確認。手元に本物のサーバー（wrangler dev）を立て、5人（鬼1・逃走者4）で回す。
 *
 * - 増やし鬼のプリセットをデッキへ入れると、遊び方が増やし鬼になる
 * - 捕まった逃走者は牢屋に入らず、その場で鬼になる（人数・画面・捕まえた数）
 * - 主催者が捕獲を取り消すと逃走者に戻る。やり直すと全員が最初の役に戻る
 * - 逃走者が1人もいなくなったら、ゲームの段階が終わる。時間切れなら「逃げ切り N人」（勝ち負けの言葉は出さない）
 * - ドロケイのプリセットへ戻すと、いつもの牢屋に戻る
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore, type Notice } from '../src/client/core/game-client';
import { positionAt } from '../src/shared/schedule';
import { hostStatus, participantView } from '../src/shared/viewmodel';

const PORT = Number(process.env.FUESHI_PORT ?? 8823);
const TOKEN = 'fueshitoken';
const GAME = `fueshi${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで2秒・追跡開始まで2秒・ゲーム90秒・広場に戻るまで4秒 */
const DUR = [2_000, 2_000, 90_000, 4_000];
const SHORT = [2_000, 2_000, 6_000, 3_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(40);
  }
  throw new Error(`時間切れ：${label}`);
}

let server: ChildProcess | null = null;
const clients: GameClient[] = [];
const notices = new Map<GameClient, Notice[]>();

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-fueshi-')), '--var', `HOST_TOKEN:${TOKEN}`],
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
  const got: Notice[] = [];
  notices.set(c, got);
  let seq = 0;
  c.subscribe(() => {
    const n = c.state.notice;
    if (n && n.seq !== seq) {
      seq = n.seq;
      got.push(n);
    }
  });
  c.start();
  clients.push(c);
  return c;
}

const lastNotice = (c: GameClient, kind: string) => [...(notices.get(c) ?? [])].reverse().find((n) => n.kind === kind);

function phaseOf(c: GameClient): number | 'done' {
  const timer = c.state.game?.timer;
  const now = c.serverNow();
  if (!timer || now === null) return -1;
  const pos = positionAt(timer, now);
  return pos.kind === 'done' ? 'done' : pos.index;
}

async function debug(): Promise<{ people: { pid: string; caughtAssign: number; freeUntil: number | null }[]; evidence: { runner: string }[] }> {
  const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}


describe('増やし鬼', () => {
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

  it('捕まったら鬼になる・取り消すと戻る・やり直すと戻る・全員が鬼で終わる・時間切れは逃げ切り', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか', 'きい', 'しろ'].map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('5人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 5);
    // 増やし鬼のプリセットをデッキへ入れる（鬼1:逃走者9 → 5人なら鬼1・逃走者4）
    expect(host.state.host?.presets?.some((p) => p.id === 'p4' && p.mode === 'fueshi')).toBe(true);
    host.command('preset-apply', { preset: 'p4', durations: DUR });
    await waitFor('増やし鬼になる', () => players.every((p) => p.state.game?.mode === 'fueshi') && JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const oni = players.find((p) => p.state.me!.role === 'oni')!;
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    expect(runners.length).toBe(4);
    const [r1, r2, r3, r4] = runners;
    host.command('start');
    await waitFor('ゲームの段階', () => players.every((p) => phaseOf(p) === 2), 15_000);
    await sleep(300);

    // ---- 捕まったら、牢屋に入らず鬼になる ----
    host.command('capture', { pid: r1.state.me!.pid, by: oni.state.me!.pid });
    await waitFor('r1 が鬼になる', () => r1.state.me?.role === 'oni' && players.every((p) => p.state.game?.counts.oni === 2 && p.state.game?.counts.runner === 3));
    expect(r1.state.me!.caught).toBeNull();
    expect(r1.state.me!.turned).toBe(true);
    expect(oni.state.me!.turned).toBeUndefined();
    expect(r1.state.game!.counts.caught).toBe(0);
    expect(r1.state.game!.turned).toBe(1);
    expect(lastNotice(r1, 'caught')?.other?.name).toBe(oni.state.me!.name);
    await waitFor('鬼に「捕まえた」', () => oni.state.me?.catches === 1);
    // 画面：鬼の画面になり、「ここからは鬼」と出る。逃走者には「捕まったら鬼になる」
    const v1 = participantView(r1.state.game!, r1.state.me!, r1.serverNow()!, true, true);
    expect(v1.role).toBe('鬼');
    expect(v1.touch).toBe('oni');
    expect(v1.caught).toBe(false);
    expect(v1.message).toContain('ここからは鬼');
    const v2 = participantView(r2.state.game!, r2.state.me!, r2.serverNow()!, true, true);
    expect(v2.message).toContain('鬼になる');
    expect(v2.runners).toBe('残り3/4');
    expect(v2.rescue).toBe('none');

    // ---- 鬼になった人が、本物の手順（長押し→鬼を選ぶ）で捕まえられる ----
    r2.holdStart(Date.now());
    await waitFor('r2 の「捕まった」が開く', () => r2.state.me?.claim != null);
    r2.holdEnd(Date.now());
    host.command('capture', { pid: r2.state.me!.pid, by: r1.state.me!.pid });
    await waitFor('r2 も鬼になる', () => r2.state.me?.role === 'oni' && r2.state.game?.counts.runner === 2);
    await waitFor('r1 の捕まえた数', () => r1.state.me?.catches === 1);
    expect(r2.state.me!.claim).toBeNull();

    // ---- 主催者の一覧に並び、取り消すと逃走者に戻る ----
    await waitFor('主催者の一覧', () => host.state.host?.capture?.runners.filter((r) => r.caught).length === 2);
    expect(host.state.host!.capture!.runners.length).toBe(4);
    expect(host.state.host!.capture!.runners.find((r) => r.pid === r2.state.me!.pid)?.byName).toBe(r1.state.me!.name);
    host.command('release', { pid: r2.state.me!.pid });
    await waitFor('r2 が逃走者に戻る', () => r2.state.me?.role === 'runner' && players.every((p) => p.state.game?.counts.runner === 3 && p.state.game?.counts.oni === 2));
    expect(r2.state.me!.turned).toBeUndefined();
    await waitFor('r1 の捕まえた数が戻る', () => r1.state.me?.catches === 0);
    expect(r2.state.game!.turned).toBe(1);

    // ---- やり直すと、全員が最初の役に戻る ----
    host.command('reset');
    await waitFor('やり直し', () => players.every((p) => p.state.game?.stage === 'assigned'));
    await waitFor('r1 も逃走者に戻る', () => r1.state.me?.role === 'runner' && players.every((p) => p.state.game?.counts.oni === 1 && p.state.game?.counts.runner === 4));
    expect(r1.state.game!.turned).toBe(0);
    expect(oni.state.me!.role).toBe('oni');

    // ---- 全員が鬼になったら、ゲームの段階が終わる ----
    host.command('start');
    await waitFor('ゲームの段階（2回目）', () => players.every((p) => phaseOf(p) === 2), 15_000);
    await sleep(300);
    for (const r of [r1, r2, r3]) {
      host.command('capture', { pid: r.state.me!.pid, by: oni.state.me!.pid });
      await waitFor('鬼になる', () => r.state.me?.role === 'oni');
    }
    expect(r4.state.game!.allCaughtAt).toBeNull();
    expect(r4.state.game!.counts).toMatchObject({ oni: 4, runner: 1, caught: 0 });
    host.command('capture', { pid: r4.state.me!.pid, by: r3.state.me!.pid });
    await waitFor('全員が鬼', () => players.every((p) => p.state.game?.allCaughtAt != null && p.state.game?.counts.runner === 0 && p.state.game?.counts.oni === 5));
    await waitFor('ゲームの段階が終わる', () => players.every((p) => phaseOf(p) === 3 || phaseOf(p) === 'done'), 8_000);
    const v4 = participantView(r4.state.game!, r4.state.me!, r4.serverNow()!, true, true);
    expect(v4.message).toContain('全員が鬼になった');
    await waitFor('結果', () => players.every((p) => p.state.game?.stage === 'result'), 15_000);
    expect(host.state.game!.result).toBe('oni');
    const ve = participantView(r4.state.game!, r4.state.me!, r4.serverNow()!, true, true);
    expect(ve.big).toBe('全員が鬼になった');
    expect(ve.outcome).toBeNull();
    expect(hostStatus(host.state.game!, host.serverNow()!).big).toBe('全員が鬼になった');

    // ---- 次の配役：また鬼1人から。時間切れなら「逃げ切り」 ----
    host.command('durations', { durations: SHORT });
    await waitFor('短い時間', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(SHORT));
    host.command('assign');
    await waitFor('次の配役', () => players.every((p) => p.state.game?.stage === 'assigned' && p.state.game?.counts.oni === 1 && p.state.game?.counts.runner === 4 && p.state.game?.turned === 0));
    await waitFor('役が届く', () => players.every((p) => p.state.me?.assignId === p.state.game?.assignId && p.state.me?.role));
    expect(players.filter((p) => p.state.me!.role === 'oni').length).toBe(1);
    expect(players.every((p) => p.state.me!.turned === undefined)).toBe(true);
    const oni2 = players.find((p) => p.state.me!.role === 'oni')!;
    const run2 = players.filter((p) => p.state.me!.role === 'runner');
    host.command('start');
    await waitFor('ゲームの段階（3回目）', () => players.every((p) => phaseOf(p) === 2), 15_000);
    await sleep(300);
    host.command('capture', { pid: run2[0].state.me!.pid, by: oni2.state.me!.pid });
    await waitFor('1人が鬼になる', () => run2[0].state.me?.role === 'oni');
    await waitFor('時間切れで結果', () => players.every((p) => p.state.game?.stage === 'result'), 20_000);
    expect(host.state.game!.result).toBe('runner');
    const vs = participantView(run2[1].state.game!, run2[1].state.me!, run2[1].serverNow()!, true, true);
    expect(vs.big).toBe('逃げ切り 3人');
    expect(vs.word?.[0]).toBe('逃げ切った');
    const vt = participantView(run2[0].state.game!, run2[0].state.me!, run2[0].serverNow()!, true, true);
    expect(vt.word?.[0]).toBe('終了');

    // ---- ドロケイのプリセットへ戻すと、捕まった人は牢屋に入る（鬼にならない） ----
    host.command('preset-apply', { preset: 'p2', durations: DUR });
    await waitFor('ドロケイに戻る', () => players.every((p) => p.state.game?.mode === 'dorokei'));
    host.command('ratio', { ratio: { oni: 1, runner: 4 } });
    await waitFor('割合', () => host.state.game?.ratio?.runner === 4);
    host.command('assign');
    await waitFor('配役（ドロケイ）', () => players.every((p) => p.state.me?.assignId === p.state.game?.assignId && p.state.me?.role) && host.state.game?.stage === 'assigned');
    const oni3 = players.find((p) => p.state.me!.role === 'oni')!;
    const run3 = players.filter((p) => p.state.me!.role === 'runner');
    host.command('start');
    await waitFor('ゲームの段階（4回目）', () => players.every((p) => phaseOf(p) === 2), 15_000);
    await sleep(300);
    host.command('capture', { pid: run3[0].state.me!.pid, by: oni3.state.me!.pid });
    await waitFor('牢屋に入る', () => run3[0].state.me?.caught != null && run3[0].state.game?.counts.caught === 1);
    expect(run3[0].state.me!.role).toBe('runner');
    expect(run3[0].state.game!.counts).toMatchObject({ oni: 1, runner: 4 });
  });
});
