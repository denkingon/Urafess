import SFC from '../sfc-map.json';
import './debug.css';

/**
 * デバッグ台（/debug?g=部屋）：PC の1画面に、参加者のスマホを何台も並べて、自分の手で見たり押したりする場所。
 *
 * - スマホ1台＝参加者1人（/?g=部屋&dev=番号 を枠に入れる。覚えておく値は台ごとに分かれる）。マウスでそのまま押せる
 * - 本部も1台ぶんの枠に出せる（/host?g=部屋&hq=1。合言葉は最初に1回打つ）
 * - 右の地図（SFC）：台ごとの点をドラッグすると、その台の位置が動く（本物の GPS の代わり）
 * - 台ごとに「走る」：走っているときの揺れを流す（走ると光るを試せる）
 * - 本番の部屋（main）では開かない
 * 音での捕獲は、1台の PC の中では本物どおりにならない（実機で試す）。
 * 道具なので無彩色。色が付くのは選んでいる台と走っている台だけ。
 */

const SAVE_KEY = 'urafess:debug-desk';
const MAX = 12;
const SCALES = [0.5, 0.65, 0.8, 1];
const PHONE = { w: 390, h: 844 };

type Shape = number[];
const H = SFC.height;
const W = SFC.width;
const BOX = SFC.box;
/** 地図の座標（m、南西の角から。x＝東、y＝北）⇔ 緯度・経度 */
const toLatLon = (x: number, y: number) => ({ lat: BOX.s + (y / H) * (BOX.n - BOX.s), lon: BOX.w + (x / W) * (BOX.e - BOX.w) });
const toXY = (lat: number, lon: number) => ({ x: ((lon - BOX.w) / (BOX.e - BOX.w)) * W, y: ((lat - BOX.s) / (BOX.n - BOX.s)) * H });

interface Saved {
  n: number;
  scale: number;
  host: boolean;
  pos: Record<string, { lat: number; lon: number }>;
}

function load(): Saved {
  const d: Saved = { n: 4, scale: 0.65, host: true, pos: {} };
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as Partial<Saved>;
    if (Number.isInteger(s.n) && s.n! >= 1 && s.n! <= MAX) d.n = s.n!;
    if (SCALES.includes(s.scale!)) d.scale = s.scale!;
    if (typeof s.host === 'boolean') d.host = s.host;
    if (s.pos && typeof s.pos === 'object') d.pos = s.pos;
  } catch {
    /* 初めて */
  }
  return d;
}

