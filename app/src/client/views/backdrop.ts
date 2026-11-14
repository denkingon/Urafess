import SFC from '../sfc-map.json';

/**
 * 背景の地図：参加者の画面（入室〜結果）の後ろに、SFC の建物・道・池を自分たちの線で描いて敷く。
 * 値は「裏フェス 地図 つまみ」で本人が選んだ形（朱の建物・キャンパスが真ん中・地の濃さ 45%）。
 * 形のデータは OpenStreetMap（ODbL）から取ったもの（sfc-map.json）。アプリに入っているので電波が無くても出る。
 * ?bg=off で消せる。
 */
const PLACE = { zoom: 100, px: -17, py: -7 };

type Shape = number[];
const H = SFC.height;
const W = SFC.width;
const pts = (a: Shape) => {
  let s = '';
  for (let i = 0; i < a.length; i += 2) s += `${i ? ' ' : ''}${a[i]},${Math.round((H - a[i + 1]) * 10) / 10}`;
  return s;
};
const layer = (cls: string, list: Shape[], tag: 'polygon' | 'polyline') =>
  `<g class="${cls}">${list.map((p) => `<${tag} points="${pts(p)}"/>`).join('')}</g>`;

export function mountBackdrop(): void {
  if (document.querySelector('.backdrop')) return;
  const el = document.createElement('div');
  el.className = 'backdrop';
  el.setAttribute('aria-hidden', 'true');
  const d = SFC as unknown as Record<string, Shape[]>;
  el.innerHTML =
    `<svg class="bd-svg" preserveAspectRatio="xMidYMid slice">` +
    layer('bd-green', d.green, 'polygon') + layer('bd-green', d.pitch, 'polygon') + layer('bd-water', d.water, 'polygon') +
    layer('bd-plaza', d.plaza, 'polygon') + layer('bd-road big', d.roadBig, 'polyline') + layer('bd-road', d.road, 'polyline') +
    layer('bd-path', d.path, 'polyline') + layer('bd-path steps', d.steps, 'polyline') + layer('bd-bld', d.bld, 'polygon') +
    `</svg>`;
  const credit = document.createElement('a');
  credit.className = 'backdrop-credit';
  credit.href = 'https://www.openstreetmap.org/copyright';
  credit.target = '_blank';
  credit.rel = 'noopener';
  credit.textContent = '© OpenStreetMap';
  document.body.prepend(el);
  document.body.append(credit);
  document.body.classList.add('has-backdrop');
  const svg = el.querySelector('svg')!;
  const fit = () => {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const vh = H / (PLACE.zoom / 100);
    const vw = vh * aspect;
    const cx = W / 2 + (PLACE.px / 50) * (W / 2);
    const cy = H / 2 + (PLACE.py / 50) * (H / 2);
    svg.setAttribute('viewBox', [cx - vw / 2, cy - vh / 2, vw, vh].map((n) => Math.round(n * 10) / 10).join(' '));
  };
  fit();
  window.addEventListener('resize', fit);
}
