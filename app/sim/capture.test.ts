/**
 * 捕獲の記録の機械テスト。wrangler dev で本物のサーバーを立て、ブラウザと同じしくみ（GameClient）で
 * 仮想参加者をつなぎ、長押し・音の拾い・手動・主催者の手直しを順に流す。
 *
 * 混ぜる壊れ方：回線の遅れ（行きと帰りで別々・ときどき詰まる）、スマホの時計のずれ（±5分）、
 * 長押しの途中の切断、答え待ちの間のサーバー再起動。
 * 音そのもの（スピーカー→マイク）はブラウザの中の話なので、ここでは「鬼のスマホが3桁を拾った」を直接送る。
 * 音の読み取りは test/sound.test.ts と、ヘッドレス Chrome の確認で見る。
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/capture.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import type { CaptureVia } from '../src/shared/capture';
import type { ServerMsg } from '../src/shared/protocol';
import { LaggySocket } from './laggy-socket';

const N = 16;
const PORT = Number(process.env.SIM_PORT ?? 8797);
const TOKEN = 'simtoken';
const GAME = `cap${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで1.5秒→追跡開始まで1.5秒→ゲーム3分→戻る2秒 */
const DURATIONS = [1_500, 1_500, 180_000, 2_000];
const persistDir = mkdtempSync(join(tmpdir(), 'urafess-cap-'));

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
const rand = mulberry32(20261106);

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

/** 半分は良い回線、残りは遅く、ときどき1〜2秒詰まる */
function lagProfile(i: number): () => number {
  if (i % 2 === 0) return () => 20 + rand() * 60;
  return () => (rand() < 0.05 ? 1_000 + rand() * 1_000 : 120 + rand() * 380);
}

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
      // まだ
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

async function waitFor(label: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`時間切れ：${label}`);
}

interface Bot {
  name: string;
  now: () => number;
  client: GameClient;
  sockets: LaggySocket[];
  /** 自分以外の役・主催者向けの集計が届いた回数 */
  leaks: string[];
  /** 届いた候補の鬼（pid） */
  candidatePids: Set<string>;
  /** 届いた手動の一覧の人（pid） */
  rosterPids: Set<string>;
}

function makeBot(i: number): Bot {
  const skew = Math.round((rand() - 0.5) * 600_000);
  const up = lagProfile(i);
  const down = lagProfile(i + 1);
  const bot: Bot = {
    name: `p${i}`,
    now: () => Date.now() + skew,
    client: null as unknown as GameClient,
    sockets: [],
    leaks: [],
    candidatePids: new Set(),
    rosterPids: new Set(),
  };
  bot.client = new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: bot.now,
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

function inspect(bot: Bot, raw: string): void {
  const msg = JSON.parse(raw) as ServerMsg;
  if (msg.t === 'roster') for (const p of msg.people) bot.rosterPids.add(p.pid);
  if (msg.t !== 'snap') return;
  if (msg.host) bot.leaks.push('host');
  const mine = bot.client.state.identity?.pid;
  if (msg.me && mine && msg.me.pid !== mine) bot.leaks.push('me');
  for (const c of msg.me?.claim?.cands ?? []) bot.candidatePids.add(c.pid);
}

function makeHost(): GameClient {
  return new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: () => Date.now(),
      storage: memoryStore(),
      createSocket: (url) => new LaggySocket(url, () => 10, () => 10),
    },
    { kind: 'host', token: TOKEN },
  );
}

interface DebugPerson {
  pid: string;
  num: number;
  name: string;
  role: 'oni' | 'runner' | null;
  caughtAssign: number;
  caughtBy: string | null;
  caughtVia: CaptureVia | null;
}

async function debug(): Promise<{ game: { assignId: number }; people: DebugPerson[] }> {
  const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
  return r.json() as never;
}

const pidOf = (b: Bot) => b.client.state.identity!.pid;
const numOf = (b: Bot) => b.client.state.identity!.num;
const claimOf = (b: Bot) => b.client.state.me?.claim ?? null;
const candPids = (b: Bot) => (claimOf(b)?.cands ?? []).map((c) => c.pid);

