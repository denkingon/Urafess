import { RUN_CADENCE_MIN, RUN_PEAK_MIN, RUN_SPEED_MIN } from '../../shared/rules';
import { compassName } from '../../shared/run';
import type { Sensors } from '../sense';

/**
 * 走りの試し（/lab?k=run）。部屋もサーバーも使わず、1台で「走ると光る」の判定を確かめる。
 * スマホを持って（手・ポケット・かばん）歩く・小走り・全力で走るをやって、「光っている」に切り替わるかを見る。
 * テンポと強さの下限はつまみで変えられる。いちばん合う値を rules.ts の RUN_CADENCE_MIN・RUN_PEAK_MIN に入れる。
 */

const TRACE_MS = 5_000;
/** 波形の縦の幅（m/s²） */
const TRACE_MAX = 40;

export function createRunLab(sensors: Sensors): HTMLElement {
  const el = document.createElement('main');
  el.className = 'phone lab lab-run';
  el.innerHTML = `
    <h1>走りの試し</h1>
    <p class="lead">スマホを持って、歩く・小走り・全力で走るをやってみる。「光っている」に切り替われば、試合でも全員の画面に光る。サーバーは使わない。<a href="/lab">音の試しへ</a></p>
    <button type="button" class="glow-ask" data-act="sense"><b>動きと位置をオンにする</b><span>許可を聞かれたら「許可」を押す</span></button>
    <div class="lab-lamp" data-k="lamp"><b data-k="lampText">止まっている・歩いている</b><span data-k="lampSub"></span></div>
    <canvas class="lab-trace" data-k="trace" width="600" height="180" aria-label="揺れの波形"></canvas>
    <div class="lab-probe">
      <div class="lab-kv"><span>1歩のテンポ（2.5秒の間）</span><b data-k="cadence">—</b></div>
      <div class="lab-kv"><span>1歩の強さ（平均）</span><b data-k="peak">—</b></div>
      <div class="lab-kv"><span>数えた歩数（2.5秒の間）</span><b data-k="steps">—</b></div>
      <div class="lab-kv"><span>いまの揺れ</span><b data-k="level">—</b></div>
      <div class="lab-kv"><span>位置の速さ</span><b data-k="speed">—</b></div>
      <div class="lab-kv"><span>位置の誤差</span><b data-k="acc">—</b></div>
      <div class="lab-kv"><span>向いている方角</span><b data-k="heading">—</b></div>
      <div class="lab-kv"><span>センサー</span><b data-k="sense">—</b></div>
    </div>
    <label class="lab-field">テンポの下限 <span data-k="cadText"></span><input type="range" min="1.6" max="3.2" step="0.1" data-k="cad"></label>
    <label class="lab-field">強さの下限 <span data-k="peakText"></span><input type="range" min="12" max="26" step="0.5" data-k="peakMin"></label>
    <p class="lab-hint">波形の点線＝強さの下限。白い点＝数えた1歩。歩きで点が出ない・走りで点が続くなら合っている。決めた値（テンポ・強さ）をチャットで送ると、本番の決まりに入れる。</p>
    <div class="lab-heard" data-k="log">まだ切り替わっていない。</div>
  `;
  const q = <T extends HTMLElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
  const canvas = q<HTMLCanvasElement>('trace');
  const ctx = canvas.getContext('2d');
  const cad = q<HTMLInputElement>('cad');
  const peakMin = q<HTMLInputElement>('peakMin');
  cad.value = String(RUN_CADENCE_MIN);
  peakMin.value = String(RUN_PEAK_MIN);
  sensors.detector.keepTraceMs = TRACE_MS;
  const log: string[] = [];
  let wasLit = false;

  el.querySelector('[data-act="sense"]')!.addEventListener('click', () => sensors.request());
  const applyParams = () => {
    sensors.detector.params = { ...sensors.detector.params, cadenceMin: Number(cad.value), peakMin: Number(peakMin.value) };
    q('cadText').textContent = `${Number(cad.value).toFixed(1)}歩/秒${Number(cad.value) === RUN_CADENCE_MIN ? '（今の既定）' : ''}`;
    q('peakText').textContent = `${Number(peakMin.value).toFixed(1)} m/s²${Number(peakMin.value) === RUN_PEAK_MIN ? '（今の既定）' : ''}`;
  };
  cad.addEventListener('input', applyParams);
  peakMin.addEventListener('input', applyParams);
  applyParams();
  sensors.setActive(true);

  const drawTrace = (now: number) => {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const y = (v: number) => h - (Math.min(TRACE_MAX, Math.max(0, v)) / TRACE_MAX) * h;
    const x = (t: number) => w - ((now - t) / TRACE_MS) * w;
    // 重力（止まっていると 9.8）と下限
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(9.8));
    ctx.lineTo(w, y(9.8));
    ctx.stroke();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#8c8c8c';
    ctx.beginPath();
    ctx.moveTo(0, y(sensors.detector.params.peakMin));
    ctx.lineTo(w, y(sensors.detector.params.peakMin));
    ctx.stroke();
    ctx.setLineDash([]);
    const { samples, steps } = sensors.detector.trace();
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((s, i) => (i === 0 ? ctx.moveTo(x(s.t), y(s.v)) : ctx.lineTo(x(s.t), y(s.v))));
    ctx.stroke();
    ctx.fillStyle = '#f2f2f2';
    for (const s of steps) {
      if (now - s.t > TRACE_MS) continue;
      ctx.beginPath();
      ctx.arc(x(s.t), y(s.v), 6, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const loop = () => {
    const now = Date.now();
    const lit = sensors.tick(now);
    const r = sensors.read(now);
    const fix = sensors.position(now);
    const heading = sensors.heading(now);
    q('lamp').classList.toggle('is-lit', lit);
    q('lampText').textContent = lit ? '光っている（走っている）' : '止まっている・歩いている';
    q('lampSub').textContent = r.running && !lit ? '走りを見つけた。少し続けると光る' : !r.running && lit ? '走りが止まった。少しで消える' : r.by === 'gps' ? '動きのセンサーが無いので、位置の速さで決めている' : '';
    q('cadence').textContent = r.steps >= 2 ? `${r.cadence.toFixed(2)} 歩/秒` : '—';
    q('peak').textContent = r.steps > 0 ? `${r.peak.toFixed(1)} m/s²` : '—';
    q('steps').textContent = String(r.steps);
    q('level').textContent = r.motion ? `${r.level.toFixed(1)} m/s²` : '—';
    q('speed').textContent = r.speed === null ? '—' : `${(r.speed * 3.6).toFixed(1)} km/h${r.speed >= RUN_SPEED_MIN ? '（走りの速さ）' : ''}`;
    q('acc').textContent = fix ? `±${Math.round(fix.acc)} m` : '—';
    q('heading').textContent = heading === null ? '—（北が上の地図になる）' : `${compassName(heading)}（${Math.round(heading)}°）`;
    const name = (s: string) => ({ off: 'まだ', asking: '準備中', ok: 'OK', denied: '許可されていない', unsupported: '無い', error: '取れない' })[s] ?? s;
    q('sense').textContent = `動き ${name(sensors.motion)}・位置 ${name(sensors.geo)}・方角 ${name(sensors.compass)}`;
    (el.querySelector('[data-act="sense"]') as HTMLElement).hidden = sensors.asked && sensors.motion !== 'denied' && sensors.geo !== 'denied';
    if (lit !== wasLit) {
      wasLit = lit;
      const t = new Date(now).toLocaleTimeString('ja-JP', { hour12: false });
      log.push(`${t}　${lit ? '光った' : '消えた'}（テンポ ${r.cadence.toFixed(1)}・強さ ${r.peak.toFixed(1)}${r.speed !== null ? `・速さ ${(r.speed * 3.6).toFixed(0)}km/h` : ''}）`);
      q('log').replaceChildren(
        ...log.slice(-8).reverse().map((line) => {
          const row = document.createElement('div');
          row.textContent = line;
          return row;
        }),
      );
      try {
        navigator.vibrate?.(lit ? [40, 40, 40] : 20);
      } catch {
        // 震えない端末
      }
    }
    drawTrace(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return el;
}
