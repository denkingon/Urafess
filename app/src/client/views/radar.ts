import { RADAR_MAX_M, RADAR_RINGS_M, offsetM, radarRadius, type LatLon } from '../../shared/run';

/**
 * 走ると光る：光の地図（見た目の層）。自分が真ん中、輪は 50m・100m・200m、縁が 400m（それより遠い人は縁に置く）。
 * 近くほど広く描く（近づいてくる人ほど細かく見える）。方角が取れれば自分の向いている方が上、取れなければ北が上。
 * 光っている人は白い点、少し前までの道すじを尾にする。
 */

export interface RadarLight {
  num: number;
  name: string;
  pos: LatLon | null;
  /** 0〜1：1＝今届いた、0＝もうすぐ消える */
  fresh: number;
  /** 少し前までの位置（古い順） */
  trail: LatLon[];
  /** 光ったばかり（輪が広がる） */
  isNew: boolean;
}

export interface RadarInput {
  me: LatLon | null;
  heading: number | null;
  lights: RadarLight[];
  /** 自分が光っている */
  meLit: boolean;
}

export interface Radar {
  el: SVGSVGElement;
  update(input: RadarInput): void;
}

const NS = 'http://www.w3.org/2000/svg';
const R = 100;
/** 名前を出すのは近い順にこの人数まで（重なって読めなくなるので） */
const LABEL_MAX = 3;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** 地図の上の点（x 右、y 下）。heading が取れていれば、向いている方を上にする */
export function project(me: LatLon, p: LatLon, heading: number | null): { x: number; y: number; d: number } {
  const o = offsetM(me, p);
  const d = Math.hypot(o.east, o.north);
  const bearing = Math.atan2(o.east, o.north);
  const rel = bearing - ((heading ?? 0) * Math.PI) / 180;
  const r = radarRadius(d) * R;
  return { x: r * Math.sin(rel), y: -r * Math.cos(rel), d };
}

let uid = 0;

