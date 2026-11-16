import './sos.css';
import type { GameView, HostSos } from '../../shared/protocol';

/**
 * 主催者（前の画面・本部の両方）：救護の呼び出しの帯。画面のいちばん上にかぶせて出す（ほかの何より先に見るもの）。
 * 本部がまだ見ていない呼び出しがある間は、音と振動で鳴り続ける。「見た・向かう」で鳴りやみ、押した人の画面に「本部が見た」と出る。
 * 試合は止めない（止めるかは本部が決める。帯に一時停止を置いた）
 */

export interface SosHost {
  el: HTMLElement;
  update(list: HostSos[] | undefined, game: GameView | null, serverNow: number): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}秒前` : `${Math.floor(s / 60)}分${s % 60}秒前`;
};

const ROLE: Record<string, string> = { oni: '鬼', runner: '逃走者' };

export function createSosHost(act: { command(op: 'sos-ack' | 'sos-done' | 'pause', extra?: { rid?: string }): boolean }): SosHost {
  const el = document.createElement('section');
  el.className = 'sos-host';
  el.hidden = true;
  el.setAttribute('role', 'alert');

  // 鳴らす音（Web Audio。画面に一度触れたあとでないと鳴らない）
  let ctx: AudioContext | null = null;
  const unlock = () => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      ctx = null;
    }
  };
  document.addEventListener('pointerup', unlock, { capture: true, passive: true });
  const beep = () => {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    for (const [i, f] of [880, 660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.17);
    }
    try {
      navigator.vibrate?.([300, 100, 300]);
    } catch {
      // 振動できない端末
    }
  };
  let ringing = false;
  setInterval(() => ringing && beep(), 1500);

  /** 「終わった」は2回押す（1回目のあと5秒まで）。描き直しても覚えておく */
  let sure: { id: string; at: number } | null = null;
  /** 押して返事を待っているもの（op:id）。状態が変われば消える */
  const sent = new Set<string>();
  let lastKey = '';
  let listKey = '';
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-op]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const op = b.dataset.op as 'sos-ack' | 'sos-done' | 'pause';
    const id = b.dataset.id ?? '';
    if (op === 'sos-done' && !(sure && sure.id === id && Date.now() - sure.at < 5_000)) {
      sure = { id, at: Date.now() };
      lastKey = '';
      return;
    }
    sure = null;
    if (act.command(op, op === 'pause' ? {} : { rid: id })) sent.add(`${op}:${id}`);
    lastKey = '';
  });

  return {
    el,
    update(list, game, serverNow) {
      const items = list ?? [];
      ringing = items.some((x) => x.status === 'open');
      el.hidden = items.length === 0;
      document.body.classList.toggle('has-sos-host', items.length > 0);
      const running = game?.stage === 'timer' && game.timer?.status === 'running';
      // 経過の秒を出すので、1秒ごとに描き直す
      const base = JSON.stringify([items, running]);
      if (base !== listKey) {
        listKey = base;
        sent.clear();
      }
      if (sure && Date.now() - sure.at >= 5_000) sure = null;
      const key = `${base}${Math.floor(serverNow / 1000)}${sure?.id ?? ''}${[...sent].join()}`;
      if (key === lastKey) return;
      lastKey = key;
      const dis = (op: string, id: number | string) => (sent.has(`${op}:${id}`) ? ' disabled' : '');
      if (items.length === 0) {
        el.replaceChildren();
        return;
      }
      el.innerHTML =
        `<div class="sos-host-top"><b><svg class="sos-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z" fill="currentColor"/></svg>救護の呼び出し ${items.length}件</b>` +
        (running ? `<button type="button" data-op="pause"${dis('pause', '')}>試合を一時停止</button>` : '') +
        `</div>` +
        items
          .map((x) => {
            const who = [x.role ? ROLE[x.role] : '役なし', x.caught ? '牢屋' : ''].filter(Boolean).join('・');
            const pos = x.pos
              ? `<a class="sos-map" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${x.pos.lat},${x.pos.lon}">地図で開く</a>` +
                `<span>誤差 約${x.pos.acc}m・${ago(serverNow - x.pos.at)}の位置</span>`
              : `<span>位置なし（スマホが位置を取れていない）</span>`;
            return (
              `<div class="sos-host-item" data-st="${x.status}">` +
              `<div class="sos-host-who"><b>${esc(x.name)}</b><span>${esc(who)}・${ago(serverNow - x.at)}${x.online ? '' : '・いま切れている'}</span></div>` +
              `<div class="sos-host-pos">${pos}</div>` +
              `<div class="sos-host-act">` +
              (x.status === 'open'
                ? `<button type="button" class="go" data-op="sos-ack" data-id="${x.id}"${dis('sos-ack', x.id)}>見た・向かう</button>`
                : `<span class="sos-host-ack">向かっている（${ago(serverNow - (x.ackAt ?? x.at))}に見た）</span>`) +
              `<button type="button" data-op="sos-done" data-id="${x.id}"${dis('sos-done', x.id)}>${sure?.id === String(x.id) ? 'もう一度押すと終わる' : '終わった'}</button>` +
              `</div></div>`
            );
          })
          .join('');
    },
  };
}
