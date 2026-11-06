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

  let lastKey = '';

  return {
    el,
    update({ me, heading, lights: ls, meLit }) {
      const key = JSON.stringify([me && [me.lat.toFixed(6), me.lon.toFixed(6)], heading === null ? null : Math.round(heading), ls, meLit]);
      if (key === lastKey) return;
      lastKey = key;
      el.classList.toggle('is-lit', meLit);
      el.classList.toggle('is-north-up', heading === null);
      meArrow.style.display = heading === null ? 'none' : '';
      // 北の印：方角が取れていれば回る
      const nRel = ((-(heading ?? 0)) * Math.PI) / 180;
      north.setAttribute('x', String((R + 6) * Math.sin(nRel)));
      north.setAttribute('y', String(-(R + 6) * Math.cos(nRel)));

      trails.replaceChildren();
      lights.replaceChildren();
      const aria: string[] = [];
      if (!me) {
        el.setAttribute('aria-label', `光の地図：自分の位置を待っている。光っている ${ls.length}人`);
        return;
      }
      const placed = ls
        .filter((l) => l.pos)
        .map((l) => ({ l, p: project(me, l.pos!, heading) }))
        .sort((a, b) => b.p.d - a.p.d); // 近い人を上に重ねる
      const labelled = new Set([...placed].sort((a, b) => a.p.d - b.p.d).slice(0, LABEL_MAX).map((x) => x.l.num));
      for (const { l, p } of placed) {
        const opacity = 0.35 + 0.65 * Math.max(0, Math.min(1, l.fresh));
        if (l.trail.length > 0) {
          const pts = [...l.trail.map((t) => project(me, t, heading)), p];
          for (let i = 1; i < pts.length; i++) {
            const seg = svg('line', {
              x1: pts[i - 1].x.toFixed(1),
              y1: pts[i - 1].y.toFixed(1),
              x2: pts[i].x.toFixed(1),
              y2: pts[i].y.toFixed(1),
              class: 'radar-trail',
              opacity: ((i / pts.length) * opacity).toFixed(2),
            });
            trails.append(seg);
          }
        }
        const g = svg('g', { transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`, opacity: opacity.toFixed(2), class: l.isNew ? 'radar-light is-new' : 'radar-light' });
        g.append(svg('circle', { r: 10, class: 'radar-halo', filter: `url(#${id}-blur)` }));
        if (l.isNew) g.append(svg('circle', { r: 6, class: 'radar-ping' }));
        g.append(svg('circle', { r: 4.2, class: 'radar-dot' }));
        if (labelled.has(l.num)) {
          const t = svg('text', { x: p.x > R * 0.45 ? -8 : 8, y: 4, class: 'radar-name', 'text-anchor': p.x > R * 0.45 ? 'end' : 'start' });
          t.textContent = l.name;
          g.append(t);
        }
        lights.append(g);
        aria.push(`${l.name} ${Math.round(p.d)}m`);
      }
      el.setAttribute('aria-label', `光の地図：光っている ${ls.length}人${aria.length ? `（${aria.join('、')}）` : ''}`);
    },
  };
}
