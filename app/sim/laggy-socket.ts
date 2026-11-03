import type { WebSocketLike } from '../src/client/core/game-client';

/**
 * 回線の遅れを再現する WebSocket。行き（送る）と帰り（受け取る）に別々の遅れを入れる。
 * 本物の回線（TCP）と同じく、順番は決して入れ替えない（向きごとに1本の列で流す）。
 * kill() で、電波が切れたときのように突然切る。
 */
class OrderedDelay {
  private readonly queue: { at: number; data: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;

  constructor(
    private readonly delay: () => number,
    private readonly deliver: (data: string) => void,
  ) {}

  push(data: string): void {
    const at = Math.max(this.lastAt, Date.now() + this.delay());
    this.lastAt = at;
    this.queue.push({ at, data });
    this.pump();
  }

  clear(): void {
    this.queue.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      while (this.queue.length > 0 && this.queue[0].at <= now) this.deliver(this.queue.shift()!.data);
      this.pump();
    }, Math.max(0, this.queue[0].at - Date.now()));
  }
}

export class LaggySocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private readonly inner: WebSocket;
  private readonly upLink: OrderedDelay;
  private readonly downLink: OrderedDelay;
  private closed = false;

  constructor(
    url: string,
    up: () => number,
    down: () => number,
    private readonly onRaw?: (data: string) => void,
  ) {
    this.inner = new WebSocket(url);
    this.upLink = new OrderedDelay(up, (data) => {
      if (!this.closed && this.inner.readyState === 1) this.inner.send(data);
    });
    this.downLink = new OrderedDelay(down, (data) => {
      if (this.closed) return;
      this.onRaw?.(data);
      this.onmessage?.({ data });
    });
    this.inner.onopen = () => this.onopen?.({});
    this.inner.onmessage = (ev) => this.downLink.push(String(ev.data));
    this.inner.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.upLink.clear();
      this.downLink.clear();
      this.onclose?.({});
    };
    this.inner.onerror = () => this.onerror?.({});
  }

  get readyState(): number {
    return this.closed ? 3 : this.inner.readyState;
  }

  send(data: string): void {
    this.upLink.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.upLink.clear();
    this.downLink.clear();
    try {
      this.inner.close(code, reason);
    } catch {
      // 閉じている
    }
  }

  /** 電波が切れたときのように、こちらからは何も言わずに切る */
  kill(): void {
    if (this.closed) return;
    this.close();
    this.onclose?.({});
  }
}
