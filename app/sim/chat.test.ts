/**
 * チャットの機械テスト。全体の地図のテストと同じ作り（手元の wrangler dev に GameClient でつなぐ）。
 *
 * - 待合室：仲間の回線は無い。本部あての札は本部とその人にだけ届く。本部の返事はその人にだけ、全員あては全員に届く
 * - 配役のあと：鬼の回線は鬼だけ、逃走者の回線は逃走者だけ。主催者には全部が役つきで届く
 * - 札の代入：仲間の名前・場所の名前・位置。場所の一覧に無い名前・相手の役の人は捨てる。文字は送れない
 * - 制約：札／数字／絵文字を主催者が切り替える。牢屋の人は絵文字だけ（外せる）。続けて送った分は捨てる
 * - 時間が0になったら仲間の回線は閉じる。次の配役で前の試合の会話は画面から消え、記録には残る
 * - 開き直した人にも、いま見えてよい分がすぐ届く
 *
 * 実行：npx vitest run --config vitest.sim.config.ts sim/chat.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GameClient, type ChatSend, type KeyValueStore } from '../src/client/core/game-client';
import { CHAT_GAP_MS, chatText, EMOJI, type ChatMsg } from '../src/shared/chat';

const PORT = Number(process.env.CHAT_PORT ?? 8823);
const TOKEN = 'chattoken';
const GAME = `chat${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/game/${GAME}/ws`;
/** 逃走開始まで2秒・追跡開始まで2秒・ゲーム3分・広場に戻るまで2秒 */
const DUR = [2_000, 2_000, 180_000, 2_000];
const SFC = { lat: 35.38873, lon: 139.42701, acc: 8 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAP = CHAT_GAP_MS + 150;

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
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', mkdtempSync(join(tmpdir(), 'urafess-chat-')), '--var', `HOST_TOKEN:${TOKEN}`],
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

const msgsOf = (c: GameClient): ChatMsg[] => c.state.chat?.msgs ?? [];
const textsOf = (c: GameClient): string[] => msgsOf(c).map((m) => chatText(m)[0]);
const has = (c: GameClient, text: string) => textsOf(c).includes(text);

async function log(): Promise<{ kind: string; name: string | null; data: string | null }[]> {
  const r = await fetch(`${BASE}/api/game/${GAME}/log?format=json`, { headers: { 'x-host-token': TOKEN } });
  return (await r.json()) as never;
}

describe('チャット', () => {
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

  it('回線ごとに届く相手が分かれ、制約に合わない分は捨てられ、次の配役で消えて記録に残る', async () => {
    await startServer();
    const host = client('host');
    await waitFor('主催者がつながる', () => host.state.phase === 'ready');
    const names = ['あお', 'みどり', 'あか', 'しろ', 'くろ', 'きい'];
    const stores = names.map(() => memoryStore());
    const players = names.map((name, i) => {
      const p = client('player', stores[i]);
      p.join(name);
      return p;
    });
    await waitFor('6人が入室', () => players.every((p) => p.state.phase === 'ready' && p.state.me && p.state.chat) && host.state.host?.total === 6);
    expect(host.state.game?.chat?.mode).toBe('card');
    expect(host.state.game?.chat?.jail).toBe('emoji');
    /** 届くはずの人に届くのを待ち、届かないはずの人に届いていないのを確かめる */
    const lands = async (text: string, yes: GameClient[], no: GameClient[]) => {
      await waitFor(`「${text}」が届く`, () => yes.every((c) => has(c, text)), 5_000);
      await sleep(250);
      for (const c of no) expect(has(c, text)).toBe(false);
    };
    /** 捨てられるはずの分：少し待って、誰にも増えていない */
    const dropped = async (who: GameClient, m: ChatSend) => {
      const before = msgsOf(host).length;
      expect(who.chat(m)).toBe(true);
      await sleep(500);
      expect(msgsOf(host).length).toBe(before);
    };

    // ---- 待合室：仲間の回線は無い。本部あては本部とその人にだけ ----
    const [a, b] = players;
    await dropped(a, { ch: 'team', card: 'here' });
    a.chat({ ch: 'hq', card: 'hq-app' });
    await lands('アプリが動かない', [host, a], players.filter((p) => p !== a));
    const ask = msgsOf(host).find((m) => chatText(m)[0] === 'アプリが動かない')!;
    expect(ask.from?.name).toBe('あお');
    expect(typeof ask.pid).toBe('string');
    // 参加者に届く分には、送った人の印は入らない
    expect(msgsOf(a)[0].pid).toBeUndefined();
    host.hostChat(`pid:${ask.pid}`, 'いま行く。そこにいて');
    await lands('いま行く。そこにいて', [host, a], players.filter((p) => p !== a));
    expect(msgsOf(a).at(-1)!.from).toBeNull();
    host.hostChat('all', '10分後に始める');
    await lands('10分後に始める', [host, ...players], []);
    // 参加者が本部のふりをしても、文字は送れない
    await sleep(GAP);
    await dropped(b, { ch: 'hq', card: 'here' });
    (b as unknown as { send(m: object): void }).send({ t: 'chat', ch: 'hq', to: 'all', text: 'にせもの' });
    await sleep(400);
    expect(has(host, 'にせもの')).toBe(false);

    // ---- 配役：鬼は鬼だけ、逃走者は逃走者だけ ----
    host.command('durations', { durations: DUR });
    await waitFor('時間の設定', () => JSON.stringify(host.state.game?.durations) === JSON.stringify(DUR));
    host.command('ratio', { ratio: { oni: 1, runner: 2 } });
    await waitFor('割合', () => host.state.game?.ratio?.oni === 1);
    host.command('chat-places', { places: ['鴨池', 'メディア', '鴨池', ''] });
    await waitFor('場所の名前', () => JSON.stringify(host.state.game?.chat?.places) === JSON.stringify(['鴨池', 'メディア']));
    host.command('assign');
    await waitFor('配役', () => players.every((p) => p.state.me?.role));
    const oni = players.filter((p) => p.state.me!.role === 'oni');
    const runners = players.filter((p) => p.state.me!.role === 'runner');
    expect(oni.length).toBe(2);
    expect(runners.length).toBe(4);
    // 仲間の一覧は同じ役だけ（自分は入らない）
    await waitFor('仲間の一覧', () => runners.every((r) => r.state.chat?.team.length === 3) && oni.every((o) => o.state.chat?.team.length === 1));
    expect(runners[0].state.chat!.team.map((t) => t.num)).not.toContain(runners[0].state.me!.num);
    // 全員あての本部の知らせは、配役のあとも残る。待合室の1人あては、その人にだけ残る
    expect(players.every((p) => has(p, '10分後に始める'))).toBe(true);
    expect(has(a, 'いま行く。そこにいて')).toBe(true);

    await sleep(GAP);
    runners[0].chat({ ch: 'team', card: 'here', pos: SFC });
    await lands('ここにいる！', [host, ...runners], oni);
    const here = msgsOf(runners[1]).find((m) => m.card === 'here')!;
    expect(here.pos).toEqual({ lat: SFC.lat, lon: SFC.lon, acc: 8 });
    expect(msgsOf(host).find((m) => m.card === 'here')!.role).toBe('runner');
    oni[0].chat({ ch: 'team', card: 'no' });
    await lands('無理', [host, ...oni], runners);

    // 札の代入：仲間の名前・場所の名前
    await sleep(GAP);
    const mate = runners[1].state.me!;
    runners[0].chat({ ch: 'team', card: 'come', person: mate.num });
    await lands(`${mate.name}、一緒に来て！`, [host, ...runners], oni);
    await sleep(GAP);
    runners[0].chat({ ch: 'team', card: 'meet', place: '鴨池' });
    await lands('鴨池で合流しよう', [host, ...runners], oni);
    await sleep(GAP);
    // 一覧に無い場所・相手の役の人・絵文字と数字（いまは札だけ）は捨てる
    await dropped(runners[0], { ch: 'team', card: 'meet', place: 'うそ' });
    await dropped(runners[0], { ch: 'team', card: 'come', person: oni[0].state.me!.num });
    await dropped(runners[0], { ch: 'team', emoji: [0] });
    await dropped(runners[0], { ch: 'team', digit: '110' });

    // 続けて送った分は捨てる
    await sleep(GAP);
    const n0 = msgsOf(host).length;
    runners[2].chat({ ch: 'team', card: 'ok' });
    runners[2].chat({ ch: 'team', card: 'no' });
    await sleep(600);
    expect(msgsOf(host).length).toBe(n0 + 1);

    // ---- 制約を切り替える ----
    host.command('chat-mode', { chatMode: 'digit' });
    await waitFor('数字だけ', () => runners[0].state.game?.chat?.mode === 'digit');
    await sleep(GAP);
    await dropped(runners[0], { ch: 'team', card: 'ok' });
    runners[0].chat({ ch: 'team', digit: '110' });
    await lands('110', [host, ...runners], oni);
    host.command('chat-mode', { chatMode: 'card' });
    await waitFor('札だけ', () => runners[0].state.game?.chat?.mode === 'card');

    // ---- 牢屋の人は絵文字だけ ----
    host.command('start');
    await waitFor('ゲームの段階', () => {
      const t = host.state.game?.timer;
      const now = host.serverNow();
      return !!t && now !== null && now - t.t0 > DUR[0] + DUR[1] + 300;
    }, 15_000);
    const jailed = runners[3];
    host.command('capture', { pid: host.state.host!.capture!.runners.find((r) => r.num === jailed.state.me!.num)!.pid });
    await waitFor('牢屋に入る', () => jailed.state.me?.caught != null);
    await dropped(jailed, { ch: 'team', card: 'help' });
    jailed.chat({ ch: 'team', emoji: [3, 3] });
    await lands(EMOJI[3] + EMOJI[3], [host, ...runners], oni);
    expect(msgsOf(runners[0]).at(-1)!.jail).toBe(true);
    // 牢屋からでも、本部あての札は送れる
    await sleep(GAP);
    jailed.chat({ ch: 'hq', card: 'hq-come', pos: SFC });
    await lands('本部、来て', [host, jailed], [...oni, runners[0]]);
    host.command('chat-mode', { chatJail: 'same' });
    await waitFor('牢屋も同じ', () => jailed.state.game?.chat?.jail === 'same');
    await sleep(GAP);
    jailed.chat({ ch: 'team', card: 'help' });
    await lands('助けて！', [host, ...runners], oni);

    // 本部から鬼へ
    host.hostChat('oni', '鬼は広場に集まれ');
    await lands('鬼は広場に集まれ', [host, ...oni], runners);

    // 送れない設定
    host.command('chat-mode', { chatMode: 'off' });
    await waitFor('送れない', () => runners[0].state.game?.chat?.mode === 'off');
    await sleep(GAP);
    await dropped(runners[0], { ch: 'team', card: 'ok' });
    host.command('chat-mode', { chatMode: 'card' });
    await waitFor('札だけに戻す', () => runners[0].state.game?.chat?.mode === 'card');

    // ---- 開き直した人にも、いま見えてよい分が届く ----
    const again = client('player', stores[names.indexOf(runners[1].state.me!.name)]);
    await waitFor('開き直した人に届く', () => has(again, '鴨池で合流しよう') && has(again, '10分後に始める'));
    expect(has(again, '無理')).toBe(false);
    expect(has(again, '鬼は広場に集まれ')).toBe(false);

    // ---- 時間が0になったら仲間の回線は閉じる ----
    host.command('skip');
    await sleep(2_600);
    host.command('skip');
    await waitFor('結果', () => host.state.game?.stage === 'result', 15_000);
    await sleep(GAP);
    await dropped(runners[0], { ch: 'team', card: 'ok' });
    // 終わったあとも、その試合の会話は読める
    expect(has(runners[0], '鴨池で合流しよう')).toBe(true);

    // ---- 次の配役：前の試合の会話は画面から消える。全員あての本部の知らせは残る ----
    host.command('assign');
    await waitFor('次の配役で消える', () => [host, ...players].every((c) => !has(c, '鴨池で合流しよう') && !has(c, '無理') && !has(c, '鬼は広場に集まれ')));
    expect(players.every((p) => has(p, '10分後に始める'))).toBe(true);
    expect(has(host, 'アプリが動かない')).toBe(true);

    // ---- 記録には全部残る ----
    const rows = (await log()).filter((r) => r.kind === 'chat');
    const texts = rows.map((r) => (JSON.parse(r.data!) as { text: string }).text);
    for (const t of ['アプリが動かない', 'いま行く。そこにいて', '10分後に始める', 'ここにいる！', '鴨池で合流しよう', '110', '助けて！', '鬼は広場に集まれ']) expect(texts).toContain(t);
    expect(texts).not.toContain('にせもの');
    expect(rows.find((r) => (JSON.parse(r.data!) as { text: string }).text === 'ここにいる！')!.name).toBe(runners[0].state.me!.name);

    // ---- 新しい夜：本部の回線も空になる ----
    host.command('end');
    await waitFor('夜を終える', () => host.state.game?.stage === 'ended');
    host.command('clear');
    await waitFor('新しい夜で空に', () => msgsOf(host).length === 0 && players.every((p) => p.state.chat === null));
  }, 240_000);
});