/** 台の最初の場所（dev.ts と同じ置き方：まんなかから少しずつ渦巻きに） */
function firstPos(slot: number) {
  const ang = (slot * 137.5 * Math.PI) / 180;
  return { lat: 35.388 + Math.sin(ang) * 0.0004 * Math.sqrt(slot), lon: 139.4276 + Math.cos(ang) * 0.0005 * Math.sqrt(slot) };
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(text: string, act: string, extra: Record<string, string> = {}): HTMLButtonElement {
  const b = mk('button', '', text);
  b.type = 'button';
  b.dataset.act = act;
  for (const [k, v] of Object.entries(extra)) b.dataset[k] = v;
  return b;
}

export function startDebugDesk(root: HTMLElement, gameId: string): void {
  document.title = `デバッグ台 · ${gameId}`;
  document.body.classList.add('dd-body');
  if (gameId === 'main') {
    const box = mk('div', 'dd dd-stop');
    box.append(mk('h1', '', 'デバッグ台は本番の部屋（main）では開かない'), mk('p', '', '試し用の部屋で開く。参加者も本部も同じ部屋名を使う。'));
    const a = mk('a', 'dd-go', '試し用の部屋「debug」で開く');
    a.href = '/debug?g=debug';
    box.append(a);
    root.replaceChildren(box);
    return;
  }

  const st = load();
  const save = () => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(st));
    } catch {
      /* 保存できなくても動く */
    }
  };
  const posOf = (slot: number) => st.pos[slot] ?? firstPos(slot);
  const running = new Set<number>();
  let selected = 1;

  const el = mk('div', 'dd');
  const bar = mk('header', 'dd-bar');
  const title = mk('h1', '', 'デバッグ台');
  const roomL = mk('span', 'dd-room', `部屋 ${gameId}`);
  const count = mk('span', 'dd-count');
  bar.append(title, roomL, btn('＋ スマホ', 'more'), btn('− スマホ', 'less'), count, btn('全員入室', 'join'), btn('全員の許可を押す', 'allow'), btn('全部開き直す', 'reload-all'));
  const scaleBox = mk('span', 'dd-seg');
  scaleBox.append(mk('span', 'dd-seg-l', '大きさ'));
  for (const s of SCALES) scaleBox.append(btn(`${Math.round(s * 100)}%`, 'scale', { v: String(s) }));
  const hostBtn = btn('本部', 'host');
  bar.append(scaleBox, hostBtn);

  const main = mk('div', 'dd-main');
  const phones = mk('div', 'dd-phones');
  const side = mk('aside', 'dd-side');
  const mapBox = mk('div', 'dd-map');
  const hint = mk('p', 'dd-hint', '点をドラッグすると、そのスマホの位置が動く。音での捕獲はこの台では試せない（実機で）。');
  side.append(mk('h2', '', '位置'), mapBox, hint);
  main.append(phones, side);
  el.append(bar, main);
  root.replaceChildren(el);

  // ---------- 地図 ----------
  const pts = (a: Shape) => {
    let s = '';
    for (let i = 0; i < a.length; i += 2) s += `${i ? ' ' : ''}${a[i]},${Math.round((H - a[i + 1]) * 10) / 10}`;
    return s;
  };
  const d = SFC as unknown as Record<string, Shape[]>;
  const layer = (cls: string, list: Shape[] | undefined, tag: 'polygon' | 'polyline') =>
    list ? `<g class="${cls}">${list.map((p) => `<${tag} points="${pts(p)}"/>`).join('')}</g>` : '';
  mapBox.innerHTML =
    `<svg class="dd-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
    layer('m-green', d.green, 'polygon') + layer('m-water', d.water, 'polygon') + layer('m-road', d.roadBig, 'polyline') +
    layer('m-road', d.road, 'polyline') + layer('m-path', d.path, 'polyline') + layer('m-bld', d.bld, 'polygon') +
    `<g class="m-dots"></g></svg>`;
  const svg = mapBox.querySelector('svg') as SVGSVGElement;
  const dots = svg.querySelector('.m-dots') as SVGGElement;
  const NS = 'http://www.w3.org/2000/svg';

  const drawDots = () => {
    dots.replaceChildren();
    for (let slot = 1; slot <= st.n; slot++) {
      const { x, y } = toXY(posOf(slot).lat, posOf(slot).lon);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `m-dot${slot === selected ? ' is-sel' : ''}${running.has(slot) ? ' is-run' : ''}`);
      g.setAttribute('transform', `translate(${x.toFixed(1)} ${(H - y).toFixed(1)})`);
      g.dataset.slot = String(slot);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '16');
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dy', '6');
      t.textContent = String(slot);
      g.append(c, t);
      dots.append(g);
    }
  };
  const svgPoint = (e: PointerEvent) => {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const m = svg.getScreenCTM();
    const q = m ? p.matrixTransform(m.inverse()) : p;
    return { x: Math.min(W, Math.max(0, q.x)), y: Math.min(H, Math.max(0, H - q.y)) };
  };
  let drag: number | null = null;
  let lastSend = 0;
  svg.addEventListener('pointerdown', (e) => {
    const g = (e.target as Element).closest('.m-dot') as SVGGElement | null;
    const slot = g ? Number(g.dataset.slot) : selected;
    selected = slot;
    drag = slot;
    svg.setPointerCapture(e.pointerId);
    moveTo(slot, svgPoint(e), true);
    renderFrames();
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const now = performance.now();
    moveTo(drag, svgPoint(e), now - lastSend > 120);
  });
  const up = () => {
    if (drag !== null) save();
    drag = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);

  function moveTo(slot: number, p: { x: number; y: number }, sendNow: boolean) {
    st.pos[slot] = toLatLon(p.x, p.y);
    drawDots();
    if (sendNow) {
      lastSend = performance.now();
      sendPos(slot);
    }
  }
  function sendPos(slot: number) {
    const f = frames.get(slot);
    f?.contentWindow?.postMessage({ t: 'dev-pos', ...posOf(slot) }, location.origin);
  }

  // ---------- 枠（スマホ・本部） ----------
  const frames = new Map<number, HTMLIFrameElement>();
  let hostFrame: HTMLIFrameElement | null = null;

  const card = (label: string, src: string, slot: number | null) => {
    const c = mk('section', 'dd-card');
    if (slot !== null) c.dataset.slot = String(slot);
    const h = mk('header', 'dd-card-h');
    h.append(mk('b', '', label));
    if (slot !== null) {
      const run = btn(running.has(slot) ? '走っている' : '走る', 'run', { slot: String(slot) });
      run.setAttribute('aria-pressed', String(running.has(slot)));
      h.append(run, btn('地図で選ぶ', 'pick', { slot: String(slot) }));
    }
    h.append(btn('開き直す', 'reload', { slot: slot === null ? 'host' : String(slot) }));
    const wrap = mk('div', 'dd-screen');
    wrap.style.width = `${PHONE.w * st.scale}px`;
    wrap.style.height = `${PHONE.h * st.scale}px`;
    const f = mk('iframe');
    f.src = src;
    f.title = label;
    f.allow = 'microphone; geolocation; autoplay';
    f.style.width = `${PHONE.w}px`;
    f.style.height = `${PHONE.h}px`;
    f.style.transform = `scale(${st.scale})`;
    wrap.append(f);
    c.append(h, wrap);
    return { c, f };
  };

  /** 枠を作り直さずに、見出しと大きさだけ合わせる（枠を作り直すと参加者がつなぎ直してしまう） */
  function renderFrames() {
    count.textContent = `${st.n}台`;
    hostBtn.setAttribute('aria-pressed', String(st.host));
    for (const b of scaleBox.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === st.scale));
    // 本部
    if (st.host && !hostFrame) {
      const { c, f } = card('本部', `/host?g=${encodeURIComponent(gameId)}&hq=1`, null);
      c.classList.add('dd-host');
      phones.prepend(c);
      hostFrame = f;
    } else if (!st.host && hostFrame) {
      hostFrame.closest('.dd-card')?.remove();
      hostFrame = null;
    }
    // スマホ：足りない分を足す・多い分を外す
    for (let slot = 1; slot <= st.n; slot++) {
      if (frames.has(slot)) continue;
      const { lat, lon } = posOf(slot);
      const { c, f } = card(`スマホ${slot}`, `/?g=${encodeURIComponent(gameId)}&dev=${slot}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, slot);
      phones.append(c);
      frames.set(slot, f);
    }
    for (const [slot, f] of frames) {
      if (slot <= st.n) continue;
      f.closest('.dd-card')?.remove();
      frames.delete(slot);
      running.delete(slot);
    }
    // 大きさ・選んでいる台・走っている台
    for (const c of phones.querySelectorAll<HTMLElement>('.dd-card')) {
      const wrap = c.querySelector('.dd-screen') as HTMLElement;
      const f = c.querySelector('iframe') as HTMLIFrameElement;
      wrap.style.width = `${PHONE.w * st.scale}px`;
      wrap.style.height = `${PHONE.h * st.scale}px`;
      f.style.transform = `scale(${st.scale})`;
      const slot = Number(c.dataset.slot);
      c.classList.toggle('is-sel', slot === selected);
      c.classList.toggle('is-run', running.has(slot));
      const run = c.querySelector<HTMLButtonElement>('[data-act="run"]');
      if (run) {
        run.textContent = running.has(slot) ? '走っている' : '走る';
        run.setAttribute('aria-pressed', String(running.has(slot)));
      }
    }
    drawDots();
  }

  // スマホの枠が読み終わったら、いまの位置と走りを送る
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const m = e.data as { t?: string; slot?: number } | null;
    if (m?.t !== 'dev-hello' || !Number.isInteger(m.slot)) return;
    sendPos(m.slot!);
    frames.get(m.slot!)?.contentWindow?.postMessage({ t: 'dev-run', on: running.has(m.slot!) }, location.origin);
  });

  /** 入室の画面が出ていれば、名前を入れて入る（名簿の「前の◯◯？」が出ていればそれを押す） */
  const joinOne = (slot: number) => {
    const doc = frames.get(slot)?.contentDocument;
    if (!doc) return;
    const nick = doc.querySelector<HTMLInputElement>('#nick');
    if (nick && nick.offsetParent !== null) {
      if (!nick.value) {
        nick.value = `デバ${slot}`;
        nick.dispatchEvent(new Event('input', { bubbles: true }));
      }
      doc.querySelector<HTMLButtonElement>('form button[type=submit]')?.click();
    }
  };
  /** 許可のお願いが出ていれば押す（にせものの位置・動きが流れ始める） */
  const allowOne = (slot: number) => {
    const ask = frames.get(slot)?.contentDocument?.querySelector<HTMLButtonElement>('.perm-ask:not([hidden]):not(:disabled)');
    ask?.click();
  };

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b) return;
    const slot = Number(b.dataset.slot);
    switch (b.dataset.act) {
      case 'more':
        st.n = Math.min(MAX, st.n + 1);
        break;
      case 'less':
        st.n = Math.max(1, st.n - 1);
        if (selected > st.n) selected = st.n;
        break;
      case 'join':
        for (let s = 1; s <= st.n; s++) joinOne(s);
        return;
      case 'allow':
        for (let s = 1; s <= st.n; s++) allowOne(s);
        return;
      case 'reload-all':
        for (const f of frames.values()) f.contentWindow?.location.reload();
        hostFrame?.contentWindow?.location.reload();
        return;
      case 'scale':
        st.scale = Number(b.dataset.v);
        break;
      case 'host':
        st.host = !st.host;
        break;
      case 'run':
        if (running.has(slot)) running.delete(slot);
        else running.add(slot);
        frames.get(slot)?.contentWindow?.postMessage({ t: 'dev-run', on: running.has(slot) }, location.origin);
        selected = slot;
        renderFrames();
        return;
      case 'pick':
        selected = slot;
        renderFrames();
        return;
      case 'reload':
        if (b.dataset.slot === 'host') hostFrame?.contentWindow?.location.reload();
        else frames.get(slot)?.contentWindow?.location.reload();
        return;
      default:
        return;
    }
    save();
    renderFrames();
  });

  // 走っている台は、地図の上で少しずつ前へ（3m/秒。ふちで向きを変える）。止めたいときは「走っている」を押す
  const heading = new Map<number, number>();
  setInterval(() => {
    if (!running.size || drag !== null) return;
    for (const slot of running) {
      const p = posOf(slot);
      const { x, y } = toXY(p.lat, p.lon);
      let a = heading.get(slot) ?? (slot * 47 * Math.PI) / 180;
      let nx = x + Math.cos(a) * 3;
      let ny = y + Math.sin(a) * 3;
      // 地図のふちに来たら向きを変える
      if (nx < 40 || nx > W - 40 || ny < 40 || ny > H - 40) {
        a += (2 * Math.PI) / 3;
        nx = Math.min(W - 40, Math.max(40, nx));
        ny = Math.min(H - 40, Math.max(40, ny));
      }
      heading.set(slot, a);
      st.pos[slot] = toLatLon(nx, ny);
      sendPos(slot);
    }
    drawDots();
  }, 1000);

  renderFrames();
}
