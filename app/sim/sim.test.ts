/**
 * 300人の機械テスト。wrangler dev で本物のサーバー（Durable Object）を立て、
 * 仮想参加者300人を、ブラウザと同じしくみ（GameClient）でつなぐ。
 *
 * 混ぜる壊れ方：回線の遅れ（行きと帰りで別々・ときどき1.5〜3秒の詰まり）、突然の切断、
 * スマホの時計のずれ（±5分）、2人の主催者の同時押し、同じ名前の二重入室、試合中のサーバー再起動、一時停止と再開。
 *
 * 実行：npm run sim（人数を変えるなら SIM_N=50 npm run sim）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { allocateCounts } from '../src/shared/allocate';
import type { ServerMsg } from '../src/shared/protocol';
import { ROLES } from '../src/shared/rules';
import { participantView, type PhoneView } from '../src/shared/viewmodel';
import { LaggySocket } from './laggy-socket';

const N = Number(process.env.SIM_N ?? 300);
const PORT = Number(process.env.SIM_PORT ?? 8799);
const TOKEN = 'simtoken';
const GAME = `sim${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** テスト用に短くした1ラウンド：逃走開始まで3秒→追跡開始まで4秒→ゲーム8秒→戻る4秒 */
const DURATIONS = [3_000, 4_000, 8_000, 4_000];
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-sim-'));

// ---------- 道具 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261104);

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

/** 回線の質：半分は良い、3割強は普通、残りは悪い（時々1.5〜3秒詰まる） */
function lagProfile(): () => number {
  const kind = rand();
  if (kind < 0.5) return () => 20 + rand() * 60;
  if (kind < 0.85) return () => 60 + rand() * 190;
  return () => (rand() < 0.05 ? 1_500 + rand() * 1_500 : 150 + rand() * 450);
}

let diagnose: () => Promise<string> = async () => '';

async function waitFor(label: string, cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`時間切れ：${label}\n${await diagnose().catch((e) => String(e))}`);
}

function pick<T>(xs: T[], k: number): T[] {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

// ---------- サーバー ----------

let server: ChildProcess | null = null;
let serverLog = '';

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--var', `HOST_TOKEN:${TOKEN}`],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  server.stdout!.on('data', (d: Buffer) => (serverLog += d));
  server.stderr!.on('data', (d: Buffer) => (serverLog += d));
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
  throw new Error(`サーバーが立ち上がらない\n${serverLog.slice(-3000)}`);
}

async function stopServer(): Promise<void> {
  const p = server;
  server = null;
  if (!p?.pid) return;
  try {
    process.kill(-p.pid, 'SIGTERM');
  } catch {
    // 終わっている
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        process.kill(-p.pid!, 'SIGKILL');
      } catch {
        // 終わっている
      }
      resolve();
    }, 5_000);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE);
      await sleep(200);
    } catch {
      return;
    }
  }
}

interface DebugPerson {
  pid: string;
  num: number;
  name: string;
  role: string | null;
  assignId: number;
  ackId: number;
  removed: boolean;
}

async function debug(): Promise<{ now: number; game: { assignId: number; round: number; counts: { oni: number; runner: number } }; people: DebugPerson[] }> {
  const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
  return r.json() as never;
}

// ---------- 仮想参加者 ----------

interface Bot {
  name: string;
  skew: number;
  client: GameClient;
  sockets: LaggySocket[];
  privacyViolations: number;
}

function makeBot(name: string): Bot {
  const skew = Math.round((rand() - 0.5) * 600_000);
  const up = lagProfile();
  const down = lagProfile();
  const bot = { name, skew, sockets: [], privacyViolations: 0 } as unknown as Bot;
  bot.client = new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: () => Date.now() + skew,
      storage: memoryStore(),
      random: rand,
      createSocket: (url) => {
        const s = new LaggySocket(url, up, down, (raw) => inspect(bot, raw));
        bot.sockets.push(s);
        return s;
      },
    },
    { kind: 'player' },
  );
  return bot;
}

/** 参加者に届いたものに、他人の情報や主催者向けの集計が混ざっていないか */
function inspect(bot: Bot, raw: string): void {
  const msg = JSON.parse(raw) as ServerMsg;
  if (msg.t !== 'snap') return;
  if (msg.host) bot.privacyViolations++;
  const mine = bot.client.state.identity?.pid;
  if (msg.me && mine && msg.me.pid !== mine) bot.privacyViolations++;
}

