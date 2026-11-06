/**
 * 「新しい夜を始める（部屋を空にする）」と名簿の確認。手元に本物のサーバー（wrangler dev）を立てて確かめる。
 * - 試合中は始められない
 * - 新しい夜を始めると、今夜の参加は0になるが名簿は残る。スマホには名前のボタンが出て（known）、押すと同じ人として入る
 * - 合い鍵のないスマホで名簿の名前を入れると taken。「前の自分に戻る」→ 主催者がつなぐと、同じ人の合い鍵を受け取る
 * - 主催者が断ると名前の入力に戻り、ちがう名前なら新しく名簿に入る（名簿の番号は戻らない）
 * - サーバーが入れ替わっても名簿は残る
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';

const PORT = Number(process.env.CLEAR_PORT ?? 8797);
const TOKEN = 'cleartoken';
const GAME = `clear${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;

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

const persistDir = mkdtempSync(join(tmpdir(), 'urafess-clear-'));

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--var', `HOST_TOKEN:${TOKEN}`],
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

async function stopServer(): Promise<void> {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // 終わっている
    }
  }
  server = null;
  await sleep(1_500);
}

type Debug = {
  game: { night: number; nextNum: number };
  people: { pid: string; num: number; name: string }[];
  members: { pid: string; num: number; name: string; nights: number }[];
};

async function debug(): Promise<Debug> {
  const r = await fetch(`${BASE}/api/game/${GAME}/debug`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as Debug;
}

function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  return c;
}

const clients: GameClient[] = [];

describe('新しい夜を始める・名簿', () => {
  afterAll(async () => {
    for (const c of clients) c.stop();
    await stopServer();
    await sleep(500);
  });

  it('試合中は始められない。始めると今夜は空になるが名簿は残り、名前のボタンで同じ人として入れる', async () => {
    await startServer();
    const host = client('host');
    clients.push(host);
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');

    const stores = [memoryStore(), memoryStore(), memoryStore()];
    const players = ['あお', 'みどり', 'あか'].map((name, i) => {
      const c = client('player', stores[i]);
      c.join(name);
      clients.push(c);
      return c;
    });
    await waitFor('3人が入室', () => players.every((p) => p.state.identity && p.state.phase === 'ready') && host.state.host?.total === 3);
    expect(host.state.host?.registry).toBe(3);
    const pids = players.map((p) => p.state.identity!.pid);

    // 試合中は始められない
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');
    host.command('clear');
    await waitFor('試合中の「新しい夜」は断られる', () => host.state.lastReject?.op === 'clear');
    expect(host.state.lastReject?.reason).toBe('not-allowed');
    expect(host.state.host?.total).toBe(3);

    // 試合を止めて（リセット）から新しい夜を始める
    host.command('reset');
    await waitFor('リセット', () => host.state.game?.stage === 'assigned');
    const nightBefore = (await debug()).game.night;
    host.command('clear');
    await waitFor('全員に名前のボタンが出る', () => players.every((p) => p.state.phase === 'known') && host.state.host?.total === 0);
    // 合い鍵は覚えたまま。番号でなく名前で出る
    players.forEach((p, i) => expect(p.state.identity?.pid).toBe(pids[i]));
    expect(players.map((p) => p.state.identity?.name)).toEqual(['あお', 'みどり', 'あか']);
    expect(host.state.game?.stage).toBe('lobby');
    expect(host.state.game?.round).toBe(0);
    expect(host.state.host?.registry).toBe(3);
    let d = await debug();
    expect(d.game.night).toBe(nightBefore + 1);
    expect(d.members).toHaveLength(3);

    // 名前のボタンで入る：同じ人のまま、来た夜が2になる
    players[0].enter();
    await waitFor('あおが今夜に入る', () => players[0].state.phase === 'ready' && host.state.host?.total === 1);
    expect(players[0].state.identity?.pid).toBe(pids[0]);
    expect(players[0].state.me?.pid).toBe(pids[0]);
    d = await debug();
    expect(d.members.find((m) => m.pid === pids[0])?.nights).toBe(2);
    // 押していない人は今夜に入らない
    expect(players[1].state.phase).toBe('known');
  }, 180_000);

  it('合い鍵のないスマホ：名簿の名前は taken → 主催者がつなぐと前の自分に戻る。断られたらちがう名前で新しく入る', async () => {
    const host = clients[0];
    const pidAo = clients[1].state.identity!.pid;
    const pidMidori = clients[2].state.identity!.pid;

    // 「アオ」（カタカナ）と打っても、名簿の「あお」とみなす
    const phoneA = client('player');
    clients.push(phoneA);
    phoneA.join('アオ');
    await waitFor('taken（あお）', () => phoneA.state.phase === 'taken' && phoneA.state.takenName === 'あお');
    phoneA.reclaim();
    await waitFor('主催者に「戻りたい人」が出る', () => host.state.host?.reclaims.length === 1);
    const ask = host.state.host!.reclaims[0];
    expect(ask.name).toBe('あお');
    // あおはいまも別のスマホ（最初の1台）でつながっている
    expect(ask.here).toBe(true);
    host.command('link', { rid: ask.rid, ok: true });
    await waitFor('つないだ → 前のあおとして入る', () => phoneA.state.phase === 'ready' && phoneA.state.identity?.pid === pidAo);
    expect(host.state.host?.total).toBe(1);
    await waitFor('頼みが消える', () => host.state.host?.reclaims.length === 0);

    // 「みどり」を名乗るが、主催者が断る → 名前の入力へ → ちがう名前で新しく入る
    const phoneB = client('player');
    clients.push(phoneB);
    phoneB.join('みどり');
    await waitFor('taken（みどり）', () => phoneB.state.phase === 'taken');
    phoneB.reclaim();
    await waitFor('主催者に出る', () => host.state.host?.reclaims.length === 1);
    expect(host.state.host!.reclaims[0].here).toBe(true);
    host.command('link', { rid: host.state.host!.reclaims[0].rid, ok: false });
    await waitFor('断られて名前の入力へ', () => phoneB.state.phase === 'need-name' && (phoneB.state.joinError ?? '').includes('みどり'));
    phoneB.join('みどり2');
    await waitFor('みどり2として新しく入る', () => phoneB.state.phase === 'ready' && host.state.host?.registry === 4);
    expect(phoneB.state.identity?.pid).not.toBe(pidMidori);
    const d = await debug();
    // 名簿の番号は新しい夜でも戻らない（画面には出さない）
    expect(d.members.find((m) => m.name === 'みどり2')?.num).toBe(4);

    // 待つのをやめたら、主催者の一覧から消える
    const phoneC = client('player');
    clients.push(phoneC);
    phoneC.join('あか');
    await waitFor('taken（あか）', () => phoneC.state.phase === 'taken');
    phoneC.reclaim();
    await waitFor('主催者に出る', () => host.state.host?.reclaims.length === 1);
    phoneC.backToName(null);
    await waitFor('一覧から消える', () => host.state.host?.reclaims.length === 0);
  }, 120_000);

  it('サーバーが入れ替わっても名簿は残る。開き直したスマホは名前のボタン（known）から入れる', async () => {
    const host = clients[0];
    const midori = clients[2];
    const pid = midori.state.identity!.pid;
    await stopServer();
    await startServer();
    await waitFor('みどりはつなぎ直して名前のボタンのまま', () => midori.state.online && midori.state.phase === 'known', 60_000);
    midori.enter();
    await waitFor('みどりが今夜に入る', () => midori.state.phase === 'ready' && midori.state.me?.pid === pid, 30_000);
    await waitFor('主催者もつなぎ直す', () => host.state.online && host.state.host !== null, 30_000);
    expect(host.state.host?.registry).toBe(4);
  }, 180_000);
});
