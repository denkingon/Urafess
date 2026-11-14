import { CAMPUS_BOX, CAMPUS_CENTER, MATES_FAR_M } from '../../shared/rules';
import { distanceM, type LatLon } from '../../shared/run';

/**
 * 全体の地図（見た目の層）。北が上の SFC の地図に、見えてよい人を置く。
 * - 最初の枠は SFC のキャンパス（CAMPUS_BOX）。人がその外にいれば、そこまで広げる（キャンパスから MATES_FAR_M より遠い人は数えない）
 * - 下地は OpenStreetMap の地図を暗くしたもの（画像はブラウザがそのまま読む。サーバーのリクエストは使わない）。読めなくても点は出る
 * - 鬼は朱の点に2本の角、逃走者は月白の点、役の分からない人（走って光った相手）は白い光だけ。役は色と形の両方で見分ける
 * - 光っている人は光の輪。自分は蓄光の輪と、位置の誤差の円
 * - 古い位置ほど薄く。名前は重ならない分だけ出す（16px）
 * - 遊ぶ範囲：範囲の外を暗く沈め、線を引く。範囲があれば枠は範囲に合わせる。範囲の外にいる人は朱の輪で囲む
 * - 描いている途中の範囲（主催者）：蓄光の点と線。onTap を渡すと、押した場所の緯度・経度が返る
 */

export type OvKind = 'oni' | 'runner' | 'unknown';

export interface OvPoint {
  key: string;
  name: string;
  pos: LatLon;
  /** 位置の誤差の半径（m） */
  acc: number;
  kind: OvKind;
  /** 0〜1：1＝今届いた、0＝もうすぐ消える */
  fresh: number;
  /** いま走って光っている */
  lit: boolean;
  /** 遊ぶ範囲の外にいる */
  out?: boolean;
}

export interface OvInput {
  me: (LatLon & { acc: number }) | null;
  meKind: OvKind;
  meLit: boolean;
  points: OvPoint[];
  /** 名前を出す最大の人数 */
  labelMax: number;
  /** 遊ぶ範囲（決まっている形）。無ければ null */
  area?: [number, number][] | null;
  /** 牢屋の場所（決まっている形）。無ければ null。月白の薄い面と「牢屋」の字 */
  jail?: [number, number][] | null;
  /** ミッションの範囲（決まっている形）。無ければ null。蓄光の面と「ミッション」の字。鬼にも逃走者にも同じものを出す */
  zone?: [number, number][] | null;
  /** 描いている途中の範囲（主催者が地図を押して足していく点） */
  draft?: [number, number][] | null;
  /** 描いている途中のものがどれか（既定は遊ぶ範囲）。同じものの決まった形を薄くする */
  draftLayer?: 'area' | 'jail' | 'zone';
  /** 枠の決め方：area＝範囲があれば範囲に合わせる（既定）、campus＝いつもキャンパス全体から（範囲を描くとき） */
  frameBase?: 'area' | 'campus';
  /** 自分が範囲の外にいる */
  meOut?: boolean;
}

export interface OverviewOptions {
  /** 地図を押したとき（範囲を描く）。押した場所の緯度・経度 */
  onTap?: (p: LatLon) => void;
}

export interface Overview {
  el: HTMLElement;
  update(input: OvInput): void;
}