export function createRadar(): Radar {
  const id = `glow${++uid}`;
  const el = svg('svg', { viewBox: `${-R - 12} ${-R - 12} ${2 * R + 24} ${2 * R + 24}`, class: 'radar', role: 'img' });
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const defs = svg('defs');
  const filter = svg('filter', { id: `${id}-blur`, x: '-100%', y: '-100%', width: '300%', height: '300%' });
  filter.append(svg('feGaussianBlur', { stdDeviation: 3.2 }));
  defs.append(filter);
  el.append(defs);

  el.append(svg('circle', { r: R, class: 'radar-bg' }));
  const rings = svg('g', { class: 'radar-rings' });
  // 輪の距離は真下（後ろ）に小さく書く。光った人の名前と重なりにくいところ
  for (const m of [...RADAR_RINGS_M, RADAR_MAX_M]) {
    const r = radarRadius(m) * R;
    if (m !== RADAR_MAX_M) rings.append(svg('circle', { r }));
    const label = svg('text', { x: 0, y: r - 2.5, class: 'radar-ring-label', 'text-anchor': 'middle' });
    label.textContent = `${m}m`;
    rings.append(label);
  }
  el.append(rings);

  const north = svg('text', { class: 'radar-north', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  north.textContent = '北';
  el.append(north);

  const trails = svg('g', { class: 'radar-trails' });
  const lights = svg('g', { class: 'radar-lights' });
  el.append(trails, lights);

  const meG = svg('g', { class: 'radar-me' });
  const meHalo = svg('circle', { r: 14, class: 'radar-me-halo', filter: `url(#${id}-blur)` });
  const meDot = svg('circle', { r: 4.5, class: 'radar-me-dot' });
  const meArrow = svg('path', { d: 'M0,-13 L5,-5 L-5,-5 Z', class: 'radar-me-arrow' });
  meG.append(meHalo, meDot, meArrow);
  el.append(meG);

  /** 光っている人ごとの部品（描き直すたびに作り直さず、位置と濃さだけ変える。光った輪の動きが途切れないように） */
  interface Node {
    g: SVGGElement;
    dot: SVGCircleElement;
    ping: SVGCircleElement | null;
    label: SVGTextElement;
    trail: SVGPolylineElement;
  }
  const nodes = new Map<number, Node>();
  const nodeOf = (num: number): Node => {
    let n = nodes.get(num);
    if (n) return n;
    const g = svg('g', { class: 'radar-light' });
    g.append(svg('circle', { r: 10, class: 'radar-halo', filter: `url(#${id}-blur)` }));
    const dot = svg('circle', { r: 4.2, class: 'radar-dot' });
    const label = svg('text', { class: 'radar-name', y: 4 });
    g.append(dot, label);
    const trail = svg('polyline', { class: 'radar-trail' });
    trails.append(trail);
    lights.append(g);
    n = { g, dot, ping: null, label, trail };
    nodes.set(num, n);
    return n;
  };
  const drop = (num: number) => {
    const n = nodes.get(num);
    if (!n) return;
    n.g.remove();
    n.trail.remove();
    nodes.delete(num);
  };

  // 地図の実際の大きさ（px）から、図の中の字の大きさを決める（画面の字の最低ライン 16px に合わせる）
  let pxPerUnit = 1;
  const resize = () => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) pxPerUnit = Math.min(r.width, r.height) / (2 * R + 24);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(el);

  let lastKey = '';

  return {
    el,
    update({ me, heading, lights: ls, meLit }) {
      resize();
      const fontUnits = Math.max(11, 16 / Math.max(pxPerUnit, 0.01));
      // 輪の距離は、字が 16px で入る大きさの地図のときだけ出す
      const ringsLabelled = pxPerUnit * 12 >= 16;
      const key = JSON.stringify([
        me && [me.lat.toFixed(6), me.lon.toFixed(6)],
        heading === null ? null : Math.round(heading),
        ls.map((l) => [l.num, l.name, l.pos && [l.pos.lat, l.pos.lon], Math.round(l.fresh * 10), l.isNew, l.trail.length, l.trail[0]?.lat]),
        meLit,
        Math.round(fontUnits),
        ringsLabelled,
      ]);
      if (key === lastKey) return;
      lastKey = key;
      el.classList.toggle('is-lit', meLit);
      el.classList.toggle('is-north-up', heading === null);
      el.classList.toggle('has-ring-labels', ringsLabelled);
      el.style.setProperty('--radar-font', `${fontUnits.toFixed(1)}px`);
      meArrow.style.display = heading === null ? 'none' : '';
      // 北の印：方角が取れていれば回る
      const nRel = ((-(heading ?? 0)) * Math.PI) / 180;
      const nR = R - fontUnits * 0.65;
      north.setAttribute('x', (nR * Math.sin(nRel)).toFixed(1));
      north.setAttribute('y', (-nR * Math.cos(nRel)).toFixed(1));

      const aria: string[] = [];
      const placed = me
        ? ls.filter((l) => l.pos).map((l) => ({ l, p: project(me, l.pos!, heading) }))
        : [];
      const keep = new Set(placed.map((x) => x.l.num));
      for (const num of [...nodes.keys()]) if (!keep.has(num)) drop(num);
      if (!me) {
        el.setAttribute('aria-label', `光の地図：自分の位置を待っている。光っている ${ls.length}人`);
        return;
      }
      const labelled = new Set([...placed].sort((a, b) => a.p.d - b.p.d).slice(0, LABEL_MAX).map((x) => x.l.num));
      // 近い人ほど上に重ねる
      for (const { l, p } of [...placed].sort((a, b) => b.p.d - a.p.d)) {
        const n = nodeOf(l.num);
        const opacity = (0.35 + 0.65 * Math.max(0, Math.min(1, l.fresh))).toFixed(2);
        n.g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        n.g.setAttribute('opacity', opacity);
        lights.append(n.g); // 重ねる順を近い順に合わせる（同じ要素を動かすだけ）
        if (l.isNew && !n.ping) {
          n.ping = svg('circle', { r: 6, class: 'radar-ping' });
          n.g.insertBefore(n.ping, n.dot);
        } else if (!l.isNew && n.ping) {
          n.ping.remove();
          n.ping = null;
        }
        const show = labelled.has(l.num);
        n.label.style.display = show ? '' : 'none';
        if (show) {
          const right = p.x > R * 0.35;
          n.label.setAttribute('x', String(right ? -9 : 9));
          n.label.setAttribute('text-anchor', right ? 'end' : 'start');
          if (n.label.textContent !== l.name) n.label.textContent = l.name;
        }
        const pts = [...l.trail.map((t) => project(me, t, heading)), p];
        n.trail.setAttribute('points', pts.length > 1 ? pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') : '');
        n.trail.setAttribute('opacity', (Number(opacity) * 0.55).toFixed(2));
        aria.push(`${l.name} ${Math.round(p.d)}m`);
      }
      el.setAttribute('aria-label', `光の地図：光っている ${ls.length}人${aria.length ? `（${aria.join('、')}）` : ''}`);
    },
  };
}
