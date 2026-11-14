import { distanceM, type LatLon } from '../../shared/run';

/**
 * 全体の地図（見た目の層）。北が上の SFC の地図に、見えてよい人を置く。
 * - 枠は遊ぶ範囲いっぱい（範囲が無ければメビウスリングのまわり RING_BOX）。範囲のすぐ外（FRAME_EXPAND_M）の人までは広げて入れ、遠い人は地図のふちに寄せて点線の輪で描く
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
  /** 司令塔（役の色の四角い枠で囲む） */
  lead?: boolean;
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
  /** 描いている途中の範囲（主催者が地図を押して足していく点） */
  draft?: [number, number][] | null;
  /** 描いている途中のものがどれか（既定は遊ぶ範囲）。同じものの決まった形を薄くする */
  draftLayer?: 'area' | 'jail';
  /** 枠の決め方：area＝範囲があれば範囲に合わせる（既定）、campus＝いつもキャンパス全体から（範囲を描くとき） */
  frameBase?: 'area' | 'campus';
  /** 自分が範囲の外にいる */
  meOut?: boolean;
  /**
   * 範囲の縮小：今の縮んだ形（inner）・予告中の行き先（next）・縮む先の点（center）。
   * preview は主催者が描くときに見せる「最後はここまで縮む」形
   */
  zone?: { inner?: [number, number][] | null; next?: [number, number][] | null; center?: [number, number] | null; preview?: [number, number][] | null } | null;
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
/** 範囲が決まっていないときの枠：メビウスリングのまわり（遊ぶ所はたいていこの中） */
export const RING_BOX = { north: 35.39, west: 139.4253, south: 35.3864, east: 139.4292 } as const;
/** 枠の外にいる人のうち、枠をこれだけ（m）まで広げて入れる。もっと遠い人は枠を広げず、地図のふちに寄せて描く */
export const FRAME_EXPAND_M = 40;

/**
 * 地図の枠：もとの枠（範囲があれば範囲、無ければメビウスリングのまわり）と、そのすぐ外（FRAME_EXPAND_M 以内）にいる人を入れる。
 * 返り値は世界の座標の矩形。pad は余白の割合
 */