const hostSockets: LaggySocket[][] = [];
function makeHost(): GameClient {
  const mine: LaggySocket[] = [];
  hostSockets.push(mine);
  return new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: () => Date.now(),
      storage: memoryStore(),
      createSocket: (url) => {
        const s = new LaggySocket(url, () => 10, () => 10);
        mine.push(s);
        return s;
      },
    },
    { kind: 'host', token: TOKEN },
  );
}

function viewOf(bot: Bot, serverNow?: number): PhoneView {
  const s = bot.client.state;
  return participantView(s.game!, s.me!, serverNow ?? bot.client.serverNow()!, s.online);
}

/**
 * 時計の誤差（見積もったサーバー時刻 − 本当のサーバー時刻）と、画面の数字が本当とずれている人の数。
 * 往復だけからは行きと帰りの差は分からないので、誤差は必ず「往復の半分」以内、というのが理屈の上の保証。
 * それが守られているか（outOfBound）と、往復の半分が 100ms 以下＝主催者画面で「合っている」と数えられる人の数を見る。
 */
function measure(bots: Bot[]) {
  const errs: number[] = [];
  let wrongBig = 0;
  let wrongStep = 0;
  let outOfBound = 0;
  let synced = 0;
  let syncedMaxErr = 0;
  let signedSum = 0;
  for (const b of bots) {
    const truth = Date.now(); // wrangler dev は同じ機械なので、これがサーバーの時計
    const est = b.client.serverNow()!;
    const err = Math.abs(est - truth);
    signedSum += est - truth;
    const bound = b.client.syncError()!;
    errs.push(err);
    if (err > bound + 5) outOfBound++;
    if (bound <= 100) {
      synced++;
      syncedMaxErr = Math.max(syncedMaxErr, err);
    }
    const v = viewOf(b, est);
    const t = viewOf(b, truth);
    if (v.big !== t.big) wrongBig++;
    if (v.step !== t.step) wrongStep++;
  }
  errs.sort((a, b) => a - b);
  const at = (q: number) => errs[Math.min(errs.length - 1, Math.floor(q * errs.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    max: errs[errs.length - 1],
    mean: signedSum / bots.length,
    wrongBig,
    wrongStep,
    outOfBound,
    synced,
    syncedMaxErr,
    n: bots.length,
  };
}

const reports: string[] = [];
function report(label: string, s: ReturnType<typeof measure>): void {
  reports.push(
    `${label}: 時計の誤差 中央値 ${s.p50.toFixed(1)}ms / 95% ${s.p95.toFixed(1)}ms / 最大 ${s.max.toFixed(1)}ms（平均の向き ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)}ms）、` +
      `「合っている」と数えられた人 ${s.synced}/${s.n}（その人たちの最大誤差 ${s.syncedMaxErr.toFixed(1)}ms）、` +
      `誤差が保証（往復の半分）を超えた人 ${s.outOfBound}、` +
      `その瞬間に秒の数字が本当とずれていた人 ${s.wrongBig}/${s.n}、段階がずれていた人 ${s.wrongStep}/${s.n}`,
  );
}

// ---------- テスト側の処理の詰まり ----------
// 300人分を1つの Node で動かすので、テスト側の処理待ちが「回線の遅れ」に上乗せされる。その大きさも記録する
const lagSamples: number[] = [];
let lagTimer: ReturnType<typeof setInterval> | null = null;
function startLagMonitor(): void {
  let last = Date.now();
  lagTimer = setInterval(() => {
    const now = Date.now();
    lagSamples.push(Math.max(0, now - last - 50));
    last = now;
  }, 50);
}
function lagSummary(): string {
  const xs = [...lagSamples].sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  return `テスト側の処理の詰まり：中央値 ${at(0.5)}ms / 95% ${at(0.95)}ms / 最大 ${xs[xs.length - 1] ?? 0}ms`;
}

// ---------- 本体 ----------

const bots: Bot[] = [];
let hostA: GameClient | null = null;
let hostB: GameClient | null = null;

describe(`機械テスト（仮想参加者 ${N}人）`, () => {
  afterAll(async () => {
    if (lagTimer) clearInterval(lagTimer);
    reports.push(lagSummary());
    for (const b of bots) b.client.stop();
    hostA?.stop();
    hostB?.stop();
    await stopServer();
    const text = [`機械テストの結果（仮想参加者 ${N}人、${new Date().toISOString()}）`, ...reports.map((r) => `- ${r}`), ''].join('\n');
    writeFileSync(join(process.cwd(), 'sim', `last-report-${N}.md`), text);
    process.stdout.write(`\n${text}\n`);
  });

  it('入室→配役→タイマー→結果発表を2ラウンド。壊れ方を混ぜても、全員が自分の役を受け取り、区切りの時刻が一致する', async () => {
    await startServer();
    startLagMonitor();
    diagnose = async () => {
      const d = await debug();
      const states = bots.map((b) => ({
        name: b.name,
        online: b.client.state.online,
        phase: b.client.state.phase,
        me: b.client.state.me,
        stage: b.client.state.game?.stage,
        assignId: b.client.state.game?.assignId,
      }));
      const notReady = states.filter((s) => !(s.me?.role && s.me.assignId === s.assignId));
      return JSON.stringify(
        {
          hostA: hostA && { online: hostA.state.online, phase: hostA.state.phase, sockets: hostSockets[0]?.map((s) => s.readyState) },
          host: hostA?.state.host,
          hostGame: hostA?.state.game && { stage: hostA.state.game.stage, assignId: hostA.state.game.assignId, cv: hostA.state.game.cv },
          serverGame: d.game,
          serverPeopleNotAcked: d.people.filter((p) => !p.removed && p.ackId !== d.game.assignId).slice(0, 5),
          botsNotReady: notReady.slice(0, 5),
          botsNotReadyCount: notReady.length,
        },
        null,
        1,
      ).slice(0, 4000);
    };
    const A = (hostA = makeHost());
    const B = (hostB = makeHost());
    A.start();
    B.start();
    await waitFor('主催者2人がつながる', () => A.state.phase === 'ready' && B.state.phase === 'ready');

    // --- 入室：N人と、同じ名前の1人 ---
    for (let i = 0; i < N; i++) bots.push(makeBot(`bot${i}`));
    const dup = makeBot('bot0');
    const everyone = [...bots, dup];
    for (const [k, b] of everyone.entries()) {
      b.client.join(b.name);
      b.client.start();
      if (k % 25 === 24) await sleep(100);
    }
    await waitFor('全員が入室', () => everyone.every((b) => b.client.state.identity) && A.state.host?.total === N + 1, 90_000);
    expect(A.state.host!.dupNames).toHaveLength(1);
    reports.push(`入室：${N + 1}人（同じ名前の1組を主催者画面が検出）`);

    // --- 同じ名前の片方を外す ---
    A.command('remove', { pid: dup.client.state.identity!.pid });
    await waitFor('同じ名前の片方を外す', () => A.state.host?.total === N && dup.client.state.me?.removed === true);
    dup.client.stop();

    // --- 時間をテスト用に短くする ---
    A.command('durations', { durations: DURATIONS });
    await waitFor('時間の設定が全員に届く', () => JSON.stringify(B.state.game?.durations) === JSON.stringify(DURATIONS));

    // --- 2人の主催者が同時に配役を押す → 片方だけ通る ---
    expect(B.state.game!.cv).toBe(A.state.game!.cv);
    A.command('assign');
    B.command('assign');
    await waitFor(
      '同時押しの決着',
      () => A.state.game?.assignId === 1 && B.state.game?.assignId === 1 && (A.state.lastReject !== null || B.state.lastReject !== null),
    );
    const rejects = [A.state.lastReject, B.state.lastReject].filter(Boolean);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.reason).toBe('stale');
    expect((await debug()).game.assignId).toBe(1);
    reports.push('同時押し：2人の主催者が同時に配役 → 1回だけ配役され、もう片方は「古い画面からの操作」で断られた');

    // --- 全員が自分の役を受け取る ---
    await waitFor(
      'ラウンド1：全員が役を受け取る',
      () => bots.every((b) => b.client.state.me?.assignId === 1 && b.client.state.me.role) && A.state.host?.received === N,
      90_000,
    );
    let d = await debug();
    const roleOf = new Map(d.people.map((p) => [p.pid, p.role]));
    for (const b of bots) expect(b.client.state.me!.role).toBe(roleOf.get(b.client.state.identity!.pid));
    const [oni, runner] = allocateCounts(N, ROLES);
    expect(d.game.counts).toEqual({ oni, runner });
    expect(bots.filter((b) => b.client.state.me!.role === 'oni')).toHaveLength(oni);
    reports.push(`ラウンド1の配役：鬼 ${oni}人・逃走者 ${runner}人、${N}人全員が自分の役を受け取り、サーバーの記録と一致`);

    // --- ラウンド1：開始。途中で60人が突然切れ、サーバーも再起動する ---
    A.command('start');
    await waitFor('全員がタイマーに入る', () => bots.every((b) => b.client.state.game?.stage === 'timer'), 60_000);
    const victims = pick(bots, Math.min(60, N));
    for (const v of victims) setTimeout(() => v.sockets.at(-1)?.kill(), rand() * 4_000);
    await sleep(2_500);
    const timerBefore = JSON.stringify((await debug()).game);
    await stopServer();
    await sleep(500);
    await startServer();
    const afterRestart = await debug();
    expect(afterRestart.game.assignId).toBe(1);
    reports.push(`途中で ${victims.length}人の接続を突然切り、サーバーも再起動した（再起動の前後で保存した状態は ${timerBefore === JSON.stringify(afterRestart.game) ? '一致' : '不一致'}）`);
    expect(JSON.stringify(afterRestart.game)).toBe(timerBefore);

    // --- 一時停止→再開 ---
    await waitFor('主催者がつながり直す', () => A.state.online && A.state.phase === 'ready', 60_000);
    await sleep(300);
    A.command('pause');
    await waitFor('一時停止', () => A.state.game?.timer?.status === 'paused');
    await sleep(1_500);
    A.command('resume');
    await waitFor('再開', () => A.state.game?.timer?.status === 'running');

    // --- 全員がつながり直し、同じ区切りの時刻を持っている ---
    await waitFor(
      '全員が同じ区切りの時刻',
      () => {
        const t = JSON.stringify(A.state.game?.timer);
        return bots.every((b) => b.client.state.online && JSON.stringify(b.client.state.game?.timer) === t);
      },
      90_000,
    );
    const r1 = measure(bots);
    report('ラウンド1（切断・再起動・一時停止のあと）', r1);
    d = await debug();
    for (const b of bots) expect(b.client.state.me!.role).toBe(roleOf.get(b.client.state.identity!.pid));

    await waitFor('ラウンド1：全員が結果発表の段階', () => bots.every((b) => viewOf(b).step === 6), 90_000);
    A.command('result', { winner: 'runner' });
    await waitFor(
      'ラウンド1：結果が全員に届く',
      () => bots.every((b) => b.client.state.game?.stage === 'result' && b.client.state.game.result === 'runner'),
    );
    expect(bots.every((b) => viewOf(b).big === '逃走者の勝ち')).toBe(true);

    // --- ラウンド2 ---
    A.command('assign');
    await waitFor(
      'ラウンド2：全員が新しい役を受け取る',
      () => bots.every((b) => b.client.state.me?.assignId === 2 && b.client.state.me.role) && A.state.host?.received === N,
      90_000,
    );
    d = await debug();
    expect(d.game.round).toBe(2);
    const roleOf2 = new Map(d.people.map((p) => [p.pid, p.role]));
    for (const b of bots) expect(b.client.state.me!.role).toBe(roleOf2.get(b.client.state.identity!.pid));
    A.command('start');
    await waitFor('ラウンド2：全員がタイマーに入る', () => bots.every((b) => b.client.state.game?.stage === 'timer'), 60_000);
    await sleep(3_000);
    const r2 = measure(bots);
    report('ラウンド2', r2);
    await waitFor('ラウンド2：全員が結果発表の段階', () => bots.every((b) => viewOf(b).step === 6), 90_000);
    A.command('result', { winner: 'oni' });
    await waitFor('ラウンド2：結果が全員に届く', () => bots.every((b) => b.client.state.game?.result === 'oni' && b.client.state.game.round === 2));

    // --- 静かな時の時計：全員が一斉にではなく、ばらばらに測り直したあと ---
    // （本物のスマホはそれぞれ自分の CPU で動くので、テスト側の詰まりを減らした状態に近い）
    for (const [i, b] of bots.entries()) setTimeout(() => b.client.wake(), i * 40);
    await sleep(bots.length * 40 + 2_000);
    const quiet = measure(bots);
    report('静かな時（ばらばらに測り直したあと）', quiet);

    // --- 全体の確認 ---
    const violations = bots.reduce((s, b) => s + b.privacyViolations, 0);
    reports.push(`他人の役・主催者向けの集計が参加者に届いた回数：${violations}`);
    expect(violations).toBe(0);
    // 誤差は必ず「往復の半分」以内（主催者画面の「時計が合っている」は嘘をつかない）
    expect(r1.outOfBound + r2.outOfBound).toBe(0);
    expect(r1.syncedMaxErr).toBeLessThanOrEqual(100);
    expect(r2.syncedMaxErr).toBeLessThanOrEqual(100);
    expect(quiet.outOfBound).toBe(0);
    expect(quiet.syncedMaxErr).toBeLessThanOrEqual(100);
    expect(r1.wrongStep + r2.wrongStep).toBeLessThanOrEqual(Math.ceil(N * 0.02));
  });
});
