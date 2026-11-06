/**
 * ミッション（集合写真）の確認。手元に本物のサーバー（wrangler dev）を立て、主催者がミッションを出し、
 * 参加者が写真を送り、主催者が「成功」「やり直し」を押す。成功は全員に名前が届き、写真そのものは
 * 試合が動いている間は本人と主催者にしか取り出せず、時間が0になると全員が取り出せる。
 * 配役し直すとミッションは消えるが、写真は名簿と一緒に残る（新しい夜を始めても）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import { isDone } from '../src/shared/schedule';

const PORT = Number(process.env.MISSION_PORT ?? 8797);
const TOKEN = 'missiontoken';
const GAME = `mission${Date.now()}`;
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

async function startServer(): Promise<void> {
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-mission-')), '--var', `HOST_TOKEN:${TOKEN}`],
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
  return c;
}

const clients: GameClient[] = [];


/** サーバーは先頭の3バイト（FF D8 FF）と大きさだけを見るので、中身は作り物でいい */
function fakeJpeg(size: number, fill = 7): Uint8Array {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

function upload(c: GameClient, missionId: number, body: Uint8Array, key?: string): Promise<Response> {
  const id = c.state.identity!;
  return fetch(`${BASE}/api/game/${GAME}/photo?m=${missionId}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-pid': id.pid, 'x-key': key ?? id.key },
    body: new Blob([body as BlobPart]),
  });
}

function getPhoto(c: GameClient | 'host', photoId: string): Promise<Response> {
  const headers: Record<string, string> =
    c === 'host' ? { 'x-host-token': TOKEN } : { 'x-pid': c.state.identity!.pid, 'x-key': c.state.identity!.key };
  return fetch(`${BASE}/api/game/${GAME}/photo/${photoId}`, { headers });
}

describe('ミッション（集合写真）', () => {
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

  it('出す → 送る → 主催者が決める → 成功は全員に、写真は結果発表で全員に → 配役し直しても写真は残る', async () => {
    await startServer();
    const host = client('host');
    clients.push(host);
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const [a, b, c] = ['あお', 'みどり', 'あか'].map((name) => {
      const p = client('player');
      p.join(name);
      clients.push(p);
      return p;
    });
    const players = [a, b, c];
    await waitFor('3人が入室', () => players.every((p) => p.state.identity) && host.state.host?.total === 3);

    // 時間を短く（逃走・追跡・ゲーム・戻る＝1秒・1秒・4秒・1秒）
    host.command('durations', { durations: [1000, 1000, 8000, 1000] });
    await waitFor('時間', () => host.state.game?.durations[2] === 8000);
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    host.command('start');
    await waitFor('開始', () => host.state.game?.stage === 'timer');

    // ミッションを出す（題の前後の空白は消える）
    host.command('mission', { title: '  3人で集合写真 ' });
    await waitFor('全員にミッション', () => players.every((p) => p.state.game?.mission?.open === true));
    const mission = a.state.game!.mission!;
    expect(mission.title).toBe('3人で集合写真');

    // 断られる送り方：合い鍵が違う・JPEG でない・大きすぎる・ミッションの番号が違う
    expect((await upload(a, mission.id, fakeJpeg(2000), 'x'.repeat(32))).status).toBe(403);
    const notJpeg = fakeJpeg(2000);
    notJpeg[0] = 0x89;
    expect((await upload(a, mission.id, notJpeg)).status).toBe(415);
    expect((await upload(a, mission.id, fakeJpeg(1_600_000))).status).toBe(413);
    expect((await upload(a, mission.id + 1, fakeJpeg(2000))).status).toBe(409);
    // 大きさを言わない送り方（chunked）は断る
    const ida = a.state.identity!;
    const chunked = await fetch(`${BASE}/api/game/${GAME}/photo?m=${mission.id}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-pid': ida.pid, 'x-key': ida.key },
      body: new ReadableStream({ start(ctl) { ctl.enqueue(fakeJpeg(2000)); ctl.close(); } }),
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(411);

    // あおが送る → あおの画面に「主催者が見ている」、主催者に写真が届く
    const res = await upload(a, mission.id, fakeJpeg(3000, 1));
    expect(res.status).toBe(200);
    const { id: photoA } = (await res.json()) as { id: string };
    await waitFor('自分の写真が見える', () => a.state.me?.sent?.[0]?.status === 'pending');
    await waitFor('主催者に届く', () => host.state.host?.photos?.some((p) => p.id === photoA) === true);
    expect(host.state.host!.photos![0].name).toBe('あお');

    // 見ていない写真は、本人と主催者だけ取り出せる
    expect((await getPhoto(a, photoA)).status).toBe(200);
    expect((await getPhoto('host', photoA)).status).toBe(200);
    expect((await getPhoto(b, photoA)).status).toBe(403);
    // 合い鍵なしは取り出せない
    expect((await fetch(`${BASE}/api/game/${GAME}/photo/${photoA}`)).status).toBe(403);

    // みどりも送る → やり直し → 撮り直して送る
    const r2 = await upload(b, mission.id, fakeJpeg(2500, 2));
    const { id: photoB } = (await r2.json()) as { id: string };
    host.command('judge', { photo: photoB, ok: false });
    await waitFor('みどりにやり直し', () => b.state.me?.sent?.[0]?.status === 'no');

    // 主催者があおを「成功」 → 全員の画面に、あおの名前で成功が届く
    host.command('judge', { photo: photoA, ok: true });
    await waitFor('全員に成功', () => players.every((p) => p.state.game?.missionOk?.some((x) => x.id === photoA && x.name === 'あお')));
    expect(a.state.game!.missionOk!.length).toBe(1);

    // 試合が動いている間は、成功した写真でもほかの人は取り出せない（写った場所で隠れ場所が分かるため）
    const g0 = host.state.game!;
    expect(isDone(g0.timer!, host.serverNow()!)).toBe(false);
    expect((await getPhoto(c, photoA)).status).toBe(403);

    // 1人が送れるのは5枚まで（やり直しの分も数える）。同時に6枚送っても、通るのは残りの4枚だけ
    const burst = await Promise.all(Array.from({ length: 6 }, () => upload(b, mission.id, fakeJpeg(1500, 3))));
    expect(burst.filter((r) => r.status === 200).length).toBe(4);
    expect(burst.filter((r) => r.status === 429).length).toBe(2);

    // 時間が0になると、成功した写真は全員が取り出せる（中身も同じ）
    await waitFor('時間が0', () => {
      const g = host.state.game;
      return !!g?.timer && isDone(g.timer, (host.serverNow() ?? Date.now()) - 300);
    }, 20_000);
    const got = await getPhoto(c, photoA);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(bytes.length).toBe(3000);
    expect(bytes[10]).toBe(1);
    // やり直しの写真は、時間が0になってもほかの人は取り出せない
    expect((await getPhoto(c, photoB)).status).toBe(403);

    // 締め切ると送れない。成功はそのまま
    host.command('mission-close');
    await waitFor('締め切り', () => players.every((p) => p.state.game?.mission?.open === false));
    expect((await upload(c, mission.id, fakeJpeg(2000))).status).toBe(409);
    expect(c.state.game!.missionOk!.length).toBe(1);

    // 結果を押して次のラウンド（配役）→ ミッションと成功の一覧は消える。写真は名簿と一緒に残る
    host.command('result', { winner: 'runner' });
    // 時間が0になるとアプリが先に結果を決めるので、主催者の手直しが届いた（resultAuto が外れた）のを待つ
    await waitFor('結果', () => host.state.game?.stage === 'result' && host.state.game?.resultAuto === false);
    host.command('assign');
    await waitFor('次の配役', () => host.state.game?.round === 2 && players.every((p) => p.state.game?.mission === null));
    expect(players.every((p) => (p.state.game?.missionOk ?? []).length === 0)).toBe(true);
    expect(host.state.host?.photos ?? []).toEqual([]);
    // 前のラウンドの成功した写真は、名簿の人なら取り出せる（試合中でも）
    expect((await getPhoto(c, photoA)).status).toBe(200);

    // 新しい夜を始めても、全部の夜の写真の一覧に残る
    host.command('clear');
    await waitFor('新しい夜', () => host.state.game?.stage === 'lobby');
    const album = (await (await fetch(`${BASE}/api/game/${GAME}/photos`, { headers: { 'x-host-token': TOKEN } })).json()) as {
      bytes: number;
      photos: { id: string; status: string; title: string; name: string; night: number }[];
    };
    expect(album.photos.length).toBe(6);
    expect(album.photos.find((p) => p.id === photoA)).toMatchObject({ status: 'ok', title: '3人で集合写真', name: 'あお', night: 1 });
    expect(album.bytes).toBe(3000 + 2500 + 4 * 1500);
    expect((await fetch(`${BASE}/api/game/${GAME}/photos`)).status).toBe(403);

    // 待合室でも出せる（最初の集合写真）。夜の最後（SEE YOU AGAIN）の間は出せない
    host.command('mission', { title: '' });
    await waitFor('待合室でミッション', () => host.state.game?.mission?.title === '集合写真を撮れ');
    host.command('end');
    await waitFor('夜を終える', () => host.state.game?.stage === 'ended' && host.state.game?.mission?.open === false);
    host.command('mission', { title: 'もう一枚' });
    await waitFor('夜の最後は断られる', () => host.state.lastReject?.op === 'mission');

    // 記録（CSV）に残る
    const csv = await (await fetch(`${BASE}/api/game/${GAME}/log`, { headers: { 'x-host-token': TOKEN } })).text();
    for (const w of ['ミッションを出した', '写真を送った', '写真：成功', '写真：やり直し', 'ミッションを締め切った']) expect(csv).toContain(w);
  }, 180_000);
});
