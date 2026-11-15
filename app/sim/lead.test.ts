/**
 * 司令塔の機械テスト。全体の地図のテストと同じ作り（手元の wrangler dev に GameClient でつなぐ）。
 *
 * - 外してある間は前のまま。入れると、配役のたびに鬼の側・逃走者の側からくじで1人ずつ決まる。主催者は指名・引き直しで替えられる
 * - 仲間の居場所が届くのは司令塔だけ。司令塔は走っていなくても、名前と場所が全員に光る（札）
 * - 逃走者の司令塔が捕まると：司令塔の地図が消える・鬼の全員に逃走者が見える（札）。助ければ戻る（札）
 * - 札は試合中でも1枚ずつ入れたり外したりできる。外すと前のまま
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/lead.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type KeyValueStore } from '../src/client/core/game-client';
import type { GlowEntry, MateEntry } from '../src/shared/protocol';
import { MATES_STALE_MS, RUN_STALE_MS, START_LEAD_MS } from '../src/shared/rules';
import { positionAt } from '../src/shared/schedule';

const PORT = Number(process.env.LEAD_PORT ?? 8829);
const TOKEN = 'glowtoken';
const GAME = `lead${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで3秒・追跡開始まで3秒・ゲーム3分・広場に戻るまで3秒 */
const DUR = [3_000, 3_000, 180_000, 3_000];
/** SFC の鴨池のあたり */
const SFC = { lat: 35.38873, lon: 139.42701 };

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-lead-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

const stores = new Map<GameClient, KeyValueStore>();

function client(kind: 'player' | 'host', storage: KeyValueStore = memoryStore()): GameClient {
  const c = new GameClient(
    { url: WS_URL, gameId: GAME, now: () => Date.now(), storage, createSocket: (u) => new WebSocket(u) as never },
    kind === 'host' ? { kind: 'host', token: TOKEN } : { kind: 'player' },
  );
  c.start();
  clients.push(c);
  stores.set(c, storage);
  return c;
}

function phaseOf(c: GameClient): number | 'done' {
  const timer = c.state.game?.timer;
  const now = c.serverNow();
  if (!timer || now === null) return -1;
  const pos = positionAt(timer, now);
  return pos.kind === 'done' ? 'done' : pos.index;
}

/** その人の手元で、いま光っている人（古い分は画面と同じく捨てる） */
function litOf(c: GameClient): GlowEntry[] {
  const now = c.serverNow() ?? Date.now();
  return (c.state.glow?.runs ?? []).filter((r) => now - r.at <= RUN_STALE_MS);
}
const litNums = (c: GameClient) => litOf(c).map((r) => r.num).sort((a, b) => a - b);

/** 北へ m、東へ m の位置 */
const at = (north: number, east: number) => ({
  lat: SFC.lat + north / 111_195,
  lon: SFC.lon + east / (111_195 * Math.cos((SFC.lat * Math.PI) / 180)),
  acc: 8,
});

async function log(): Promise<{ kind: string; num: number | null; data: string | null; phase: number | null }[]> {
  const r = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}


/** その人の手元の地図に出ている人（古い分は画面と同じく捨てる） */
function matesOf(c: GameClient): MateEntry[] {
  const now = c.serverNow() ?? Date.now();
  return (c.state.mates?.people ?? []).filter((m) => now - m.at <= MATES_STALE_MS);
}
const mateNums = (c: GameClient) => matesOf(c).map((m) => m.num).sort((a, b) => a - b);
void litOf;
void litNums;
void START_LEAD_MS;

