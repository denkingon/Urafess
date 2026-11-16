import { LOG_NOISE, type LogLine } from '../../shared/logline';

/**
 * 本部の「ログ」の窓。サーバーの記録（1イベント＝1行）を、端末のように下へ流していく。
 *
 * - 開いている間だけ、数秒ごとに「前に読んだ行より後」をサーバーに聞く（閉じたら聞かない＝リクエストを使わない）
 * - いちばん下を見ているときは新しい行についていく。上を読んでいるときは止まって、「新しい N 行」を出す
 * - 長押し・音・光った/消えた などの細かい記録は、ふだんは隠す（「細かいものも」で出す）
 * - 色は人と出来事にだけ：捕獲・失格は朱、解放・成功は蓄光、主催者の操作は月白の太字、チャットはあやめ
 * - スマホは画面いっぱい。幅の広い画面は右下に浮かぶ窓で、上の帯をつかんで動かせる・角で大きさを変えられる
 */

export interface Term {
  el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** 開け閉めが変わったとき（入口のボタンの見た目のため） */
  onChange?: (open: boolean) => void;
}

const POLL_MS = 2500;
const FIRST_TAIL = 300;
const KEEP_LINES = 2000;

const HOST_OPS = new Set(['assign', 'start', 'pause', 'resume', 'reset', 'result', 'end', 'clear', 'durations', 'ratio', 'mic', 'wish-mode',
  'cast', 'recast', 'area', 'jail-place', 'remove', 'host-key', 'chat-mode', 'chat-places', 'mission', 'mission-close', 'shrink', 'shrink-plan', 'skip']);
const BAD = new Set(['sos', 'capture', 'dq', 'all-caught', 'bad-name', 'taken', 'name-shame']);
const GOOD = new Set(['rescue', 'mission-free', 'photo-ok', 'meet', 'dq-ok', 'sos-done']);

function tone(l: LogLine): string {
  if (BAD.has(l.kind)) return 'bad';
  if (GOOD.has(l.kind)) return 'good';
  if (l.kind === 'chat') return 'chat';
  if (HOST_OPS.has(l.kind) || l.kind.startsWith('lead')) return 'op';
  if (LOG_NOISE.has(l.kind)) return 'noise';
  return '';
}

