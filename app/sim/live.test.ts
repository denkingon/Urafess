/**
 * 公開先（本番）に仮想参加者をつなぐテスト。本番の「main」とは別のテスト用の部屋（?g=）を使う。
 *
 * 主催者の操作は外から行う（ブラウザで主催者画面を開き、配役・開始・結果を押す）。
 * このテストは参加者側を受け持ち、全員が役を受け取ったか、区切りの時刻がそろったか、時計の見積もりが
 * 理屈どおりか、他人の役が漏れていないかを見張って記録する。途中経過は sim/live-progress.log。
 *
 * 実行：
 *   LIVE_URL=https://urafess.<サブドメイン>.workers.dev LIVE_GAME=live-test LIVE_N=300 \
 *     npx vitest run --config vitest.sim.config.ts sim/live.test.ts
 * LIVE_HOST_TOKEN を入れると、主催者の操作もこのテストが自分で行う（手元の wrangler dev で試すとき用）
 *
 * 時計の見積もりの確かめ方：本当のサーバー時刻はここからは見えない。ただし理屈の上では、各人の見積もりは
 * 「往復の半分」以内で本当の時刻を含む。全員の区間 [見積もり ± 往復の半分] が共通に含む点（合意点）を求め、
 * そこを含まない人を「保証の外」と数える。全員が同じ機械の時計（±5分ずらし）なので、比べられる。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { allocateCounts } from '../src/shared/allocate';
import type { GameView, ServerMsg } from '../src/shared/protocol';
import { ROLES } from '../src/shared/rules';
import { participantView } from '../src/shared/viewmodel';
import { LaggySocket } from './laggy-socket';

const BASE = (process.env.LIVE_URL ?? '').replace(/\/+$/, '');
const N = Number(process.env.LIVE_N ?? 300);
const GAME = (process.env.LIVE_GAME ?? `live-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const ROUNDS = Number(process.env.LIVE_ROUNDS ?? 2);
const HOST_TOKEN = process.env.LIVE_HOST_TOKEN;
/** ラウンド1の試合中に、突然切る人の割合 */
const KILL_SHARE = Number(process.env.LIVE_KILL ?? 0.1);
/** 主催者の操作（人が押す）を待つ長さ */
const HOST_WAIT_MS = Number(process.env.LIVE_HOST_WAIT_MIN ?? 10) * 60_000;
const WS_URL = `${BASE.replace(/^http/, 'ws')}/api/game/${GAME}/ws`;
const PROGRESS = join(process.cwd(), 'sim', 'live-progress.log');
/** 手元で主催者も動かすときの、短い1ラウンド */
const TEST_DURATIONS = [5_000, 5_000, 20_000, 5_000];

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

