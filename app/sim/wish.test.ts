/**
 * 配役の希望の確認。手元に本物のサーバー（wrangler dev）を立てる。
 *
 * - 参加者が選んだ希望（逃走者／鬼／どちらでも）は本人に返り、人数は全員に届く
 * - 人数は割合のまま。枠より多い希望はくじで外れ、外れた人は次の配役で先に通る
 * - 引き直しは、外れた回数を二重に数えない
 * - 役が決まってからゲームの終わりまで、その配役の人は希望を変えられない
 * - 主催者が「くじだけ」に切り替えると、希望は使わない
 * - つなぎ直しても希望は残る。新しい夜を始めると消える
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import type { RoleId } from '../src/shared/rules';

const PORT = Number(process.env.WISH_PORT ?? 8812);
const TOKEN = 'wishtoken';
const GAME = `wish${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** どの段階も1秒（開始の2秒を足して、約6秒で結果） */
const DUR = [1_000, 1_000, 1_000, 1_000];

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-wish-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  return c;
}

const roleOf = (p: GameClient) => p.state.me?.role ?? null;
const missOf = (p: GameClient) => p.state.me?.wishMiss ?? -1;

describe('配役の希望', () => {
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

  it('希望が届き、枠より多い希望はくじで外れ、外れた人は次に先に通る', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const stores = Array.from({ length: 10 }, () => memoryStore());
    const players = stores.map((st, i) => {
      const p = client('player', st);
      p.join(`にん${i}`);
      return p;
    });
    await waitFor('10人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);

    // 最初は「希望を聞く」。誰も選んでいない
    expect(host.state.game!.wishMode).toBe('wish');
    expect(host.state.game!.wishes).toEqual({ oni: 0, runner: 0 });
    expect(players.every((p) => p.state.me!.wish === null && p.state.me!.wishMiss === 0)).toBe(true);

    // 段階を短くする（約6秒で結果）
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => host.state.game?.durations[0] === 1_000);

    // 全員が逃走者を希望：本人に返り、人数が全員に届く
    for (const p of players) expect(p.wish('runner')).toBe(true);
    await waitFor('全員の希望が届く', () => players.every((p) => p.state.me?.wish === 'runner' && p.state.game?.wishes?.runner === 10));
    expect(host.state.game!.wishes).toEqual({ oni: 0, runner: 10 });

    // おかしな値は捨てる（希望はそのまま）
    players[0].wish('third' as unknown as RoleId);
    await sleep(400);
    expect(players[0].state.me!.wish).toBe('runner');

    // 配役：人数は割合のまま（鬼3・逃走者7）。外れた3人は鬼になり、「通らなかった」が本人に届く
    host.command('assign');
    await waitFor('配役', () => players.every((p) => roleOf(p)) && host.state.game?.assignId === 1);
    expect(host.state.game!.counts).toMatchObject({ oni: 3, runner: 7 });
    const missed1 = players.filter((p) => roleOf(p) === 'oni');
    expect(missed1).toHaveLength(3);
    for (const p of players) {
      const out = missed1.includes(p);
      expect(p.state.me!.wishMissed).toBe(out);
      expect(missOf(p)).toBe(out ? 1 : 0);
    }
    await waitFor('主催者に数が届く', () => host.state.host?.wishStat?.missed === 3);
    expect(host.state.host!.wishStat).toEqual({ oni: 0, runner: 10, none: 0, missed: 3 });

    // 役が決まったあとは、その配役の人は希望を変えられない
    missed1[0].wish('oni');
    await sleep(400);
    expect(missed1[0].state.me!.wish).toBe('runner');

    // 引き直し：外れた回数を二重に数えない（外れた人は 1、通った人は 0 のまま。2 にはならない）
    for (let k = 0; k < 3; k++) {
      host.command('assign');
      await waitFor(`引き直し${k + 1}`, () => host.state.game?.assignId === 2 + k && players.every((p) => p.state.me?.assignId === 2 + k));
      expect(players.filter((p) => roleOf(p) === 'oni')).toHaveLength(3);
      for (const p of players) expect(missOf(p)).toBe(roleOf(p) === 'oni' ? 1 : 0);
    }
    const missedA = players.filter((p) => roleOf(p) === 'oni');

    // 1ラウンド回す（時間が0になるとアプリが結果を出す）
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    // 試合中も変えられない
    missedA[0].wish(null);
    await sleep(300);
    expect(missedA[0].state.me!.wish).toBe('runner');
    await waitFor('結果', () => host.state.game?.stage === 'result', 20_000);

    // 次の配役：前に外れた3人は先に通る（必ず逃走者）。別の3人が外れる
    host.command('assign');
    await waitFor('2ラウンド目の配役', () => host.state.game?.round === 2 && players.every((p) => p.state.me?.assignId === host.state.game?.assignId));
    for (const p of missedA) {
      expect(roleOf(p)).toBe('runner');
      expect(missOf(p)).toBe(0);
      expect(p.state.me!.wishMissed).toBe(false);
    }
    const missedB = players.filter((p) => roleOf(p) === 'oni');
    expect(missedB).toHaveLength(3);
    for (const p of missedB) expect(missOf(p)).toBe(1);

    // リセットして結果へ（やり直し → 開始 → 結果）
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    await waitFor('結果', () => host.state.game?.stage === 'result', 20_000);

    // 結果発表では変えられる：1人が「どちらでも」、2人が鬼へ
    const [a, b, c] = players.filter((p) => !missedB.includes(p));
    expect(a.wish(null)).toBe(true);
    b.wish('oni');
    c.wish('oni');
    await waitFor('希望が変わる', () => host.state.game?.wishes?.runner === 7 && host.state.game?.wishes?.oni === 2);
    expect(a.state.me!.wish).toBe(null);

    // 逃走者希望7（枠7）・鬼希望2（枠3）・どちらでも1：全員が希望どおり。どちらでもの人が鬼の残り1枠を埋める
    host.command('assign');
    await waitFor('3ラウンド目の配役', () => host.state.game?.round === 3 && players.every((p) => p.state.me?.assignId === host.state.game?.assignId));
    expect(roleOf(a)).toBe('oni');
    expect(roleOf(b)).toBe('oni');
    expect(roleOf(c)).toBe('oni');
    for (const p of players) {
      if (p !== a) expect(roleOf(p)).toBe(p.state.me!.wish);
      expect(missOf(p)).toBe(0);
      expect(p.state.me!.wishMissed).toBe(false);
    }
    await waitFor('主催者に数が届く', () => host.state.host?.wishStat?.oni === 2);
    expect(host.state.host!.wishStat).toEqual({ oni: 2, runner: 7, none: 1, missed: 0 });

    // つなぎ直しても（同じスマホで開き直しても）希望は残る
    b.stop();
    const b2 = client('player', stores[players.indexOf(b)]);
    await waitFor('開き直した人が戻る', () => b2.state.phase === 'ready' && b2.state.me !== null);
    expect(b2.state.me!.wish).toBe('oni');
    expect(b2.state.me!.role).toBe('oni');
    players[players.indexOf(b)] = b2;

    // 「くじだけ」に切り替える：希望は受け付けず、配役にも使わない
    host.command('wish-mode', { wishMode: 'lot' });
    await waitFor('くじだけが全員に届く', () => players.every((p) => p.state.game?.wishMode === 'lot'));
    host.command('assign'); // 引き直し（くじ）
    await waitFor('くじで引き直し', () => players.every((p) => p.state.me?.assignId === host.state.game?.assignId) && host.state.host?.wishStat === null);
    expect(host.state.game!.counts).toMatchObject({ oni: 3, runner: 7 });
    // くじだけで決めた配役に「通らなかった」は無い。引き直しなので、外れた回数は3ラウンド目の配役の前に戻る
    // （2ラウンド目に外れた3人は、希望が通った配役を遊ばないまま引き直されたので、先に通る権利が残る）
    for (const p of players) {
      expect(p.state.me!.wishMissed).toBe(false);
      expect(missOf(p)).toBe(missedB.includes(p) ? 1 : 0);
    }

    // 不正な値は断る
    host.command('wish-mode', { wishMode: 'free' as never });
    await waitFor('不正な決め方は断られる', () => host.state.lastReject?.op === 'wish-mode' && host.state.lastReject.reason === 'bad-input');

    // 試合中は切り替えられない
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('wish-mode', { wishMode: 'wish' });
    await waitFor('試合中は断られる', () => host.state.lastReject?.op === 'wish-mode' && host.state.lastReject.reason === 'not-allowed');
    await waitFor('結果', () => host.state.game?.stage === 'result', 20_000);
    // くじだけの間は、希望を送っても変わらない
    a.wish('runner');
    await sleep(400);
    expect(a.state.me!.wish).toBe(null);
    host.command('wish-mode', { wishMode: 'wish' });
    await waitFor('希望を聞くに戻す', () => players.every((p) => p.state.game?.wishMode === 'wish'));

    // 途中で来た人（見学）の希望は、試合中でもサーバーが受け付ける（画面の板は、ゲームが終わってから出る）
    host.command('assign');
    await waitFor('配役', () => host.state.game?.stage === 'assigned' && players.every((p) => p.state.me?.assignId === host.state.game?.assignId));
    const late = client('player');
    late.join('あとから');
    await waitFor('途中で来た人が入る', () => late.state.phase === 'ready' && late.state.me !== null);
    expect(late.state.me!.role).toBe(null);
    late.wish('oni');
    await waitFor('見学の人の希望が届く', () => late.state.me?.wish === 'oni');

    // 新しい夜を始めると、希望は消える
    host.command('clear');
    await waitFor('全員に名前のボタン', () => host.state.game?.stage === 'lobby' && players.every((p) => p.state.phase === 'known'));
    for (const p of players) p.enter();
    await waitFor('入り直す', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 10);
    expect(players.every((p) => p.state.me!.wish === null && missOf(p) === 0)).toBe(true);
    expect(host.state.game!.wishes).toEqual({ oni: 0, runner: 0 });
  }, 180_000);
});
