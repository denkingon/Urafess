/**
 * 牢屋と終わり方の確認。手元に本物のサーバー（wrangler dev）を立て、鬼1・逃走者2で回す。
 *
 * - 同時に長押し（牢屋の人「助けて」×外の逃走者「助ける」）で、重なった瞬間に出る
 * - 牢屋の人のスマホが「助ける番号」を拾ったら、その瞬間に出る（選ぶ画面は無い）
 * - 出た直後は捕まらない。1回の長押しで1人（助ける人は RESCUE_GAP_MS のあいだ次を出せない）
 * - ミッション成功：1人・全員。牢屋に誰もいなければ断る
 * - 鬼のマイクが「助ける番号」を拾っても、捕獲の手がかりにならない
 * - 逃走者が全員牢屋に入ったら、2秒後に全員そろってゲームの段階が終わり、時間が0になると結果は鬼の勝ち（アプリが決める）
 * - 時間切れで1人でも外にいれば、逃走者の勝ち（アプリが決める）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore, type Notice } from '../src/client/core/game-client';
import { RESCUE_GAP_MS, RESCUE_IMMUNE_MS, START_LEAD_MS } from '../src/shared/rules';
import { boundaryTimes, positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.JAIL_PORT ?? 8811);
const TOKEN = 'jailtoken';
const GAME = `jail${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで2秒・追跡開始まで2秒・ゲーム90秒・広場に戻るまで4秒 */
const DUR = [2_000, 2_000, 90_000, 4_000];

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-jail-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

