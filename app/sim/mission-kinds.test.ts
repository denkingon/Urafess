/**
 * ミッションの種類（合流・範囲）の確認。手元に本物のサーバー（wrangler dev）を立て、鬼1・逃走者4で回す。
 *
 * - 範囲は、ゲームの段階の前には出せない（断る）
 * - 合流（全員を2人組）：配役のあとに出せる。逃走者には相手の名前、鬼には組が見える。相手でない人と同時に押しても成功しない
 * - 相手が牢屋にいる間は合流できない。1組が合流すると、決めておいた人数が牢屋から出る。全部の組が合流したら締め切る
 * - 合流・範囲のミッションには写真を送れない
 * - 合流（1組だけ）：誰と誰かが全員に見える。主催者が締め切ると失敗
 * - 範囲：いま中にいる人数が全員に届く。締め切りの瞬間に人数が足りていれば成功し、牢屋から出る
 * - 範囲：試合を止めている間は締め切りも止まる（再開でずれる）
 * - 範囲：ゲームの段階が終わったら、その場で判定する（足りなければ失敗）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore, type Notice } from '../src/client/core/game-client';
import { CAMPUS_CENTER, START_LEAD_MS } from '../src/shared/rules';
import { positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.KINDS_PORT ?? 8823);
const TOKEN = 'kindstoken';
const GAME = `kinds${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで1秒・追跡開始まで1秒・ゲーム150秒・広場に戻るまで3秒 */
const DUR = [1_000, 1_000, 150_000, 3_000];
const C = CAMPUS_CENTER;
/** キャンパスの真ん中のまわり、約110m 四方 */
const ZONE: [number, number][] = [
  [C.lat - 0.0005, C.lon - 0.0006],
  [C.lat - 0.0005, C.lon + 0.0006],
  [C.lat + 0.0005, C.lon + 0.0006],
  [C.lat + 0.0005, C.lon - 0.0006],
];
const IN = { lat: C.lat, lon: C.lon, acc: 10 };
const OUT = { lat: C.lat + 0.003, lon: C.lon, acc: 10 };

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
const timers: ReturnType<typeof setInterval>[] = [];

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-kinds-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

const hasNotice = (c: GameClient, kind: string) => (notices.get(c) ?? []).some((n) => n.kind === kind);
const nameOf = (c: GameClient) => c.state.me!.name;

function phaseOf(c: GameClient): number | 'done' {
  const timer = c.state.game?.timer;
  const now = c.serverNow();
  if (!timer || now === null) return -1;
  const pos = positionAt(timer, now);
  return pos.kind === 'done' ? 'done' : pos.index;
}