describe('司令塔', () => {
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

  it('司令塔だけが地図を見られ、見られ、落ちると鬼に全員が見え、助ければ戻る。札は1枚ずつ切りかえられる', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const names = ['あお', 'みどり', 'あか', 'しろ', 'くろ', 'きい'];
    const players = names.map((name) => {
      const p = client('player');
      p.join(name);
      return p;
    });
    await waitFor('6人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me) && host.state.host?.total === 6);
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('ratio', { ratio: { oni: 1, runner: 2 } });
    await waitFor('割合', () => host.state.game?.ratio?.oni === 1);

    // ---- はじめは外してある ----
    expect(host.state.game?.lead).toEqual({ on: false, seen: true, dark: true, expose: true, restore: true });
    // 外してある間は、指名も引き直しもできない
    host.command('lead-draw', { role: 'oni' });
    await waitFor('断られる', () => host.state.lastReject?.op === 'lead-draw');
    // 形のおかしい札は断る
    host.command('lead', { lead: { nope: true } as never });
    await waitFor('断られる', () => host.state.lastReject?.op === 'lead');

    // ---- 入れてから配役：くじで1人ずつ ----
    host.command('lead', { lead: { on: true } });
    await waitFor('札が入る', () => host.state.game?.lead?.on === true);
    expect(host.state.host?.lead ?? null).toBeNull();
    host.command('assign');
    await waitFor('配役と司令塔', () => players.every((p) => p.state.me?.role && p.state.me.lead) && !!host.state.host?.lead?.oni && !!host.state.host?.lead?.runner);
    const oni = players.filter((p) => p.state.me!.role === 'oni');
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    expect(oni.length).toBe(2);
    expect(runners.length).toBe(4);
    const leadOf = (side: GameClient[]) => side.filter((p) => p.state.me!.lead!.mine);
    expect(leadOf(oni).length).toBe(1);
    expect(leadOf(runners).length).toBe(1);
    for (const side of [oni, runners]) {
      const boss = leadOf(side)[0];
      for (const p of side) {
        expect(p.state.me!.lead!.name).toBe(boss.state.me!.name);
        expect(p.state.me!.lead!.map).toBe(p === boss);
        expect(p.state.me!.lead!.down).toBe(false);
      }
    }
    expect(host.state.host!.lead!.oni!.pid).toBe(leadOf(oni)[0].state.me!.pid);

    // ---- 指名で替える・くじで引き直す ----
    const firstBoss = leadOf(runners)[0];
    const picked = runners.find((p) => p !== firstBoss)!;
    host.command('lead-pick', { pid: picked.state.me!.pid });
    await waitFor('指名', () => picked.state.me?.lead?.mine === true && firstBoss.state.me?.lead?.mine === false);
    expect(runners.every((p) => p.state.me!.lead!.name === picked.state.me!.name)).toBe(true);
    const oniBoss0 = leadOf(oni)[0];
    host.command('lead-draw', { role: 'oni' });
    await waitFor('引き直し（2人なので、もう1人になる）', () => leadOf(oni).length === 1 && leadOf(oni)[0] !== oniBoss0);
    const oniBoss = leadOf(oni)[0];
    const oniCrew = oni.find((p) => p !== oniBoss)!;
    const boss = picked;
    const crew = runners.filter((p) => p !== boss);

    // ---- ゲームの段階：仲間が見えるのは司令塔だけ。司令塔は全員に光る ----
    const sendAll = (k = 0) => players.forEach((p, i) => p.pos(at(10 * i + k, 5 * i)));
    const numsOf = (ps: GameClient[]) => ps.map((p) => p.state.me!.num).sort((a, b) => a - b);
    host.command('start');
    await waitFor('ゲームの段階', () => phaseOf(players[0]) === 2 && phaseOf(host) === 2, 20_000);
    await sleep(300);
    sendAll(1);
    await waitFor('主催者に全員', () => matesOf(host).length === 6, 3_000);
    await waitFor('逃走者の司令塔に仲間', () => JSON.stringify(mateNums(boss)) === JSON.stringify(numsOf(runners)), 3_000);
    await waitFor('鬼の司令塔に仲間', () => JSON.stringify(mateNums(oniBoss)) === JSON.stringify(numsOf(oni)), 3_000);
    await sleep(1_200);
    for (const p of [...crew, oniCrew]) expect(matesOf(p).length).toBe(0);
    // 司令塔に届く分にも、相手の役は入らない
    expect(JSON.stringify(boss.state.mates)).not.toMatch(/"role"/);
    const leadLights = (c: GameClient) =>
      (c.state.glow?.runs ?? []).filter((r) => r.lead).map((r) => `${r.lead}:${r.num}`).sort();
    const bothLit = [`oni:${oniBoss.state.me!.num}`, `runner:${boss.state.me!.num}`].sort();
    await waitFor('司令塔は走っていなくても全員に光る', () => [...players, host].every((c) => JSON.stringify(leadLights(c)) === JSON.stringify(bothLit)), 3_000);
    const lit = (crew[0].state.glow?.runs ?? []).find((r) => r.lead === 'oni')!;
    expect(lit.name).toBe(oniBoss.state.me!.name);
    expect(lit.lat).toBeCloseTo(at(10 * players.indexOf(oniBoss) + 1, 5 * players.indexOf(oniBoss)).lat, 5);
    // 司令塔でない人は光らない
    expect((host.state.glow?.runs ?? []).length).toBe(2);

    // ---- 「相手に見える」を外すと光が消え、入れると戻る ----
    host.command('lead', { lead: { seen: false } });
    await waitFor('光が消える', () => [...players, host].every((c) => leadLights(c).length === 0), 3_000);
    host.command('lead', { lead: { seen: true } });
    await waitFor('光が戻る', () => [...players, host].every((c) => leadLights(c).length === 2), 3_000);

    // ---- 逃走者の司令塔が捕まる：地図が消え、鬼の全員に逃走者が見える ----
    host.command('capture', { pid: boss.state.me!.pid, by: oniCrew.state.me!.pid });
    await waitFor('落ちた', () => players.every((p) => p.state.me?.lead?.down === true) && host.state.host?.lead?.down === true, 3_000);
    sendAll(2);
    await waitFor('司令塔の地図が消える', () => matesOf(boss).length === 0, 3_000);
    expect(boss.state.me!.lead!.map).toBe(false);
    await waitFor('鬼の司令塔でない人に、逃走者が役つきで見える', () => JSON.stringify(mateNums(oniCrew)) === JSON.stringify(numsOf(crew)), 3_000);
    expect(matesOf(oniCrew).every((m) => m.role === 'runner')).toBe(true);
    expect(oniCrew.state.me!.lead!.foes).toBe(true);
    expect(oniCrew.state.me!.lead!.map).toBe(true);
    await waitFor('鬼の司令塔には、仲間と逃走者', () => matesOf(oniBoss).length === oni.length + crew.length, 3_000);
    expect(matesOf(oniBoss).filter((m) => m.role === 'runner').length).toBe(crew.length);
    // 逃走者の側は、誰も地図を持っていない
    for (const p of crew) expect(matesOf(p).length).toBe(0);
    // 牢屋の司令塔は光らない（鬼の司令塔だけ光る）
    await waitFor('牢屋の司令塔は光らない', () => JSON.stringify(leadLights(crew[0])) === JSON.stringify([`oni:${oniBoss.state.me!.num}`]), 3_000);

    // ---- 「鬼に全員が見える」を外すと、すぐ見えなくなる。入れると戻る ----
    host.command('lead', { lead: { expose: false } });
    await waitFor('鬼に見えなくなる', () => matesOf(oniCrew).length === 0 && oniCrew.state.me?.lead?.foes === false, 3_000);
    host.command('lead', { lead: { expose: true } });
    await waitFor('また見える', () => matesOf(oniCrew).length === crew.length, 3_000);
    // 「地図が消える」を外すと、牢屋の司令塔にも地図が戻る
    host.command('lead', { lead: { dark: false } });
    await waitFor('牢屋の司令塔に地図', () => matesOf(boss).length === crew.length && boss.state.me?.lead?.map === true, 3_000);
    host.command('lead', { lead: { dark: true } });
    await waitFor('また消える', () => matesOf(boss).length === 0, 3_000);

    // ---- 助ければ元に戻る ----
    host.command('mission-free', { n: 1 });
    await waitFor('戻った', () => players.every((p) => p.state.me?.lead?.down === false) && boss.state.me?.caught === null, 3_000);
    sendAll(3);
    await waitFor('鬼に見えなくなる', () => matesOf(oniCrew).length === 0, 3_000);
    await waitFor('司令塔に地図が戻る', () => JSON.stringify(mateNums(boss)) === JSON.stringify(numsOf(runners)), 3_000);

    // ---- 「助ければ戻る」を外す：一度落ちたら、助けても落ちたまま ----
    host.command('lead', { lead: { restore: false } });
    await waitFor('札', () => host.state.game?.lead?.restore === false);
    // 前に一度落ちているので、札を外した時点で「落ちている」になる
    await waitFor('落ちたまま', () => players.every((p) => p.state.me?.lead?.down === true), 3_000);
    sendAll(4);
    await waitFor('鬼に見える', () => matesOf(oniCrew).length === runners.length, 3_000);
    // 主催者が司令塔を替えると、落ちたことは消える
    host.command('lead-pick', { pid: crew[0].state.me!.pid });
    await waitFor('替えた', () => crew[0].state.me?.lead?.mine === true && players.every((p) => p.state.me?.lead?.down === false), 3_000);

    // ---- 司令塔を別の役へ動かせないので（試合中）、外した人の席はくじで埋まる ----
    host.command('remove', { pid: crew[0].state.me!.pid });
    await waitFor('空いた席が埋まる', () => {
      const l = host.state.host?.lead?.runner;
      return !!l && l.pid !== crew[0].state.me!.pid;
    }, 3_000);

    // ---- しくみを外すと、前のまま ----
    host.command('lead', { lead: { on: false } });
    await waitFor('外した', () => host.state.game?.lead?.on === false && players.filter((p) => p !== crew[0]).every((p) => !p.state.me?.lead), 3_000);
    sendAll(5);
    const still = runners.filter((p) => p !== crew[0]);
    await waitFor('逃走者に逃走者どうし', () => still.every((p) => JSON.stringify(mateNums(p)) === JSON.stringify(numsOf(still))), 3_000);
    await waitFor('鬼に鬼どうし', () => oni.every((p) => JSON.stringify(mateNums(p)) === JSON.stringify(numsOf(oni))), 3_000);
    await waitFor('光は消える', () => (host.state.glow?.runs ?? []).length === 0, 3_000);
    expect(host.state.host?.lead ?? null).toBeNull();

    // ---- 記録 ----
    const kinds = (await log()).map((e) => e.kind);
    for (const k of ['lead', 'lead-set', 'lead-down', 'lead-back']) expect(kinds).toContain(k);
  }, 180_000);
});