export function frameOf(points: LatLon[], base?: LatLon[] | null, pad = 0.04): { x0: number; y0: number; x1: number; y1: number } {
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
    const nw = toWorld({ lat: RING_BOX.north, lon: RING_BOX.west });
    const se = toWorld({ lat: RING_BOX.south, lon: RING_BOX.east });
    x0 = nw.x;
    y0 = nw.y;
    x1 = se.x;
    y1 = se.y;
  }
  // 世界の座標で FRAME_EXPAND_M がどれだけか
  const lat = (fromWorld(0, (y0 + y1) / 2).lat * Math.PI) / 180;
  const m = FRAME_EXPAND_M / (EARTH_CIRC_M * Math.cos(lat));
  const [bx0, by0, bx1, by1] = [x0 - m, y0 - m, x1 + m, y1 + m];
  for (const p of points) {
    const w = toWorld(p);
    if (w.x < bx0 || w.x > bx1 || w.y < by0 || w.y > by1) continue;
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x);
    y1 = Math.max(y1, w.y);
  }
  const padX = (x1 - x0) * pad;
  const padY = (y1 - y0) * pad;
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
    const all: LatLon[] = [...input.points.map((p) => p.pos), ...(input.me ? [input.me] : [])];
    const editing = input.frameBase === 'campus';
    // 範囲を描くときは、キャンパスと描いた点が全部入る枠。遊ぶときは範囲に合わせる
    // 描くとき：範囲があれば範囲（と牢屋・描いている点）に、無ければメビウスリングのまわりに合わせ、少し広めの余白。
    // 遊ぶとき：範囲いっぱいに。範囲のすぐ外の人までは入れ、遠い人は地図のふちに寄せる
    const f = editing
      ? frameOf([...jailPts, ...draftPts], areaPts.length >= 3 ? areaPts : null, 0.12)
      : frameOf([...all, ...jailPts], areaPts.length >= 3 ? areaPts : null);
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
      input.points.map((p) => [p.key, p.name, p.pos.lat, p.pos.lon, p.kind, Math.round(p.fresh * 5), p.lit, p.lead]),
      input.labelMax,
      input.area,
      input.draft,
      input.jail,
      input.draftLayer,
      input.frameBase,
      input.meOut,
      input.points.map((p) => p.out),
      input.zone,
    ]);
    if (!force && key === lastKey) return;
    lastKey = key;
    view = { S, cx, cy, w, h };
    const px = (p: LatLon) => {
      const q = toWorld(p);
      return { x: (q.x - cx) * S + w / 2, y: (q.y - cy) * S + h / 2 };
    };
    /** 人の印：地図の外にいる人は、ふちに寄せる（edge＝寄せた） */
    const EDGE = 12;
    const pxIn = (p: LatLon) => {
      const q = px(p);
      const x = Math.max(EDGE, Math.min(w - EDGE, q.x));
      const y = Math.max(EDGE, Math.min(h - EDGE, q.y));
      return { x, y, edge: x !== q.x || y !== q.y };
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
    // 範囲の縮小：縮んだ形の外をもう一段暗く（元の範囲の外は二重に暗い）、今の線は実線。予告中の行き先は蓄光の点線
    const zone = input.zone;
    const ringD = (pts: [number, number][]) =>
      pts.map(([lat, lon], i) => {
        const q = px({ lat, lon });
        return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      }).join('') + 'Z';
    if (zone?.inner && zone.inner.length >= 3) {
      const d = ringD(zone.inner);
      areaG.querySelector('.ov-area-line')?.classList.add('is-past');
      areaG.append(
        svg('path', { d: `M-4,-4H${w + 4}V${h + 4}H-4Z${d}`, class: 'ov-zone-shade', 'fill-rule': 'evenodd' }),
        svg('path', { d, class: 'ov-zone-line' }),
      );
    }
    if (zone?.next && zone.next.length >= 3) areaG.append(svg('path', { d: ringD(zone.next), class: 'ov-zone-next' }));
    if (zone?.preview && zone.preview.length >= 3) areaG.append(svg('path', { d: ringD(zone.preview), class: 'ov-zone-next is-preview' }));
    if (zone?.center && (zone.next || zone.preview)) {
      const q = px({ lat: zone.center[0], lon: zone.center[1] });
      areaG.append(svg('path', { d: `M${(q.x - 7).toFixed(1)},${q.y.toFixed(1)}h14M${q.x.toFixed(1)},${(q.y - 7).toFixed(1)}v14`, class: 'ov-zone-center' }));
    }
    // 牢屋：薄い面と実線（字は置かない。人の印や名前の邪魔になるため）
    if (jailPts.length >= 3) {
      const ring = jailPts.map((p) => px(p));
      const d = ring.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('') + 'Z';
      areaG.append(svg('path', { d, class: `ov-jail${draftPts.length && draftJail ? ' is-old' : ''}` }));
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
    const pts = input.points.map((p) => ({ p, q: pxIn(p.pos) }));
    pts.sort((a, b) => Number(!!a.p.lead) - Number(!!b.p.lead) || Number(a.p.lit) - Number(b.p.lit) || a.p.fresh - b.p.fresh);
    if (input.me) {
      const q = px(input.me);
      const r = Math.max(6, input.me.acc / mPerPx(input.me.lat));
      if (r < Math.max(w, h)) accG.append(svg('circle', { cx: q.x.toFixed(1), cy: q.y.toFixed(1), r: r.toFixed(1), class: 'ov-acc-me' }));
    }
    for (const { p, q } of pts) {
      const g = svg('g', { class: `ov-pt is-${p.kind}${p.lit ? ' is-lit' : ''}${q.edge ? ' is-edge' : ''}`, transform: `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})` });
      g.setAttribute('opacity', (0.3 + 0.7 * Math.max(0, Math.min(1, p.fresh))).toFixed(2));
      if (p.lit) {
        g.append(svg('circle', { r: 13, class: 'ov-halo' }), svg('circle', { r: 8, class: 'ov-ping' }));
      }
      if (p.out) g.append(svg('circle', { r: 12, class: 'ov-out' }));
      if (p.lead) g.append(svg('rect', { x: -11, y: -11, width: 22, height: 22, transform: 'rotate(45)', class: 'ov-lead' }));
      if (p.kind === 'oni') {
        // 角2本（ピクトの追跡者と同じ印）
        g.append(svg('path', { d: 'M-5.5,-4 L-7.5,-12 L-1.5,-6 Z M5.5,-4 L7.5,-12 L1.5,-6 Z', class: 'ov-horn' }));
      }
      if (p.kind !== 'unknown') g.append(svg('circle', { r: 6.5, class: 'ov-dot' }));
      else g.append(svg('circle', { r: 5, class: 'ov-dot' }));
      dotsG.append(g);
    }
    if (input.me) {
      const q = pxIn(input.me);
      const g = svg('g', { class: `ov-me is-${input.meKind}${input.meLit ? ' is-lit' : ''}${q.edge ? ' is-edge' : ''}`, transform: `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)})` });
      if (input.meLit) g.append(svg('circle', { r: 13, class: 'ov-halo' }));
      if (input.meOut) g.append(svg('circle', { r: 14, class: 'ov-out' }));
      g.append(svg('circle', { r: 9, class: 'ov-me-ring' }), svg('circle', { r: 4, class: 'ov-me-dot' }));
      dotsG.append(g);
    }
    let labelled = 0;
    if (input.me) {
      const q = pxIn(input.me);
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