describe('ミッションの種類（合流・範囲）', () => {
  afterAll(async () => {
    for (const t of timers) clearInterval(t);
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

  it('合流（全員・1組）と範囲（締め切り・ゲームの終わり）', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const players = ['あお', 'みどり', 'あか', 'きい', 'しろ'].map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('5人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 5);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('ratio', { ratio: { oni: 1, runner: 4 } });
    await waitFor('割合', () => host.state.game?.ratio?.runner === 4);

    // 配役の前：合流も範囲も出せない
    host.command('mission', { kind: 'meet', scope: 'all' });
    await waitFor('配役の前の合流は断る', () => host.state.lastReject?.reason === 'not-game');

    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const oni = players.find((p) => p.state.me!.role === 'oni')!;
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    expect(runners.length).toBe(4);

    // 範囲は、ゲームの段階の前には出せない
    host.command('mission', { kind: 'zone', zone: ZONE, need: 2, secs: 30 });
    await waitFor('ゲームの前の範囲は断る', () => host.state.lastReject?.reason === 'not-game');
    expect(host.state.game?.mission ?? null).toBeNull();

    // ---- 合流（全員を2人組）：配役のあとに出せる。成功で1人を牢屋から
    host.command('mission', { kind: 'meet', scope: 'all', free: true, n: 1 });
    await waitFor('合流が出る', () => players.every((p) => p.state.game?.mission?.kind === 'meet' && p.state.game.mission.open));
    const m1 = host.state.game!.mission!;
    expect(m1.title).toBe('指定された仲間と合流しろ');
    expect(m1.meet).toMatchObject({ scope: 'all', groups: 2, ok: 0 });
    expect(m1.free).toBe(1);
    // 組は鬼にも見える（2組なので名前で）
    expect(oni.state.game!.mission!.meet!.pairs!.length).toBe(2);
    expect(oni.state.me!.meet ?? null).toBeNull();
    await waitFor('逃走者に相手が届く', () => runners.every((r) => r.state.me?.meet?.with.length === 1));
    const partnerOf = (r: GameClient) => runners.find((x) => nameOf(x) === r.state.me!.meet!.with[0].name)!;
    const a1 = runners[0];
    const a2 = partnerOf(a1);
    const [b1, b2] = runners.filter((r) => r !== a1 && r !== a2);
    expect(partnerOf(b1)).toBe(b2);
    expect(host.state.host!.meets!.length).toBe(2);

    // 合流・範囲のミッションには写真を送れない
    {
      const id = a1.state.identity!;
      const jpeg = new Uint8Array(2000).fill(7);
      jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
      const res = await fetch(`${BASE}/api/game/${GAME}/photo?m=${m1.id}`, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg', 'x-pid': id.pid, 'x-key': id.key },
        body: new Blob([jpeg as BlobPart]),
      });
      expect(res.status).toBe(409);
    }

    host.command('start');
    await waitFor('ゲームの段階', () => phaseOf(host) === 2, 15_000);
    await sleep(300);

    // 相手でない2人（a1 と b1）が同時に押しても成功しない
    a1.meetStart(Date.now());
    b1.meetStart(Date.now());
    await sleep(1_200);
    expect(host.state.game!.mission!.meet!.ok).toBe(0);
    a1.meetEnd(Date.now());
    b1.meetEnd(Date.now());

    // b2 を牢屋へ → b1 には「相手は牢屋」、押しても合流できない
    const pidOf = (c: GameClient) => c.state.me!.pid;
    host.command('capture', { pid: pidOf(b2) });
    await waitFor('b2 が牢屋', () => !!b2.state.me?.caught);
    await waitFor('b1 に相手が牢屋と届く', () => b1.state.me?.meet?.with[0].jailed === true);
    b1.meetStart(Date.now());
    b2.meetStart(Date.now());
    await sleep(1_000);
    expect(host.state.game!.mission!.meet!.ok).toBe(0);
    b1.meetEnd(Date.now());
    b2.meetEnd(Date.now());
    await sleep(300);

    // a1 と a2 が同時に長押し → 合流。決めておいた1人（b2）が牢屋から出る
    a1.meetStart(Date.now());
    await sleep(200);
    a2.meetStart(Date.now());
    await waitFor('a の組が合流', () => a1.state.me?.meet?.okAt != null && a2.state.me?.meet?.okAt != null);
    expect(hasNotice(a1, 'met') && hasNotice(a2, 'met')).toBe(true);
    a1.meetEnd(Date.now());
    a2.meetEnd(Date.now());
    await waitFor('b2 が牢屋から出る', () => !b2.state.me?.caught);
    await waitFor('全員に 1/2 が届く', () => players.every((p) => p.state.game?.mission?.meet?.ok === 1));
    expect(host.state.game!.mission!.open).toBe(true);
    // もう一度押しても、同じ組は二度は数えない
    a1.meetStart(Date.now());
    a2.meetStart(Date.now());
    await sleep(600);
    a1.meetEnd(Date.now());
    a2.meetEnd(Date.now());
    expect(host.state.game!.mission!.meet!.ok).toBe(1);

    // b の組も合流 → 全部の組が合流したので締め切る（成功 2組）
    b1.meetStart(Date.now());
    b2.meetStart(Date.now());
    await waitFor('全部の組が合流して締め切る', () => host.state.game?.mission?.open === false);
    b1.meetEnd(Date.now());
    b2.meetEnd(Date.now());
    expect(host.state.game!.mission!.done).toMatchObject({ ok: true, count: 2, freed: 1 });
    expect(oni.state.game!.mission!.done?.ok).toBe(true);

    // ---- 合流（1組だけ）：誰と誰かが全員に見える。主催者が締め切ると失敗
    host.command('mission', { kind: 'meet', scope: 'one', title: '2人を会わせろ', free: false });
    await waitFor('1組だけの合流が出る', () => players.every((p) => p.state.game?.mission?.meet?.scope === 'one' && p.state.game.mission.open));
    const m2 = oni.state.game!.mission!;
    expect(m2.title).toBe('2人を会わせろ');
    expect(m2.meet!.groups).toBe(1);
    expect(m2.meet!.pairs![0].names.length).toBe(2);
    expect(m2.free).toBe(0);
    await waitFor('2人にだけ相手が届く', () => runners.filter((r) => r.state.me?.meet?.missionId === m2.id).length === 2);
    host.command('mission-close');
    await waitFor('締め切ると失敗', () => host.state.game?.mission?.open === false && host.state.game.mission.done?.ok === false);

    // ---- 範囲：2人が中、1人が外、1人は牢屋。締め切り（30秒）の瞬間に2人以上で成功 → 牢屋の全員が出る
    const where = new Map<GameClient, { lat: number; lon: number; acc: number }>([
      [a1, IN],
      [a2, IN],
      [b1, OUT],
      [b2, IN],
    ]);
    const sendAll = () => {
      for (const [c, p] of where) c.pos(p);
    };
    sendAll();
    timers.push(setInterval(sendAll, 4_000));
    host.command('capture', { pid: pidOf(b2) });
    await waitFor('b2 が牢屋', () => !!b2.state.me?.caught);
    host.command('mission', { kind: 'zone', zone: ZONE, need: 2, secs: 30 });
    await waitFor('範囲が出る', () => players.every((p) => p.state.game?.mission?.kind === 'zone' && p.state.game.mission.open));
    const m3 = oni.state.game!.mission!;
    expect(m3.title).toBe('指定の範囲に集まれ');
    expect(m3.zone!.need).toBe(2);
    expect(m3.zone!.pts.length).toBe(4);
    expect(m3.until! - m3.at).toBe(30_000);
    // いま中にいる人数（牢屋の b2 は数えない）が、鬼にも届く
    await waitFor('いま2人が鬼にも届く', () => oni.state.game?.mission?.zone?.now === 2);
    expect(host.state.host!.zoneIn!.sort()).toEqual([nameOf(a1), nameOf(a2)].sort());
    // 外の人が入ると 3人
    where.set(b1, IN);
    sendAll();
    await waitFor('3人に増える', () => oni.state.game?.mission?.zone?.now === 3);
    where.set(b1, OUT);
    sendAll();
    await waitFor('2人に戻る', () => oni.state.game?.mission?.zone?.now === 2);
    // 試合を止めると締め切りも止まる：止めていた分（と再開までの2秒）だけ、締め切りが後ろへずれる
    host.command('pause');
    await waitFor('止まる', () => host.state.game?.timer?.status === 'paused');
    await sleep(3_000);
    expect(host.state.game!.mission!.open).toBe(true);
    host.command('resume');
    await waitFor('再開で締め切りがずれる', () => (host.state.game?.mission?.until ?? 0) >= m3.until! + 3_000 + START_LEAD_MS - 200);
    const until3 = host.state.game!.mission!.until!;
    expect(until3 - m3.until!).toBeLessThan(3_000 + START_LEAD_MS + 1_500);
    sendAll();
    await waitFor('締め切りで判定', () => host.state.game?.mission?.open === false, 50_000);
    const done3 = host.state.game!.mission!.done!;
    expect(done3).toMatchObject({ ok: true, count: 2, freed: 1 });
    // 締め切りの瞬間（遅れても合図の間隔まで）
    expect(done3.at - until3).toBeGreaterThanOrEqual(0);
    expect(done3.at - until3).toBeLessThan(2_500);
    await waitFor('b2 が牢屋から出る', () => !b2.state.me?.caught);

    // ---- 範囲：人数が足りないまま、ゲームの段階が終わる（次に進む）→ その場で判定して失敗
    // 牢屋から出た b2 は外へ（中は a1・a2 の2人のまま）
    where.set(b2, OUT);
    sendAll();
    await sleep(300);
    host.command('mission', { kind: 'zone', zone: ZONE, need: 4, secs: 120, free: true });
    await waitFor('2つ目の範囲が出る', () => host.state.game?.mission?.open === true && host.state.game.mission.zone?.need === 4);
    await waitFor('いま2人', () => host.state.game?.mission?.zone?.now === 2);
    host.command('skip');
    await waitFor('ゲームの段階の終わりで判定', () => host.state.game?.mission?.open === false, 15_000);
    expect(host.state.game!.mission!.done).toMatchObject({ ok: false, count: 2, freed: 0 });

    // 配役し直すと、ミッションは消える
    await waitFor('時間が0', () => phaseOf(host) === 'done', 15_000);
    host.command('assign');
    await waitFor('配役し直すと消える', () => players.every((p) => (p.state.game?.mission ?? null) === null && (p.state.me?.meet ?? null) === null));
  });
});