/** 詳細（JSON）を「k=v」の短い並びにする。端末の名残（ua）は落とす */
function detail(data: string): string {
  if (!data) return '';
  let out = data;
  try {
    const d = JSON.parse(data) as unknown;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      out = Object.entries(d as Record<string, unknown>)
        .filter(([k, v]) => k !== 'ua' && v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
    }
  } catch {
    /* JSON でなければそのまま */
  }
  return out.length > 160 ? `${out.slice(0, 159)}…` : out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function elapsed(s: number | null): string {
  if (s === null) return '';
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function createTerm(fetchLines: (after: number, tail: number) => Promise<LogLine[] | null>): Term {
  const el = mk('section', 'term');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'ログ');
  el.hidden = true;

  const bar = mk('header', 'term-bar');
  const title = mk('h2', 'term-title');
  title.append(mk('span', 'term-prompt', '>_'), mk('span', '', 'ログ'));
  const live = mk('span', 'term-live');
  const noiseBtn = mk('button', 'term-btn', '細かいものも');
  noiseBtn.type = 'button';
  noiseBtn.setAttribute('aria-pressed', 'false');
  const closeBtn = mk('button', 'term-btn term-close', '閉じる');
  closeBtn.type = 'button';
  bar.append(title, live, noiseBtn, closeBtn);

  const screen = mk('div', 'term-screen');
  screen.tabIndex = 0;
  const jump = mk('button', 'term-jump');
  jump.type = 'button';
  jump.hidden = true;
  el.append(bar, screen, jump);

  let isOpen = false;
  let lastId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let follow = true;
  let unseen = 0;
  let failing = false;

  const atBottom = () => screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
  const toBottom = () => {
    screen.scrollTop = screen.scrollHeight;
    unseen = 0;
    jump.hidden = true;
  };
  screen.addEventListener('scroll', () => {
    follow = atBottom();
    if (follow) {
      unseen = 0;
      jump.hidden = true;
    }
  }, { passive: true });
  jump.addEventListener('click', () => {
    follow = true;
    toBottom();
  });

  const setLive = (text: string, bad = false) => {
    live.textContent = text;
    live.classList.toggle('is-bad', bad);
  };

  const row = (l: LogLine): HTMLElement => {
    const r = mk('div', 'term-line');
    const t = tone(l);
    if (t) r.dataset.tone = t;
    if (LOG_NOISE.has(l.kind)) r.dataset.noise = '';
    r.append(mk('span', 'term-t', clock(l.at)));
    const where = [l.round ? `R${l.round}` : '', l.phase, elapsed(l.el)].filter(Boolean).join(' ');
    if (where) r.append(mk('span', 'term-w', where));
    r.append(mk('span', 'term-k', l.label));
    if (l.who) r.append(mk('span', 'term-p', l.who));
    if (l.other) r.append(mk('span', 'term-o', `→ ${l.other}`));
    if (l.via) r.append(mk('span', 'term-v', `[${l.via}]`));
    const d = detail(l.data);
    if (d) r.append(mk('span', 'term-d', d));
    return r;
  };

  const add = (lines: LogLine[]) => {
    if (!lines.length) return;
    const stick = follow;
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const l of lines) {
      if (l.id <= lastId) continue;
      lastId = l.id;
      frag.append(row(l));
      if (!LOG_NOISE.has(l.kind) || el.dataset.noise === 'on') shown += 1;
    }
    screen.append(frag);
    while (screen.childElementCount > KEEP_LINES) screen.firstElementChild!.remove();
    if (stick) toBottom();
    else if (shown) {
      unseen += shown;
      jump.textContent = `↓ 新しい ${unseen} 行`;
      jump.hidden = false;
    }
  };

  const poll = async () => {
    timer = null;
    if (!isOpen) return;
    if (document.hidden) {
      timer = setTimeout(poll, POLL_MS);
      return;
    }
    if (!busy) {
      busy = true;
      try {
        const lines = await fetchLines(lastId, FIRST_TAIL);
        if (lines === null) throw new Error('log');
        if (!screen.childElementCount && !lines.length) screen.append(mk('div', 'term-line term-empty', 'まだ記録がない'));
        else screen.querySelector('.term-empty')?.remove();
        add(lines);
        failing = false;
        setLive('● 受信中');
      } catch {
        if (!failing) setLive('● 読めない', true);
        failing = true;
      } finally {
        busy = false;
      }
    }
    if (isOpen) timer = setTimeout(poll, POLL_MS);
  };

  noiseBtn.addEventListener('click', () => {
    const on = el.dataset.noise !== 'on';
    el.dataset.noise = on ? 'on' : 'off';
    noiseBtn.setAttribute('aria-pressed', String(on));
    if (follow) toBottom();
  });

  const term: Term = {
    el,
    get isOpen() {
      return isOpen;
    },
    open() {
      if (isOpen) return;
      isOpen = true;
      el.hidden = false;
      setLive('● …');
      follow = true;
      // 幅の広い画面：最初に開いたとき、右下の位置を左上の位置に置きかえる（角で大きさを変えると右下へ広がるように）
      if (matchMedia('(min-width: 1024px)').matches && !el.style.left) {
        const r = el.getBoundingClientRect();
        Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, right: 'auto', bottom: 'auto' });
      }
      requestAnimationFrame(toBottom);
      if (!timer) void poll();
      term.onChange?.(true);
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      el.hidden = true;
      if (timer) clearTimeout(timer);
      timer = null;
      term.onChange?.(false);
    },
    toggle() {
      if (isOpen) term.close();
      else term.open();
    },
  };
  closeBtn.addEventListener('click', () => term.close());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') term.close();
  });

  // 幅の広い画面：上の帯をつかんで動かす（ボタンの上ではつかまない）
  let drag: { dx: number; dy: number; id: number } | null = null;
  bar.addEventListener('pointerdown', (e) => {
    if (!matchMedia('(min-width: 1024px)').matches || (e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    bar.setPointerCapture(e.pointerId);
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = el.offsetWidth;
    const x = Math.min(Math.max(e.clientX - drag.dx, 8 - w + 120), innerWidth - 120);
    const y = Math.min(Math.max(e.clientY - drag.dy, 0), innerHeight - 48);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });
  const drop = () => {
    drag = null;
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  el.dataset.noise = 'off';
  return term;
}
