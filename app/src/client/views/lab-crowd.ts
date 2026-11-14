import { delta, type LatLon } from '../../shared/crowd';
import { CAMPUS_BOX, DEFAULT_DURATIONS_MS } from '../../shared/rules';
import type { KeyValueStore } from '../core/game-client';
import { Crowd, type CrowdSnapshot } from '../crowd/driver';
import { COLOR, esc } from '../ui';
import { createOverview, type OvPoint } from './overview';

/**
 * 偽の群衆（/lab?k=crowd&g=稽古の部屋）。Mac のブラウザで開いておく1枚。
 * 偽の参加者を稽古の部屋に入れ、1人ずつ座標を持たせて、段階と役に合わせて動かす。本物のスマホは同じ部屋に入るだけでいい。
 * 本番の部屋（main）には入れない。道具の色は無彩色、人（素材）だけ裏フェスの色。
 */

/** SFC の鴨池のあたり（機械テストと同じ点） */
const SFC: LatLon = { lat: 35.38873, lon: 139.42701 };
const SHORT_DURATIONS_MS = [10_000, 15_000, 90_000, 20_000];
const MAX_COUNT = 150;
const PHASE_NAME: Record<CrowdSnapshot['phase'], string> = {
  idle: '集まっている',
  ready: '配役済み',
  wait: '逃走開始まで',
  escape: '追跡開始まで',
  game: 'ゲーム',
  return: '広場に戻る',
  paused: '止まっている',
};

function botStore(i: number): KeyValueStore {
  const key = (k: string) => `urafess-crowd:${i}:${k}`;
  return {
    get: (k) => localStorage.getItem(key(k)),
    set: (k, v) => localStorage.setItem(key(k), v),
    remove: (k) => localStorage.removeItem(key(k)),
  };
}