/** 長押し：押してから ms 後に離す（押し始めは HOLD_MIN_MS 待ってから送るのを真似て、指を置いた時刻を後から送る） */
async function hold(b: Bot, ms: number): Promise<void> {
  const at = b.now();
  await sleep(500);
  b.client.holdStart(at);
  await sleep(Math.max(0, ms - 500));
  b.client.holdEnd(b.now());
}

const reports: string[] = [];
const bots: Bot[] = [];
let host: GameClient | null = null;

describe('捕獲の記録（機械テスト）', () => {
  afterAll(async () => {
    for (const b of bots) b.client.stop();
    host?.stop();
    await stopServer();
    const text = [`捕獲の記録の機械テスト（仮想参加者 ${N}人、${new Date().toISOString()}）`, ...reports.map((r) => `- ${r}`), ''].join('\n');
    writeFileSync(join(process.cwd(), 'sim', 'capture-report.md'), text);
    process.stdout.write(`\n${text}\n`);
  });

  it('長押し・音・手動・主催者の手直しで、捕まえたのが誰かが記録され、全員の人数がそろう', async () => {
    await startServer();
    const H = (host = makeHost());
    H.start();
    await waitFor('主催者がつながる', () => H.state.phase === 'ready');

    for (let i = 0; i < N; i++) bots.push(makeBot(i));
    for (const b of bots) {
      b.client.join(b.name);
      b.client.start();
    }
    await waitFor('全員が入室', () => bots.every((b) => b.client.state.identity) && H.state.host?.total === N, 30_000);
    H.command('durations', { durations: DURATIONS });
    await waitFor('時間の設定', () => JSON.stringify(H.state.game?.durations) === JSON.stringify(DURATIONS));
    H.command('assign');
    await waitFor('全員が役と3桁を受け取る', () => bots.every((b) => b.client.state.me?.role && b.client.state.me.code), 30_000);

    const oni = bots.filter((b) => b.client.state.me!.role === 'oni');
    const runners = bots.filter((b) => b.client.state.me!.role === 'runner');
    expect(oni.length).toBeGreaterThanOrEqual(4);
    expect(runners.length).toBeGreaterThanOrEqual(10);
    const codes = new Set(bots.map((b) => b.client.state.me!.code));
    expect(codes.size).toBe(N);
    reports.push(`配役：鬼 ${oni.length}人・逃走者 ${runners.length}人。3桁は全員ばらばら`);

    // --- 試合の前の長押しは受け付けない ---
    H.command('start');
    await waitFor('タイマーに入る', () => bots.every((b) => b.client.state.game?.stage === 'timer'));
    const early = runners[9];
    const seenBefore = early.client.state.notice?.seq ?? 0;
    await hold(early, 800);
    await waitFor('逃走開始前の長押しは「今は記録できない」', () => (early.client.state.notice?.seq ?? 0) > seenBefore && early.client.state.notice!.kind === 'closed');
    expect(claimOf(early)).toBeNull();
    reports.push('ゲームの段階の前に長押し → 「今は記録できない」が返り、何も開かない');

    // ゲームの段階まで待つ（2秒の予約＋1.5秒＋1.5秒）
    await sleep(5_500);

    const [A, B, C, D] = oni;
    const [X, Y, Z, W, V, U, T, S] = runners;
    const expectCaught = async (r: Bot, by: Bot | null, via: CaptureVia, label: string) => {
      await waitFor(`${label}：本人に「捕まった」`, () => r.client.state.me?.caught?.via === via);
      expect(r.client.state.me!.caught!.byNum).toBe(by ? numOf(by) : null);
      const d = await debug();
      const row = d.people.find((p) => p.pid === pidOf(r))!;
      expect(row.caughtBy).toBe(by ? pidOf(by) : null);
      expect(row.caughtVia).toBe(via);
    };

    // 1. 同時に長押し：重なった鬼が1人だけなら、逃走者は選ばなくても、離した時点で記録される
    await Promise.all([hold(A, 2_500), (async () => (await sleep(300), hold(X, 2_200)))()]);
    await expectCaught(X, A, 'together', '同時（選ばない）');
    await waitFor('A に「捕まえた」', () => A.client.state.notice?.kind === 'captured' && A.client.state.notice.other?.num === numOf(X));
    await waitFor('全員の「捕まった人数」が1', () => bots.every((b) => b.client.state.game?.counts.caught === 1));
    expect(A.client.state.me!.catches).toBe(1);
    reports.push('同時に長押し：重なった鬼が1人だけなので、逃走者は選ばずに、離した時点で記録。鬼に「捕まえた」、全員の人数が1に');

    // 2. 音を拾った：鬼は押していない（ゲームの間ずっと聞いている）。逃走者の長押しの間に3桁を拾い、離した時点で記録
    await Promise.all([
      hold(Y, 1_200),
      (async () => {
        await sleep(800);
        B.client.heard(Y.client.state.me!.code!);
      })(),
    ]);
    await waitFor('B に「ロックオン」', () => B.client.state.notice?.kind === 'heard' && B.client.state.notice.other?.num === numOf(Y));
    await expectCaught(Y, B, 'sound', '音（鬼は押さない・選ばない）');
    reports.push('音：鬼は押さずに聞いているだけ。逃走者の長押しの間に3桁を拾うと、鬼に「ロックオン」、逃走者が離した時点で「音」で記録');

    // 3. 2組が同時に（混線）：どちらの逃走者にも2人の鬼が並び、どれを選んでもよい
    await Promise.all([hold(C, 2_500), hold(D, 2_500), (async () => (await sleep(200), hold(Z, 2_000)))(), (async () => (await sleep(250), hold(W, 2_000)))()]);
    await waitFor('混線：Z と W の候補に C と D が並ぶ', () => {
      const z = new Set(candPids(Z));
      const w = new Set(candPids(W));
      return z.has(pidOf(C)) && z.has(pidOf(D)) && w.has(pidOf(C)) && w.has(pidOf(D));
    });
    Z.client.answer(pidOf(D));
    W.client.answer(pidOf(C));
    await expectCaught(Z, D, 'together', '混線 Z');
    await expectCaught(W, C, 'together', '混線 W');
    reports.push('2組が同時に長押し：どちらの逃走者にも鬼が2人並び、それぞれが選んだ鬼で記録');

    // 4. 前後に長押し（重ならない）
    await hold(A, 1_000);
    await sleep(4_000);
    await hold(V, 1_200);
    await waitFor('前後：V の候補に A（重なっていない）', () => candPids(V).includes(pidOf(A)));
    const near = claimOf(V)!.cands.find((c) => c.pid === pidOf(A))!;
    expect(near.together).toBe(false);
    expect(near.gapMs).toBeGreaterThan(2_000);
    V.client.answer(pidOf(A));
    await expectCaught(V, A, 'near', '前後');
    reports.push(`前後に長押し：重なっていなくても ${(near.gapMs! / 1000).toFixed(1)}秒差の鬼が候補に出る`);

    // 5. 逃走者が手動で選ぶ。「捕まった」を長押しする前は、鬼の一覧は空（役が分からないように）
    U.client.requestRoster();
    await waitFor('長押し前の U には空の一覧', () => U.client.state.roster !== null);
    expect(U.client.state.roster!.people).toEqual([]);
    await hold(U, 800);
    await waitFor('U の「捕まった」が開く', () => claimOf(U) !== null);
    const rosterSeq = U.client.state.roster!.seq;
    U.client.requestRoster();
    await waitFor('U に鬼の一覧', () => U.client.state.roster!.seq > rosterSeq && U.client.state.roster!.people.length === oni.length);
    expect(new Set(U.client.state.roster!.people.map((p) => p.pid))).toEqual(new Set(oni.map(pidOf)));
    U.client.answer(pidOf(C), true);
    await expectCaught(U, C, 'manual', '手動');
    reports.push('逃走者の手動：長押しする前は一覧が空。長押ししたあとの一覧は鬼だけで、そこから選ぶと記録（手動）');

    // 6. 鬼が手動で選ぶ → その逃走者の候補に出る → 逃走者が選ぶ
    D.client.requestRoster();
    await waitFor('D に捕まっていない逃走者の一覧', () => {
      const ids = new Set((D.client.state.roster?.people ?? []).map((p) => p.pid));
      return ids.has(pidOf(T)) && !ids.has(pidOf(X)) && !oni.some((o) => ids.has(pidOf(o)));
    });
    D.client.nominate(pidOf(T));
    await waitFor('T に D の候補（鬼が選んだ）', () => claimOf(T)?.cands.some((c) => c.pid === pidOf(D) && c.nominated) === true);
    T.client.answer(pidOf(D));
    await expectCaught(T, D, 'nominated', '鬼の手動');
    reports.push('鬼の手動：一覧は捕まっていない逃走者だけ。選ぶと、その逃走者の候補に「鬼が選んだ」で出て、逃走者が選んで記録');

    // 7. 長押しの途中で切れても、つなぎ直すと同じ長押しとして続く
    const sAt = S.now();
    await sleep(500);
    S.client.holdStart(sAt);
    const aHold = hold(A, 3_000);
    await sleep(400);
    S.sockets.at(-1)!.kill();
    await waitFor('S がつなぎ直す', () => S.client.state.online && S.sockets.length >= 2 && S.sockets.at(-1)!.readyState === 1, 30_000);
    await aHold;
    S.client.holdEnd(S.now());
    await expectCaught(S, A, 'together', '切れても（同時・選ばない）');
    reports.push('長押しの途中で回線が切れても、つなぎ直した端末が押し始めを送り直し、同じ長押しとして「同時」で記録される');

    // 7b. 送ったはずの長押しが、回線が切れて届かなかった → つなぎ直したときに送り直され、1回だけ数えられる
    const R = runners.find((r, i) => i >= 8 && bots.indexOf(r) % 2 === 1) ?? runners[10];
    const rStart = R.now();
    const aHold2 = hold(A, 3_000);
    await sleep(300);
    R.client.holdStart(rStart);
    await sleep(1_000);
    R.client.holdEnd(R.now());
    R.sockets.at(-1)!.kill();
    await aHold2;
    await expectCaught(R, A, 'together', '届かなかった長押し（同時・選ばない）');
    const rHolds = ((await debug()) as unknown as { holds: Record<string, { start: number }[]> }).holds[pidOf(R)] ?? [];
    expect(rHolds).toHaveLength(1);
    reports.push('長押しの途中で送った知らせが回線ごと消えても、つなぎ直したときに送り直され、長押しは1回だけ数えられて「同時」で記録された');

    // 7c. 「離した」が届かないまま長く切れていた鬼の長押しは、押し始めから8秒で離したとみなす（ずっと押していたことにしない）
    const E = oni[4];
    const eStart = E.now();
    await sleep(500);
    E.client.holdStart(eStart);
    await sleep(10_000);
    E.sockets.at(-1)!.kill();
    E.client.holdEnd(E.now());
    await waitFor('E がつなぎ直す', () => E.client.state.online && E.sockets.at(-1)!.readyState === 1, 30_000);
    await sleep(1_000);
    const eHolds = ((await debug()) as unknown as { holds: Record<string, { start: number; end: number | null }[]> }).holds[pidOf(E)] ?? [];
    const eLast = eHolds.at(-1)!;
    expect(eLast.end).not.toBeNull();
    expect(eLast.end! - eLast.start).toBe(8_000);
    reports.push('「離した」が届かないまま10秒切れていた鬼の長押しは、押し始めから8秒で離したとみなした（関係ない逃走者に「同時」で出ない）');

    // 8. 答え待ちのままサーバーが再起動しても、候補は残る（前後だけなので選ぶまで開いたまま）
    const Q = runners.find((r, i) => i >= 8 && r !== R && r !== early)!;
    await hold(A, 1_000);
    await sleep(3_000);
    await hold(Q, 1_200);
    await waitFor('前後：Q の候補に A', () => candPids(Q).includes(pidOf(A)));
    await stopServer();
    await sleep(500);
    await startServer();
    await waitFor('Q がつなぎ直して候補を受け取る', () => Q.client.state.online && claimOf(Q)?.cands.some((c) => c.pid === pidOf(A)) === true, 60_000);
    Q.client.answer(pidOf(A));
    await expectCaught(Q, A, 'near', '再起動のあと');
    reports.push('答え待ちのままサーバーを再起動：長押し・候補は保存されていて、つなぎ直したあとに選んで記録できた');

    // 9. 捕まった人の長押しは「もう捕まっている」
    const seenX = X.client.state.notice?.seq ?? 0;
    await hold(X, 800);
    await waitFor('X に「もう捕まっている」', () => (X.client.state.notice?.seq ?? 0) > seenX && X.client.state.notice!.kind === 'already');

    // 10. 主催者の手直し：取り消し → 手で捕まった
    await waitFor('主催者に捕獲の一覧', () => (H.state.host?.capture?.runners.filter((r) => r.caught).length ?? 0) === 10, 30_000);
    H.command('release', { pid: pidOf(X) });
    await waitFor('取り消し：X は捕まっていない', () => X.client.state.me?.caught === null && X.client.state.notice?.kind === 'released');
    await waitFor('全員の人数が9', () => bots.every((b) => b.client.state.game?.counts.caught === 9));
    H.command('capture', { pid: pidOf(X) });
    await expectCaught(X, null, 'host', '主催者');
    await waitFor('全員の人数が10', () => bots.every((b) => b.client.state.game?.counts.caught === 10));
    reports.push('主催者：取り消すと全員の人数が戻り、手で「捕まった」にすると主催者の記録になる');

    // 11. 役の漏れ：候補と手動の一覧に、鬼でない人は出ない。主催者の集計・他人の me は届かない
    const oniIds = new Set(oni.map(pidOf));
    for (const r of runners) {
      for (const pid of r.candidatePids) expect(oniIds.has(pid), `${r.name} の候補`).toBe(true);
      for (const pid of r.rosterPids) expect(oniIds.has(pid), `${r.name} の手動の一覧`).toBe(true);
    }
    for (const o of oni) for (const pid of o.rosterPids) expect(oniIds.has(pid), `${o.name} の手動の一覧`).toBe(false);
    for (const b of bots) expect(b.leaks, b.name).toEqual([]);
    reports.push('役の漏れ：逃走者に届いた候補・一覧は鬼だけ、鬼に届いた一覧は逃走者だけ。主催者の集計・他人の情報は誰にも届いていない');

    // 12. 記録の書き出し
    const res = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
    expect(res.ok).toBe(true);
    const rows = (await res.json()) as { kind: string; via: string | null; other_name: string | null; name: string | null }[];
    const caps = rows.filter((r) => r.kind === 'capture');
    expect(caps.map((r) => r.via).sort()).toEqual(['host', 'manual', 'near', 'near', 'nominated', 'sound', 'together', 'together', 'together', 'together', 'together'].sort());
    expect(rows.some((r) => r.kind === 'release')).toBe(true);
    expect(rows.filter((r) => r.kind === 'hold').length).toBeGreaterThan(20);
    expect(rows.some((r) => r.kind === 'heard')).toBe(true);
    expect(rows.some((r) => r.kind === 'nominate')).toBe(true);
    const bytes = new Uint8Array(await (await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': TOKEN } })).arrayBuffer());
    // Excel が UTF-8 と分かるように、先頭は BOM（EF BB BF）
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv.startsWith('番号,時刻（日本）')).toBe(true);
    expect(csv).toContain(',捕獲,');
    expect(csv).toContain(',残り時間,');
    const forbidden = await fetch(`${BASE}/api/game/${GAME}/log`);
    expect(forbidden.status).toBe(403);
    reports.push(`記録の書き出し：${rows.length}行（捕獲 ${caps.length}・長押し ${rows.filter((r) => r.kind === 'hold').length}・音 ${rows.filter((r) => r.kind === 'heard').length}）。CSV は Excel 用の BOM つき、合言葉なしは断る`);
  });
});