describe('牢屋と終わり方', () => {
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

  it('牢屋から出る（同時・音・ミッション）、全員で終わる、時間切れ', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか'].map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 3);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('ratio', { ratio: { oni: 1, runner: 2 } });
    await waitFor('割合', () => host.state.game?.ratio?.oni === 1 && host.state.game?.ratio?.runner === 2);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const oni = players.find((p) => p.state.me!.role === 'oni')!;
    let [r1, r2] = players.filter((p) => p.state.me!.role === 'runner');
    expect(r1 && r2).toBeTruthy();
    // 助ける番号は、捕まったときの番号と別で、部屋の中で重ならない
    const codes = players.flatMap((p) => [p.state.me!.code, p.state.me!.rcode]).filter(Boolean);
    expect(new Set(codes).size).toBe(codes.length);
    expect(oni.state.me!.rcode).toBeNull();

    host.command('start');
    await waitFor('ゲームの段階', () => players.every((p) => phaseOf(p) === 2), 15_000);
    await sleep(300);

    // ---- 同時に長押しで出る ----
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 が牢屋', () => r1.state.me?.caught != null && players.every((p) => p.state.game?.counts.caught === 1));
    expect(r1.state.game!.allCaughtAt).toBeNull();
    r2.rescueStart(Date.now());
    await sleep(150);
    r1.rescueStart(Date.now());
    await waitFor('同時の長押しで r1 が出る', () => r1.state.me?.caught == null && r1.state.game?.counts.caught === 0);
    r1.rescueEnd(Date.now());
    r2.rescueEnd(Date.now());
    expect(lastNotice(r1, 'freed')?.via).toBe('together');
    expect(lastNotice(r1, 'freed')?.other?.name).toBe(r2.state.me!.name);
    await waitFor('r2 に「出した」', () => lastNotice(r2, 'saved') !== undefined);
    expect(r2.state.me!.rescues).toBe(1);
    const until = r1.state.me!.freeUntil!;
    expect(until - r1.serverNow()!).toBeGreaterThan(RESCUE_IMMUNE_MS - 2_000);

    // ---- 出た直後は捕まらない ----
    r1.holdStart(Date.now());
    await waitFor('捕まらない知らせ', () => lastNotice(r1, 'immune') !== undefined);
    r1.holdEnd(Date.now());
    expect(r1.state.me!.caught).toBeNull();

    // ---- 音で出る：牢屋の人のスマホが「助ける番号」を拾った瞬間 ----
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 がまた牢屋', () => r1.state.me?.caught != null);
    await sleep(RESCUE_GAP_MS + 200);
    // 鬼のマイクが助ける番号を拾っても、捕獲の手がかりにならない
    oni.heard(r2.state.me!.rcode!);
    // 助ける人は「助ける」を押している（押した瞬間から鳴る）。牢屋の人は押していない
    r2.rescueStart(Date.now());
    await sleep(300);
    const heardAt = Date.now();
    r1.heard(r2.state.me!.rcode!);
    await waitFor('音で r1 が出る', () => r1.state.me?.caught == null);
    r2.rescueEnd(Date.now());
    expect(Date.now() - heardAt).toBeLessThan(2_000);
    expect(lastNotice(r1, 'freed')?.via).toBe('sound');
    const dbg = await debug();
    expect(dbg.evidence.length).toBe(0);
    expect(lastNotice(oni, 'heard')).toBeUndefined();

    // ---- 1回の長押しで1人：出した直後に、もう1人は出せない（RESCUE_GAP_MS の間） ----
    await sleep(RESCUE_IMMUNE_MS);
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 がまた牢屋（3回目）', () => r1.state.me?.caught != null);
    r2.rescueStart(Date.now());
    await sleep(300);
    r1.heard(r2.state.me!.rcode!);
    await waitFor('出る', () => r1.state.me?.caught == null);
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 がまた牢屋（4回目）', () => r1.state.me?.caught != null);
    // 同じ長押しのまま、もう1人は出せない（3秒たっても、押し直さなければ）
    r1.heard(r2.state.me!.rcode!);
    await sleep(RESCUE_GAP_MS + 300);
    r1.heard(r2.state.me!.rcode!);
    await sleep(800);
    expect(r1.state.me!.caught).not.toBeNull();
    // 重なっていた「助けて」も、使い終わった長押しには合わない
    r1.rescueStart(Date.now());
    await sleep(800);
    expect(r1.state.me!.caught).not.toBeNull();
    r1.rescueEnd(Date.now());
    r2.rescueEnd(Date.now());

    // ---- 取り消し：主催者の取り消しで「全員が牢屋」も戻る ----
    host.command('capture', { pid: r2.state.me!.pid });
    await waitFor('全員が牢屋（間違い）', () => host.state.game?.allCaughtAt != null);
    host.command('release', { pid: r2.state.me!.pid });
    await waitFor('取り消しで戻る', () => host.state.game?.allCaughtAt === null && r2.state.me?.caught == null);
    // ゲームの段階は2秒後に終わってしまうので、ここで次の配役からやり直す
    await waitFor('結果まで待つ', () => host.state.game?.stage === 'result', 10_000);
    host.command('assign');
    await waitFor('配役し直し', () => players.every((p) => p.state.game?.stage === 'assigned' && p.state.me?.role));
    const ro = players.filter((p) => p.state.me!.role === 'runner');
    [r1, r2] = [ro[0], ro[1]];
    host.command('start');
    await waitFor('ゲームの段階', () => players.every((p) => phaseOf(p) === 2), 15_000);
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 が牢屋', () => r1.state.me?.caught != null);

    // ---- ミッション成功（1人） ----
    host.command('mission', { n: 1 });
    await waitFor('ミッションで r1 が出る', () => r1.state.me?.caught == null);
    expect(lastNotice(r1, 'freed')?.via).toBe('mission');
    // 牢屋に誰もいなければ断る
    host.command('mission', {});
    await waitFor('誰もいないと断る', () => host.state.lastReject?.reason === 'nobody-jailed');

    // ---- 全員が牢屋に入ったら、2秒後にゲームの段階が終わり、時間が0になると鬼の勝ち ----
    host.command('capture', { pid: r1.state.me!.pid });
    await waitFor('r1 が牢屋', () => r1.state.me?.caught != null);
    const lastAt = host.serverNow()!;
    host.command('capture', { pid: r2.state.me!.pid });
    await waitFor('全員が牢屋', () => players.every((p) => p.state.game?.allCaughtAt != null));
    const b = boundaryTimes(players[0].state.game!.timer!)!;
    expect(b[3] - lastAt).toBeGreaterThanOrEqual(START_LEAD_MS - 50);
    expect(b[3] - lastAt).toBeLessThan(START_LEAD_MS + 1_000);
    // 全員が同じ区切りを持つ
    for (const p of players) expect(JSON.stringify(p.state.game!.timer)).toBe(JSON.stringify(players[0].state.game!.timer));
    // 全員が入ったあとは、出られない
    r1.heard(r2.state.me!.rcode!);
    host.command('mission', {});
    await waitFor('ミッションも断る', () => host.state.lastReject?.reason === 'not-allowed');
    await waitFor('全員そろって広場に戻る段階へ', () => players.every((p) => phaseOf(p) === 3), 5_000);
    await waitFor('時間が0になると、結果はアプリが決める（鬼の勝ち）', () => host.state.game?.stage === 'result', 10_000);
    expect(host.state.game!.result).toBe('oni');
    expect(host.state.game!.resultAuto).toBe(true);
    await waitFor('全員に結果', () => players.every((p) => p.state.game?.stage === 'result' && p.state.game.result === 'oni'));

    // やり直し：アプリが結果を出したあとも、配役済みに戻せる
    host.command('reset');
    await waitFor('やり直し', () => host.state.game?.stage === 'assigned' && host.state.game.result === null);

    // ---- 2ラウンド目：時間切れで1人でも外にいれば逃走者の勝ち ----
    const prevAssign = host.state.game!.assignId;
    host.command('assign');
    await waitFor(
      '2回目の配役',
      () => host.state.game?.assignId === prevAssign + 1 && players.every((p) => p.state.me?.assignId === prevAssign + 1 && p.state.me.role),
    );
    expect(players.every((p) => p.state.game!.allCaughtAt === null && p.state.me!.caught === null && !p.state.me!.freeUntil)).toBe(true);
    const runners2 = players.filter((p) => p.state.me!.role === 'runner');
    host.command('start');
    await waitFor('ゲームの段階', () => players.every((p) => phaseOf(p) === 2), 15_000);
    host.command('capture', { pid: runners2[0].state.me!.pid });
    await waitFor('1人だけ牢屋', () => host.state.game?.counts.caught === 1);
    host.command('skip');
    await waitFor('広場に戻る段階', () => players.every((p) => phaseOf(p) === 3), 6_000);
    await waitFor('結果（逃走者の勝ち）', () => host.state.game?.stage === 'result', 10_000);
    expect(host.state.game!.result).toBe('runner');
    expect(host.state.game!.resultAuto).toBe(true);

    // 主催者が直せる
    host.command('result', { winner: 'oni' });
    await waitFor('主催者が直す', () => host.state.game?.result === 'oni' && host.state.game.resultAuto === false);
    const after = await debug();
    expect(after.people.every((p) => p.freeUntil === null || typeof p.freeUntil === 'number')).toBe(true);
  }, 180_000);
});
