import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameClient, type KeyValueStore, type WebSocketLike } from '../src/client/core/game-client';
import type { GameView, ServerMsg, Stage } from '../src/shared/protocol';
import { SILENCE_LIMIT_MS } from '../src/shared/rules';

/** 試合中の合図（hb）が途切れたときの見張りを、偽の WebSocket と偽の時計で確かめる */

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private answered = new Set<number>();
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** まだ返事をしていない時計合わせの問い合わせに、すべて返事をする */
  answerPings(): void {
    for (const raw of this.sent) {
      const m = JSON.parse(raw) as { t: string; id?: number; a?: number };
      if (m.t !== 'ping' || m.id === undefined || this.answered.has(m.id)) continue;
      this.answered.add(m.id);
      this.receive({ t: 'pong', id: m.id, a: m.a ?? 0, s: Date.now() });
    }
  }
}

function game(stage: Stage): GameView {
  return {
    gameId: 't',
    round: 1,
    assignId: 1,
    stage,
    cv: 1,
    timer: null,
    counts: { oni: 1, runner: 2, total: 3, caught: 0 },
    result: null,
    durations: [1_000, 1_000, 1_000, 1_000],
  };
}

/** 入室済みの参加者に届く状態（me つき） */
function snap(stage: Stage): ServerMsg {
  return {
    t: 'snap',
    now: Date.now(),
    game: game(stage),
    me: {
      pid: 'p1', num: 1, name: 'テスト', role: 'runner', assignId: 1, removed: false,
      code: '123', caught: null, catches: 0, claim: null,
    },
  };
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

let sockets: FakeSocket[];
let client: GameClient;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  client = new GameClient(
    {
      url: 'ws://test/api/game/t/ws',
      gameId: 't',
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      now: () => Date.now(),
      storage: memoryStore(),
      random: () => 0,
    },
    { kind: 'player' },
  );
  client.start();
  sockets[0].open();
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
});

describe('試合中の合図の見張り', () => {
  it('合図が2秒ごとに届いている間は切らない', () => {
    const s = sockets[0];
    s.receive(snap('timer'));
    for (let i = 0; i < 30; i++) {
      s.receive({ t: 'hb', s: Date.now() });
      vi.advanceTimersByTime(2_000);
      s.answerPings();
    }
    expect(s.closed).toBe(false);
    expect(sockets.length).toBe(1);
  });

  it('合図も返事も届かなくなったら、SILENCE_LIMIT_MS ＋見張りの間隔（1秒）以内に切ってつなぎ直す', () => {
    const s = sockets[0];
    s.receive(snap('timer'));
    s.receive({ t: 'hb', s: Date.now() });
    vi.advanceTimersByTime(1_500);
    s.answerPings();

    // ここから何も届かない（見えない切断）
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1_000);
    expect(s.closed).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(s.closed).toBe(true);
    // 少し待つと新しい接続を張る
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBe(2);
  });

  it('合図を一度も受け取っていない接続（合図を出さない古いサーバー）は見張らない', () => {
    const s = sockets[0];
    s.receive(snap('timer'));
    vi.advanceTimersByTime(1_500);
    s.answerPings();
    vi.advanceTimersByTime(6_000);
    s.answerPings();
    vi.advanceTimersByTime(4_500);
    expect(s.closed).toBe(false);
    expect(sockets.length).toBe(1);
  });

  it('待合室・結果発表では合図が止まるので見張らない', () => {
    const s = sockets[0];
    s.receive(snap('timer'));
    s.receive({ t: 'hb', s: Date.now() });
    s.receive(snap('result'));
    vi.advanceTimersByTime(1_500);
    s.answerPings();
    vi.advanceTimersByTime(6_000);
    s.answerPings();
    vi.advanceTimersByTime(4_500);
    expect(s.closed).toBe(false);
  });

  it('入室画面に戻された人（主催者が部屋を空にした等）は、古い段階が残っていても見張らない', () => {
    const s = sockets[0];
    s.receive(snap('assigned'));
    s.receive({ t: 'hb', s: Date.now() });
    // 部屋を空にすると、サーバーは参加者に unknown を送り、合図も止まる（待合室に戻るため）
    s.receive({ t: 'unknown' });
    expect(client.state.phase).toBe('need-name');
    vi.advanceTimersByTime(1_500);
    s.answerPings();
    vi.advanceTimersByTime(6_000);
    s.answerPings();
    vi.advanceTimersByTime(4_500);
    expect(s.closed).toBe(false);
    expect(sockets.length).toBe(1);
  });

  it('画面に戻ったとき（wake）に合図が途切れていれば、待たずにその場でつなぎ直す', () => {
    const s = sockets[0];
    s.receive(snap('timer'));
    s.receive({ t: 'hb', s: Date.now() });
    vi.advanceTimersByTime(1_500);
    s.answerPings();
    // 見張りがまだ気づいていない瞬間（無音が上限を少し超えたところ）に画面へ戻る
    vi.setSystemTime(Date.now() + SILENCE_LIMIT_MS + 100);
    client.wake();
    expect(s.closed).toBe(true);
    expect(sockets.length).toBe(2);
  });
});