export function createCrowdLab(params: URLSearchParams): HTMLElement {
  const asked = (params.get('g') ?? 'keiko').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'keiko';
  const gameId = asked === 'main' ? 'keiko' : asked;
  const token = localStorage.getItem('urafess:host-token');
  const el = document.createElement('main');
  el.className = 'phone lab lab-crowd';
  el.innerHTML = `
    <h1>偽の群衆</h1>
    <p class="lead">偽の参加者を稽古の部屋「${esc(gameId)}」に入れて、本物と同じ通信で動かす。この画面は開いたままにする。本番の部屋 main には入れない。</p>
    ${asked === 'main' ? '<p class="lab-warn">main は本番の部屋なので、稽古の部屋 keiko に入れる。</p>' : ''}
    <div class="crowd-links"><a href="/host?g=${esc(gameId)}" target="_blank" rel="noopener">主催者の画面</a><a href="/?g=${esc(gameId)}" target="_blank" rel="noopener">参加者の画面</a></div>
    <label class="lab-field">人数 <span data-k="countText"></span><input type="range" min="1" max="${MAX_COUNT}" step="1" data-k="count"></label>
    <label class="lab-field">広場の場所<select data-k="place"><option value="sfc">SFC（鴨池のあたり）</option><option value="here">この端末のいる場所</option></select></label>
    <label class="lab-field">広がり（隠れ場所までの遠さ）<span data-k="reachText"></span><input type="range" min="40" max="300" step="10" data-k="reach"></label>
    <label class="lab-field">動きの速さ<select data-k="speed"><option value="1">本物と同じ</option><option value="2">2倍</option><option value="4">4倍</option></select></label>
    <label class="crowd-check"><input type="checkbox" data-k="noise" checked>位置にゆらぎを入れる（本物の GPS のように）</label>
    <label class="crowd-check"><input type="checkbox" data-k="auto">自動で回す（配役 → 開始 → 終わったらまた配役）</label>
    <div class="lab-mode"><button type="button" data-act="short">短い時間にする</button><button type="button" data-act="real">本番の時間に戻す</button></div>
    <p class="lab-hint" data-k="hostNote"></p>
    <button type="button" class="crowd-go" data-act="go"><b data-k="goLabel">入れる</b></button>
    <label class="lab-field">上から見る地図<select data-k="view"><option value="sfc">SFC の地図（参加者の全体の地図と同じ下地）</option><option value="rings">距離の輪（広場が真ん中・50m ごと）</option></select></label>
    <div class="crowd-sfc" data-k="sfc"></div>
    <canvas class="crowd-map" data-k="map" width="720" height="720" aria-label="上から見た地図" hidden></canvas>
    <div class="crowd-legend"><span><i style="background:${COLOR.shu}"></i>鬼</span><span><i style="background:${COLOR.tsuki}"></i>逃走者</span><span><i class="hollow"></i>牢屋（SFC の地図では薄い点）</span><span><i style="background:${COLOR.chikko}"></i>光っている</span><span><i class="sq"></i>本物の人（SFC の地図では名前に「本物」）</span></div>
    <div class="lab-probe">
      <div class="lab-kv"><span>いま</span><b data-k="phase">—</b></div>
      <div class="lab-kv"><span>入っている／つながっている</span><b data-k="ready">—</b></div>
      <div class="lab-kv"><span>鬼／逃走者／牢屋</span><b data-k="counts">—</b></div>
      <div class="lab-kv"><span>偽の人どうしの捕獲／解放</span><b data-k="events">—</b></div>
      <div class="lab-kv"><span>本物の人（見えている数）</span><b data-k="humans">—</b></div>
      <div class="lab-kv"><span>送ったメッセージ</span><b data-k="sent">—</b></div>
    </div>
    <p class="lab-hint">偽の人は音を鳴らせない。偽の人との捕獲・解放は「同時に長押し」で記録される。位置と「走ると光る」は本物と同じ間隔で送る。</p>
  `;
  const q = <T extends HTMLElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
  const count = q<HTMLInputElement>('count');
  const reach = q<HTMLInputElement>('reach');
  const place = q<HTMLSelectElement>('place');
  const speed = q<HTMLSelectElement>('speed');
  const noise = q<HTMLInputElement>('noise');
  const auto = q<HTMLInputElement>('auto');
  const canvas = q<HTMLCanvasElement>('map');
  const view = q<HTMLSelectElement>('view');
  const sfcBox = q('sfc');
  const overview = createOverview();
  sfcBox.append(overview.el);
  if (params.get('view') === 'rings') view.value = 'rings';
  const showView = () => {
    sfcBox.hidden = view.value !== 'sfc';
    canvas.hidden = view.value === 'sfc';
  };
  showView();
  view.addEventListener('change', showView);
  count.value = String(Math.max(1, Math.min(MAX_COUNT, Number(params.get('n')) || 30)));
  reach.value = String(Math.max(40, Math.min(300, Number(params.get('reach')) || 180)));
  speed.value = ['1', '2', '4'].includes(params.get('speed') ?? '') ? params.get('speed')! : '1';
  auto.checked = params.get('auto') === '1' && token !== null;
  auto.disabled = token === null;
  q('hostNote').textContent = token
    ? '主催者の合言葉がこの端末にある：自動で回せる。本物の人の位置と役も偽の人に見える（鬼は追い、逃走者は逃げる）。'
    : '主催者の合言葉がこの端末にない：「主催者の画面」を一度開いて合言葉を入れると、自動で回せる。なくても、主催者の画面でラウンドを進めれば偽の人は動く。';

  let crowd: Crowd | null = null;
  let here: LatLon | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const labels = () => {
    q('countText').textContent = `${count.value}人`;
    q('reachText').textContent = `${reach.value}m`;
  };
  labels();

  const apply = () => {
    if (!crowd) return;
    crowd.speed = Number(speed.value);
    crowd.noise = noise.checked;
    crowd.auto = auto.checked;
  };

  const begin = (center: LatLon) => {
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/game/${gameId}/ws`;
    crowd = new Crowd({
      url: wsUrl,
      gameId,
      count: Number(count.value),
      center,
      reach: Number(reach.value),
      createSocket: (u) => new WebSocket(u),
      now: () => Date.now(),
      storeFor: botStore,
      hostToken: token,
      // SFC に置くときは、キャンパスの枠の外へ行かせない
      bounds: center === SFC ? CAMPUS_BOX : undefined,
    });
    apply();
    crowd.start();
    if (params.get('fast') === '1') setTimeout(() => crowd?.setDurations(SHORT_DURATIONS_MS), 2_500);
    // 試験用（?debug=1）：ヘッドレスのブラウザから中身を読むため
    if (params.get('debug') === '1') (window as unknown as { __urafessCrowd?: Crowd }).__urafessCrowd = crowd;
    timer = setInterval(frame, 250);
    q('goLabel').textContent = '止める（全員を切る）';
    place.disabled = true;
    reach.disabled = true;
  };

  const end = () => {
    if (timer) clearInterval(timer);
    timer = null;
    crowd?.stop();
    crowd = null;
    q('goLabel').textContent = '入れる';
    place.disabled = false;
    reach.disabled = false;
  };

  const go = () => {
    if (crowd) return end();
    if (place.value !== 'here') return begin(SFC);
    if (here) return begin(here);
    q('goLabel').textContent = '場所を取っている…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        here = { lat: p.coords.latitude, lon: p.coords.longitude };
        begin(here);
      },
      () => {
        q('goLabel').textContent = '入れる';
        q('hostNote').textContent = 'この端末の場所が取れなかった。「SFC」を選ぶか、位置の許可を確かめる。';
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  el.querySelector('[data-act="go"]')!.addEventListener('click', go);
  el.querySelector('[data-act="short"]')!.addEventListener('click', () => note(crowd?.setDurations(SHORT_DURATIONS_MS), '短い時間（10秒・15秒・1分30秒・20秒）'));
  el.querySelector('[data-act="real"]')!.addEventListener('click', () => note(crowd?.setDurations([...DEFAULT_DURATIONS_MS]), '本番の時間（20秒・1分・5分・2分）'));
  const note = (sent: boolean | undefined, what: string) => {
    q('hostNote').textContent = sent ? `${what}を頼んだ。試合中は変わらない（配役の前・配役済み・結果のときだけ）。` : '時間は、群衆を入れていて主催者の合言葉があるときだけ変えられる。';
  };
  count.addEventListener('input', () => {
    labels();
    crowd?.setCount(Number(count.value));
  });
  reach.addEventListener('input', labels);
  for (const c of [speed, noise, auto]) c.addEventListener('change', apply);

  function frame(): void {
    if (!crowd) return;
    crowd.tick();
    const s = crowd.snapshot();
    q('phase').textContent = `${PHASE_NAME[s.phase]}${s.round ? `（ラウンド ${s.round}）` : ''}`;
    q('ready').textContent = `${s.ready}／${s.online}`;
    q('counts').textContent = s.counts ? `${s.counts.oni}／${s.counts.runner}／${s.counts.caught}` : '—';
    q('events').textContent = `${s.captures}／${s.rescues}`;
    q('humans').textContent = s.hostState === 'denied' ? '合言葉がちがう' : String(s.humans.length);
    q('sent').textContent = String(s.sent);
    if (view.value === 'sfc') overview.update({ me: null, meKind: 'unknown', meLit: false, points: toPoints(s), labelMax: 10 });
    else draw(canvas, s, crowd.center, crowd.jailAt, Number(reach.value));
  }

  if (params.get('go') === '1') go();
  return el;
}

/** SFC の地図に置く点。牢屋の人は薄く、本物の人は名前に（本物）をつける */
function toPoints(s: CrowdSnapshot): OvPoint[] {
  const bots: OvPoint[] = s.members
    .filter((m) => m.ready)
    .map((m, i) => ({ key: `b${i}`, name: m.name, pos: m.pos, acc: 5, kind: m.role === 'oni' ? 'oni' : 'runner', fresh: m.caught ? 0.25 : 1, lit: m.lit }));
  const humans: OvPoint[] = s.humans.map((h) => ({ key: `h${h.name}`, name: `${h.name}（本物）`, pos: h.pos, acc: 5, kind: h.role === 'oni' ? 'oni' : h.role === 'runner' ? 'runner' : 'unknown', fresh: 1, lit: h.lit }));
  return [...humans, ...bots];
}

function draw(canvas: HTMLCanvasElement, s: CrowdSnapshot, home: LatLon, jail: LatLon, reach: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const span = reach * 1.35;
  const k = size / 2 / span;
  const at = (p: LatLon): [number, number] => {
    const d = delta(home, p);
    return [size / 2 + d.east * k, size / 2 - d.north * k];
  };
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, size, size);
  // 道具の線は無彩色：50m ごとの輪と、広場・牢屋の印
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let r = 50; r <= span; r += 50) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#777';
  ctx.font = '20px sans-serif';
  ctx.fillText('北', size / 2 - 10, 24);
  ctx.fillText('50m', size / 2 + 50 * k + 4, size / 2 - 4);
  const [jx, jy] = at(jail);
  ctx.strokeStyle = '#888';
  ctx.strokeRect(jx - 12, jy - 12, 24, 24);
  ctx.fillText('牢屋', jx - 20, jy + 36);
  ctx.fillText('広場', size / 2 - 20, size / 2 - 16);
  // 本物の人は中の抜けた四角（下に重なった偽の人が見えるように、先に描く）
  for (const h of s.humans) {
    const [x, y] = at(h.pos);
    ctx.strokeStyle = h.lit ? COLOR.chikko : h.role === 'oni' ? COLOR.shu : COLOR.tsuki;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 12, y - 12, 24, 24);
    ctx.fillStyle = '#ddd';
    ctx.fillText(h.name, x + 18, y - 14);
  }

  for (const m of s.members) {
    if (!m.ready) continue;
    const [x, y] = at(m.pos);
    const color = m.role === 'oni' ? COLOR.shu : m.role === 'runner' ? COLOR.tsuki : '#666';
    if (m.lit) {
      ctx.strokeStyle = COLOR.chikko;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    if (m.caught) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}