const t0 = Date.now();
function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' })} +${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`;
  appendFileSync(PROGRESS, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

async function waitFor(label: string, cond: () => boolean, timeoutMs: number, detail?: () => string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return Date.now() - start;
    await sleep(100);
  }
  throw new Error(`時間切れ：${label}${detail ? `\n${detail()}` : ''}`);
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
  const bot = { name, skew, sockets: [], privacyViolations: 0 } as unknown as Bot;
  bot.client = new GameClient(
    {
      url: WS_URL,
      gameId: GAME,
      now: () => Date.now() + skew,
      storage: memoryStore(),
      random: rand,
      createSocket: (url) => {
        // 遅れは足さない（本物の回線の遅れだけ）。kill() で突然切れるように包む
        const s = new LaggySocket(url, () => 0, () => 0, (raw) => inspect(bot, raw));
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
  if (msg.t !== 'snap') return;
  if (msg.host) bot.privacyViolations++;
  const mine = bot.client.state.identity?.pid;
  if (msg.me && mine && msg.me.pid !== mine) bot.privacyViolations++;
}

const bots: Bot[] = [];
let host: GameClient | null = null;

/** 全員の game のうち、いちばん新しいもの（配役の番号・段階で比べる） */
function latestGame(): GameView | null {
  let g: GameView | null = null;
  for (const b of bots) {
    const x = b.client.state.game;
    if (x && (!g || x.cv > g.cv)) g = x;
  }
  return g;
}

/**
 * 時計の見積もりを、その瞬間に全員分とる。
 * d = 見積もったサーバー時刻 − この機械の時計（本当は全員同じ値になるはず）、b = 保証（往復の半分）
 */
function measure(label: string) {
  const xs = bots
    .filter((b) => b.client.state.online && b.client.syncError() !== null)
    .map((b) => {
      const local = Date.now();
      return { bot: b, d: b.client.serverNow()! - local, b: b.client.syncError()! };
    });
  // 合意点：いちばん多くの区間 [d-b, d+b] が含む点（区間の端を並べて数える）
  const ev: [number, number][] = [];
  for (const x of xs) ev.push([x.d - x.b - 5, 1], [x.d + x.b + 5, -1]);
  ev.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  let cur = 0;
  let best = -1;
  let point = 0;
  for (let i = 0; i < ev.length; i++) {
    cur += ev[i][1];
    if (cur > best) {
      best = cur;
      point = ev[i][0];
      // その区間の真ん中寄りに置く
      if (i + 1 < ev.length) point = (ev[i][0] + ev[i + 1][0]) / 2;
    }
  }
  const outside = xs.filter((x) => Math.abs(x.d - point) > x.b + 5).length;
  const errs = xs.map((x) => Math.abs(x.d - point)).sort((p, q) => p - q);
  const bounds = xs.map((x) => x.b).sort((p, q) => p - q);
  const at = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] ?? NaN;
  // 合意点の時刻で描いた画面と、各自の見積もりで描いた画面がずれている人
  let wrongStep = 0;
  let wrongBig = 0;
  const local = Date.now();
  for (const x of xs) {
    const s = x.bot.client.state;
    if (!s.game || !s.me) continue;
    const mine = participantView(s.game, s.me, local + x.d, true);
    const agreed = participantView(s.game, s.me, local + point, true);
    if (mine.step !== agreed.step) wrongStep++;
    if (mine.big !== agreed.big) wrongBig++;
  }
  const r = {
    n: xs.length,
    outside,
    errP50: at(errs, 0.5),
    errP95: at(errs, 0.95),
    errMax: errs[errs.length - 1] ?? NaN,
    boundP50: at(bounds, 0.5),
    boundP95: at(bounds, 0.95),
    within100: bounds.filter((b) => b <= 100).length,
    wrongStep,
    wrongBig,
  };
  log(
    `${label}：時計の見積もりのばらつき（合意点から）中央値 ${r.errP50.toFixed(1)}ms / 95% ${r.errP95.toFixed(1)}ms / 最大 ${r.errMax.toFixed(1)}ms、` +
      `保証（往復の半分）中央値 ${r.boundP50.toFixed(0)}ms / 95% ${r.boundP95.toFixed(0)}ms、` +
      `保証の外 ${r.outside}/${r.n}、その瞬間に秒の数字がずれていた人 ${r.wrongBig}/${r.n}、段階がずれていた人 ${r.wrongStep}/${r.n}`,
  );
  return r;
}

const summary: string[] = [];
function note(line: string): void {
  summary.push(line);
  log(line);
}

// ---------- 本体 ----------

describe.skipIf(!BASE)(`公開先のテスト（仮想参加者 ${N}人、部屋 ${GAME}）`, () => {
  afterAll(() => {
    for (const b of bots) b.client.stop();
    host?.stop();
    const sockets = bots.reduce((s, b) => s + b.sockets.length, 0);
    const text = [
      `公開先のテストの結果（${BASE}、部屋 ${GAME}、仮想参加者 ${N}人、${new Date().toISOString()}）`,
      ...summary.map((l) => `- ${l}`),
      `- 接続の本数（つなぎ直しを含む）：${sockets}`,
      '',
    ].join('\n');
    writeFileSync(join(process.cwd(), 'sim', `live-report-${N}.md`), text);
    process.stdout.write(`\n${text}\n`);
  });

  it('参加者として入室し、主催者の操作に合わせて全員が同じ状態になる', async () => {
    writeFileSync(PROGRESS, '');
    log(`開始：${BASE} の部屋「${GAME}」に ${N}人つなぐ（主催者は${HOST_TOKEN ? 'このテスト' : '外のブラウザ'}）`);

    if (HOST_TOKEN) {
      host = new GameClient(
        { url: WS_URL, gameId: GAME, now: () => Date.now(), storage: memoryStore(), createSocket: (u) => new WebSocket(u) as never },
        { kind: 'host', token: HOST_TOKEN },
      );
      host.start();
      await waitFor('主催者がつながる', () => host!.state.phase === 'ready', 60_000);
    }

    // --- 入室 ---
    for (let i = 0; i < N; i++) bots.push(makeBot(`bot${String(i).padStart(3, '0')}`));
    for (const [k, b] of bots.entries()) {
      b.client.join(b.name);
      b.client.start();
      if (k % 25 === 24) await sleep(150);
    }
    const joinMs = await waitFor('全員が入室', () => bots.every((b) => b.client.state.identity && b.client.state.phase === 'ready'), 180_000, () =>
      `入室済み ${bots.filter((b) => b.client.state.identity).length}/${N}`,
    );
    note(`入室：${N}人全員（${(joinMs / 1000).toFixed(1)}秒）`);
    await sleep(3_000);
    measure('入室直後');

    if (host) {
      host.command('durations', { durations: TEST_DURATIONS });
      await waitFor('時間の設定', () => JSON.stringify(latestGame()?.durations) === JSON.stringify(TEST_DURATIONS), 30_000);
    } else {
      log('主催者画面で「時間の設定」→「配役」を押すのを待っている');
    }

    const [oni, runner] = allocateCounts(N, ROLES);
    let lastAssign = 0;
    let lastRound = 0;

    for (let r = 1; r <= ROUNDS; r++) {
      // --- 配役（引き直しがあれば、最後の配役が全員に届くまで待つ） ---
      if (host) host.command('assign');
      await waitFor(`ラウンド${r}：配役`, () => {
        const g = latestGame();
        return !!g && g.assignId > lastAssign && g.round > lastRound;
      }, HOST_WAIT_MS);
      const recvMs = await waitFor(
        `ラウンド${r}：全員が役を受け取る`,
        () => {
          const g = latestGame()!;
          return bots.every((b) => b.client.state.me?.assignId === g.assignId && b.client.state.me.role);
        },
        120_000,
        () => `受け取り ${bots.filter((b) => b.client.state.me?.assignId === latestGame()!.assignId).length}/${N}`,
      );
      const g = latestGame()!;
      lastAssign = g.assignId;
      lastRound = g.round;
      const gotOni = bots.filter((b) => b.client.state.me!.role === 'oni').length;
      expect(g.counts).toEqual({ oni, runner, total: N });
      expect(gotOni).toBe(oni);
      note(`ラウンド${g.round}の配役：鬼 ${gotOni}人・逃走者 ${N - gotOni}人を全員が受け取った（配役から全員の受け取りまで ${(recvMs / 1000).toFixed(1)}秒、表示の人数とも一致）`);

      // --- 開始 ---
      if (host) host.command('start');
      else log(`主催者画面で「開始」を押すのを待っている`);
      await waitFor(`ラウンド${r}：開始`, () => latestGame()?.stage === 'timer', HOST_WAIT_MS);
      const sameMs = await waitFor(
        `ラウンド${r}：全員が同じ区切りの時刻`,
        () => {
          const t = JSON.stringify(latestGame()?.timer);
          return bots.every((b) => JSON.stringify(b.client.state.game?.timer) === t);
        },
        60_000,
      );
      note(`ラウンド${r}：開始の知らせが全員に届き、区切りの時刻が一致（${(sameMs / 1000).toFixed(1)}秒で全員）`);
      await sleep(1_500);
      const m1 = measure(`ラウンド${r} 開始直後`);
      expect(m1.outside).toBe(0);

      // --- ラウンド1だけ：試合中に一部を突然切る → つなぎ直して元に戻るか ---
      if (r === 1 && KILL_SHARE > 0) {
        const victims = [...bots].sort(() => rand() - 0.5).slice(0, Math.round(N * KILL_SHARE));
        const killedAt = new Map<Bot, number>();
        const backAfter = new Map<Bot, number>();
        for (const v of victims) {
          setTimeout(() => {
            v.sockets.at(-1)?.kill();
            killedAt.set(v, Date.now());
          }, rand() * 3_000);
        }
        log(`試合中に ${victims.length}人の接続を突然切る`);
        // 切れた瞬間から、つなぎ直して「役と区切りの時刻が元どおり」になるまでを1人ずつ測る
        await waitFor(
          '切れた人が全員つなぎ直す',
          () => {
            const t = JSON.stringify(latestGame()?.timer);
            for (const v of victims) {
              const at = killedAt.get(v);
              if (at === undefined || backAfter.has(v)) continue;
              const s = v.client.state;
              if (s.online && v.sockets.length > 1 && s.me?.role && JSON.stringify(s.game?.timer) === t) backAfter.set(v, Date.now() - at);
            }
            return backAfter.size === victims.length && bots.every((b) => b.client.state.online && JSON.stringify(b.client.state.game?.timer) === t);
          },
          120_000,
          () => `戻った人 ${backAfter.size}/${victims.length}、つながっている ${bots.filter((b) => b.client.state.online).length}/${N}`,
        );
        const back = [...backAfter.values()].sort((p, q) => p - q);
        const med = back[Math.floor(back.length / 2)];
        note(
          `試合中に ${victims.length}人の接続を突然切った → 全員つなぎ直し、役と区切りの時刻が元どおり` +
            `（切れてから戻るまで 中央値 ${(med / 1000).toFixed(1)}秒・最長 ${(back[back.length - 1] / 1000).toFixed(1)}秒）`,
        );
        await sleep(1_500);
        const m2 = measure(`ラウンド${r} つなぎ直しのあと`);
        expect(m2.outside).toBe(0);
      }

      // --- 段階が全部進んで、結果発表の段階に入る ---
      await waitFor(
        `ラウンド${r}：全員が結果発表の段階`,
        () => {
          const now = (b: Bot) => b.client.serverNow()!;
          return bots.every((b) => b.client.state.game && b.client.state.me && participantView(b.client.state.game, b.client.state.me, now(b), true).step === 6);
        },
        HOST_WAIT_MS,
      );
      const winner = r % 2 === 1 ? 'runner' : 'oni';
      if (host) host.command('result', { winner });
      else log('主催者画面で勝ったほうを押すのを待っている');
      await waitFor(`ラウンド${r}：結果`, () => latestGame()?.stage === 'result' && !!latestGame()?.result, HOST_WAIT_MS);
      const resMs = await waitFor(
        `ラウンド${r}：結果が全員に届く`,
        () => bots.every((b) => b.client.state.game?.stage === 'result' && b.client.state.game.result === latestGame()!.result),
        60_000,
      );
      const result = latestGame()!.result;
      const big = result === 'oni' ? '鬼の勝ち' : '逃走者の勝ち';
      expect(bots.every((b) => participantView(b.client.state.game!, b.client.state.me!, b.client.serverNow()!, true).big === big)).toBe(true);
      note(`ラウンド${r}の結果「${big}」が全員の画面に出た（${(resMs / 1000).toFixed(1)}秒で全員）`);
    }

    // --- 静かな時：ばらばらに測り直したあと ---
    for (const [i, b] of bots.entries()) setTimeout(() => b.client.wake(), i * 30);
    await sleep(bots.length * 30 + 3_000);
    const quiet = measure('静かな時（ばらばらに測り直したあと）');
    note(
      `時計（静かな時）：見積もりのばらつき 中央値 ${quiet.errP50.toFixed(1)}ms / 95% ${quiet.errP95.toFixed(1)}ms、保証（往復の半分）中央値 ${quiet.boundP50.toFixed(0)}ms、保証の外 ${quiet.outside}/${quiet.n}`,
    );
    expect(quiet.outside).toBe(0);

    const violations = bots.reduce((s, b) => s + b.privacyViolations, 0);
    note(`他人の役・主催者向けの集計が参加者に届いた回数：${violations}`);
    expect(violations).toBe(0);
  }, 60 * 60_000);
});