const NS = 'http://www.w3.org/2000/svg';
const TILE = 256;
const TILE_URL = (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const Z_MIN = 13;
const Z_MAX = 19;
const EARTH_CIRC_M = 40_075_016.686;
const LABEL_PX = 16;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** 緯度・経度 → 世界の座標（0〜1。x 右、y 下。ウェブの地図と同じ形） */
export function toWorld(p: LatLon): { x: number; y: number } {
  const s = Math.sin((p.lat * Math.PI) / 180);
  return { x: (p.lon + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/** 世界の座標 → 緯度・経度 */
export function fromWorld(x: number, y: number): LatLon {
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI, lon: x * 360 - 180 };
}

/**
 * 地図の枠：もとの枠（範囲があれば範囲、無ければキャンパス）と、近くにいる人を全部入れる。返り値は世界の座標の矩形。
 * base に範囲の頂点を渡すと、範囲に合わせる
 */
export function frameOf(points: LatLon[], base?: LatLon[] | null): { x0: number; y0: number; x1: number; y1: number } {
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;
  if (base && base.length >= 3) {
    const ws = base.map(toWorld);
    x0 = Math.min(...ws.map((w) => w.x));
    x1 = Math.max(...ws.map((w) => w.x));
    y0 = Math.min(...ws.map((w) => w.y));
    y1 = Math.max(...ws.map((w) => w.y));
  } else {
    const nw = toWorld({ lat: CAMPUS_BOX.north, lon: CAMPUS_BOX.west });
    const se = toWorld({ lat: CAMPUS_BOX.south, lon: CAMPUS_BOX.east });
    x0 = nw.x;
    y0 = nw.y;
    x1 = se.x;
    y1 = se.y;
  }
  for (const p of points) {
    if (distanceM(CAMPUS_CENTER, p) > MATES_FAR_M) continue;
    const w = toWorld(p);
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x);
    y1 = Math.max(y1, w.y);
  }
  const padX = (x1 - x0) * 0.06;
  const padY = (y1 - y0) * 0.06;
  return { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY };
}

export function createOverview(opts: OverviewOptions = {}): Overview {
  const el = document.createElement('div');
  el.className = 'ov';
  const tiles = document.createElement('div');
  tiles.className = 'ov-tiles';
  const over = svg('svg', { class: 'ov-svg', role: 'img' });
  const areaG = svg('g', { class: 'ov-area' });
  const accG = svg('g', { class: 'ov-acc' });
  const dotsG = svg('g', { class: 'ov-dots' });
  const labelsG = svg('g', { class: 'ov-labels' });
  over.append(areaG, accG, dotsG, labelsG);
  const credit = document.createElement('a');
  credit.className = 'ov-credit';
  credit.href = 'https://www.openstreetmap.org/copyright';
  credit.target = '_blank';
  credit.rel = 'noopener';
  credit.textContent = '© OpenStreetMap';
  el.append(tiles, over, credit);

  const imgs = new Map<string, HTMLImageElement>();
  let size = { w: 0, h: 0 };
  /** いまの描き方（押した場所を緯度・経度に戻すため） */
  let view: { S: number; cx: number; cy: number; w: number; h: number } | null = null;
  if (opts.onTap) {
    el.classList.add('is-tappable');
    el.addEventListener('click', (e) => {
      if (!view) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left - view.w / 2) / view.S + view.cx;
      const y = (e.clientY - r.top - view.h / 2) / view.S + view.cy;
      opts.onTap!(fromWorld(x, y));
    });
  }
  let lastInput: OvInput | null = null;
  let lastKey = '';
  const measure = () => {
    const r = el.getBoundingClientRect();
    size = { w: Math.round(r.width), h: Math.round(r.height) };
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      measure();
      if (lastInput) draw(lastInput, true);
    }).observe(el);
  }

  const draw = (input: OvInput, force = false) => {
    lastInput = input;
    if (!size.w || !size.h) measure();
    const { w, h } = size;
    if (w < 40 || h < 40) return;
    const areaPts = (input.area ?? []).map(([lat, lon]) => ({ lat, lon }));
    const draftPts = (input.draft ?? []).map(([lat, lon]) => ({ lat, lon }));
    const jailPts = (input.jail ?? []).map(([lat, lon]) => ({ lat, lon }));
    const draftJail = input.draftLayer === 'jail';
    const zonePts = (input.zone ?? []).map(([lat, lon]) => ({ lat, lon }));
    const all: LatLon[] = [...input.points.map((p) => p.pos), ...(input.me ? [input.me] : [])];
    const editing = input.frameBase === 'campus';
    // 範囲を描くときは、キャンパスと描いた点が全部入る枠。遊ぶときは範囲に合わせる
    const f = editing ? frameOf([...areaPts, ...jailPts, ...draftPts]) : frameOf([...all, ...jailPts, ...zonePts], areaPts.length >= 3 ? areaPts : null);
    const S = Math.min(w / (f.x1 - f.x0), h / (f.y1 - f.y0)); // 画面の px ／ 世界の 1
    const cx = (f.x0 + f.x1) / 2;
    const cy = (f.y0 + f.y1) / 2;
    const key = JSON.stringify([
      w,
      h,
      Math.round(S),
      cx.toFixed(7),
      cy.toFixed(7),
      input.me && [input.me.lat, input.me.lon, Math.round(input.me.acc)],
      input.meKind,
      input.meLit,
      input.points.map((p) => [p.key, p.name, p.pos.lat, p.pos.lon, p.kind, Math.round(p.fresh * 5), p.lit]),
      input.labelMax,
      input.area,
      input.draft,
      input.jail,
      input.zone,
      input.draftLayer,
      input.frameBase,
      input.meOut,
      input.points.map((p) => p.out),
    ]);
    if (!force && key === lastKey) return;
    lastKey = key;
    view = { S, cx, cy, w, h };
    const px = (p: LatLon) => {
      const q = toWorld(p);
      return { x: (q.x - cx) * S + w / 2, y: (q.y - cy) * S + h / 2 };
    };

    // 下地のタイル（画面の大きさに合うズームを選び、少し引き伸ばして敷く）
    const z = Math.max(Z_MIN, Math.min(Z_MAX, Math.ceil(Math.log2(S / TILE))));
    const n = 2 ** z;
    const tilePx = S / n;
    const tx0 = Math.floor((cx - w / 2 / S) * n);
    const tx1 = Math.floor((cx + w / 2 / S) * n);
    const ty0 = Math.floor((cy - h / 2 / S) * n);
    const ty1 = Math.floor((cy + h / 2 / S) * n);
    const keep = new Set<string>();
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const k = `${z}/${tx}/${ty}`;
        keep.add(k);
        let img = imgs.get(k);
        if (!img) {
          img = document.createElement('img');
          img.alt = '';
          img.decoding = 'async';
          img.draggable = false;
          img.referrerPolicy = 'strict-origin-when-cross-origin';
          img.addEventListener('error', () => img!.classList.add('is-missing'));
          img.src = TILE_URL(z, ((tx % n) + n) % n, ty);
          imgs.set(k, img);
          tiles.append(img);
        }
        const left = (tx / n - cx) * S + w / 2;
        const top = (ty / n - cy) * S + h / 2;
        // 1px 重ねて継ぎ目を消す
        img.style.cssText = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${(tilePx + 1).toFixed(1)}px;height:${(tilePx + 1).toFixed(1)}px`;
      }
    }
    for (const [k, img] of imgs) {
      if (!keep.has(k)) {
        img.remove();
        imgs.delete(k);
      }
    }

    over.setAttribute('viewBox', `0 0 ${w} ${h}`);
    over.setAttribute('width', String(w));
    over.setAttribute('height', String(h));
    const mPerPx = (lat: number) => (EARTH_CIRC_M * Math.cos((lat * Math.PI) / 180)) / S;

    // 遊ぶ範囲：外を暗く（画面全体の四角から範囲をくりぬく）、線を引く
    areaG.replaceChildren();
    if (areaPts.length >= 3) {
      const ring = areaPts.map((p) => px(p));
      const d = ring.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('') + 'Z';
      areaG.append(
        svg('path', { d: `M-4,-4H${w + 4}V${h + 4}H-4Z${d}`, class: 'ov-area-shade', 'fill-rule': 'evenodd' }),
        svg('path', { d, class: `ov-area-line${draftPts.length && !draftJail ? ' is-old' : ''}` }),
      );
    }
    // 牢屋：薄い面と実線、真ん中に「牢屋 JAIL」
    if (jailPts.length >= 3) {
      const ring = jailPts.map((p) => px(p));
      const d = ring.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('') + 'Z';
      const c = ring.reduce((a, q) => ({ x: a.x + q.x / ring.length, y: a.y + q.y / ring.length }), { x: 0, y: 0 });
      const t = svg('text', { x: c.x.toFixed(1), y: c.y.toFixed(1), class: 'ov-jail-name', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = '牢屋 JAIL';
      areaG.append(svg('path', { d, class: `ov-jail${draftPts.length && draftJail ? ' is-old' : ''}` }), t);
    }
    // ミッションの範囲：蓄光の面と点線、真ん中に「ミッション」
    if (zonePts.length >= 3) {
      const ring = zonePts.map((p) => px(p));
      const d = ring.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('') + 'Z';
      // 字は枠の上（中にいる人の点と名前に重ねない）。上に置けなければ枠の下
      const cx0 = ring.reduce((a, q) => a + q.x / ring.length, 0);
      const top = Math.min(...ring.map((q) => q.y));
      const bottom = Math.max(...ring.map((q) => q.y));
      const ty = top - 11 >= 10 ? top - 11 : Math.min(h - 10, bottom + 12);
      const t = svg('text', { x: Math.max(44, Math.min(w - 44, cx0)).toFixed(1), y: ty.toFixed(1), class: 'ov-zone-name', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = 'ミッション';
      areaG.append(svg('path', { d, class: 'ov-zone' }), t);
    }
    if (draftPts.length) {
      const ring = draftPts.map((p) => px(p));
      const d = ring.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('') + (ring.length >= 3 ? 'Z' : '');
      areaG.append(svg('path', { d, class: `ov-draft-line${draftJail ? ' is-jail' : ''}` }));
      ring.forEach((q, i) => areaG.append(svg('circle', { cx: q.x.toFixed(1), cy: q.y.toFixed(1), r: i === ring.length - 1 ? 7 : 5, class: 'ov-draft-pt' })));
    }

    accG.replaceChildren();
    dotsG.replaceChildren();
    labelsG.replaceChildren();
    const labelBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const placeLabel = (x: number, y: number, text: string, cls: string) => {
      const width = [...text].length * LABEL_PX * 0.95 + 4;
      for (const right of [true, false]) {
        const bx0 = right ? x + 10 : x - 10 - width;
        const box = { x0: bx0, y0: y - LABEL_PX * 0.6, x1: bx0 + width, y1: y + LABEL_PX * 0.6 };
        if (box.x0 < 2 || box.x1 > w - 2 || box.y0 < 2 || box.y1 > h - 2) continue;
        if (labelBoxes.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        labelBoxes.push(box);
        const t = svg('text', { x: right ? x + 10 : x - 10, y: y + 1, class: `ov-name ${cls}`, 'text-anchor': right ? 'start' : 'end', 'dominant-baseline': 'central' });
        t.textContent = text;
        labelsG.append(t);
        return;
      }
    };

    // 光っている人・新しい人ほど上に重ねる。名前は光っている人 → 新しい人の順に出す
    const pts = input.points.map((p) => ({ p, q: px(p.pos) }));
    pts.sort((a, b) => Number(a.p.lit) - Number(b.p.lit) || a.p.fresh - b.p.fresh);
    if (input.me) {
      const q = px(input.me);
      const r = Math.max(6, input.me.acc / mPerPx(input.me.lat));
      if (r < Math.max(w, h)) accG.append(svg('circle', { cx: q.x.toFixed(1), cy: q.y.toFixed(1), r: r.toFixed(1), class: 'ov-acc-me' }));
    }
    for (const { p, q } of pts) {
      const g = svg('g', { class: `ov-pt is-${p.kind}${p.lit ? ' is-lit' : ''}`, transform: `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})` });
      g.setAttribute('opacity', (0.3 + 0.7 * Math.max(0, Math.min(1, p.fresh))).toFixed(2));
      if (p.lit) {
        g.append(svg('circle', { r: 13, class: 'ov-halo' }), svg('circle', { r: 8, class: 'ov-ping' }));
      }
      if (p.out) g.append(svg('circle', { r: 12, class: 'ov-out' }));
      if (p.kind === 'oni') {
        // 角2本（ピクトの追跡者と同じ印）
        g.append(svg('path', { d: 'M-5.5,-4 L-7.5,-12 L-1.5,-6 Z M5.5,-4 L7.5,-12 L1.5,-6 Z', class: 'ov-horn' }));
      }
      if (p.kind !== 'unknown') g.append(svg('circle', { r: 6.5, class: 'ov-dot' }));
      else g.append(svg('circle', { r: 5, class: 'ov-dot' }));
      dotsG.append(g);
    }
    if (input.me) {
      const q = px(input.me);
      const g = svg('g', { class: `ov-me is-${input.meKind}${input.meLit ? ' is-lit' : ''}`, transform: `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})` });
      if (input.meLit) g.append(svg('circle', { r: 13, class: 'ov-halo' }));
      if (input.meOut) g.append(svg('circle', { r: 14, class: 'ov-out' }));
      g.append(svg('circle', { r: 9, class: 'ov-me-ring' }), svg('circle', { r: 4, class: 'ov-me-dot' }));
      dotsG.append(g);
    }
    let labelled = 0;
    if (input.me) {
      const q = px(input.me);
      placeLabel(q.x, q.y, 'じぶん', 'is-me');
    }
    for (const { p, q } of [...pts].reverse()) {
      if (labelled >= input.labelMax) break;
      const before = labelsG.childElementCount;
      placeLabel(q.x, q.y, p.name, `is-${p.kind}`);
      if (labelsG.childElementCount > before) labelled++;
    }
    const counts = { oni: 0, runner: 0, unknown: 0 };
    for (const p of input.points) counts[p.kind]++;
    over.setAttribute(
      'aria-label',
      `全体の地図：${counts.oni ? `鬼 ${counts.oni}人 ` : ''}${counts.runner ? `逃走者 ${counts.runner}人 ` : ''}${counts.unknown ? `光った人 ${counts.unknown}人` : ''}`.trim() || '全体の地図：まだ誰もいない',
    );
  };

  return { el, update: (input) => draw(input) };
}
