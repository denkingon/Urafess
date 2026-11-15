import '../picto/engine.js';
import './drum.css';
import type { PhoneView } from '../../shared/viewmodel';
import { REVEAL_TAP_GUARD_MS } from '../../shared/rules';
import { UI, glyph, say } from '../ui';

/**
 * 見た目の層：配役のドラムロール（デザインのキャンバス「Urafess 配役のドラムロール」を移したもの）。
 *
 * 役が決まると、逃走者（月白）と鬼（朱）のカードが交互に流れ、止まった所で自分の役が出る（ドン）。
 *   sync：全員同時。下に 3・2・1。全員の画面が同じ瞬間に止まる（止まる時刻はサーバーが決め、各スマホの時計で数える）
 *   tap ：流れているカードをタップした人から止まる。押さない人は、主催者が「開始」を押したときに止まる
 * 流れている間は、画面の全体を覆う。下の普段の画面は、役で変わる所を全部隠したまま（viewmodel の drum）。
 * 流れている間、地は闇のまま（面を交互に塗ると画面全体が1秒に10回点滅する。ピクトの決まり「点滅は1秒に3回まで」）。
 * 光るのはドンの1回だけ。
 */

export interface DrumScreen {
  el: HTMLElement;
  /**
   * 毎フレーム呼ぶ。view.drum があれば流す。流れていたのが止まったら（drum が消えた・タップした）ドン。
   * role はドンで出す役（view.role は流れている間「なし」なので、me.role を渡す）
   */
  update(view: PhoneView, role: 'oni' | 'runner' | null): void;
}

interface DrumDeps {
  /** tap：本人がカードを止めた */
  onTap(): void;
}

const HIT_MS = 2_600;
/** 回りはじめの加速（秒）と、2枚が流れる長さ（秒）。1秒に10枚 */
const LOOP_S = 0.2;
const SPIN_S = 0.4;

let cards: { runner: string; oni: string } | null = null;
function cardSVG(): { runner: string; oni: string } {
  if (!cards) {
    const all = window.URAFES_PICTO.build({ BEAT: UI.beat }).pictos;
    const get = (id: string) => all.find((p) => p.id === id)?.svgStatic ?? '';
    cards = { runner: get('runner'), oni: get('chaser') };
  }
  return cards;
}

export function createDrum(deps: DrumDeps): DrumScreen {
  const el = document.createElement('div');
  el.className = 'drum';
  el.hidden = true;
  const c = cardSVG();
  const strip = Array.from({ length: 6 }, (_, i) => (i % 2 ? `<div class="dc on">${c.oni}</div>` : `<div class="dc rn">${c.runner}</div>`)).join('');
  el.innerHTML = `
    <div class="dr-shk">
      <div class="dr-top">${say(['配役', 'ROLE'])}</div>
      <div class="dr-mid">
        <div class="dr-reel" aria-hidden="true"><div class="dr-strip" style="animation-duration:${SPIN_S}s, ${LOOP_S}s; animation-delay:0s, ${SPIN_S}s">${strip}</div></div>
        <div class="dr-gate"></div>
        <div class="dr-burst"></div><div class="dr-burst b2"></div>
        <div class="dr-card">${'' /* ドンで入れる */}</div>
      </div>
      <div class="dr-low">
        <div class="dr-count u" aria-live="polite"></div>
        <div class="dr-tap"><div class="dr-rip" aria-hidden="true"><i class="r0"></i><i class="r1"></i><i class="r2"></i></div><div class="dr-word">${say(['タップ', 'TAP'])}</div></div>
        <div class="dr-sync">${say(['全員同時に出る', 'ALL AT ONCE'])}</div>
        <div class="dr-role" aria-live="polite"></div>
      </div>
    </div>
    <div class="dr-flash"></div>
    <button type="button" class="dr-btn" aria-label="タップして自分の役を見る"></button>
  `;
  const q = (s: string) => el.querySelector(s) as HTMLElement;
  const card = q('.dr-card');
  const count = q('.dr-count');
  const roleWord = q('.dr-role');
  const btn = q('.dr-btn') as HTMLButtonElement;

  let phase: 'off' | 'roll' | 'hit' = 'off';
  let mode: 'sync' | 'tap' = 'sync';
  let rollAt = 0;
  let hitUntil = 0;
  let lastCount: number | null = null;
  const sound = new DrumSound();

  const setPhase = (p: typeof phase) => {
    phase = p;
    el.hidden = p === 'off';
    el.dataset.phase = p;
  };

  const hit = (role: 'oni' | 'runner' | null) => {
    sound.stopRoll();
    if (!role) {
      setPhase('off');
      return;
    }
    el.dataset.role = role;
    card.innerHTML = role === 'oni' ? c.oni : c.runner;
    roleWord.innerHTML =
      `<div class="dr-rw">${say(role === 'oni' ? ['鬼', 'CHASER'] : ['逃走者', 'RUNNER'])}</div>` +
      `<div class="dr-mark" aria-hidden="true">${role === 'oni' ? glyph.oni : '<i class="dot"></i>'}</div>`;
    // アニメを最初からやり直すため、一度外して付け直す
    el.classList.remove('is-hit');
    void el.offsetWidth;
    el.classList.add('is-hit');
    setPhase('hit');
    hitUntil = performance.now() + HIT_MS;
    sound.don();
    try {
      navigator.vibrate?.(160);
    } catch {
      // 振動できない端末（iPhone）
    }
  };

  let pendingRole: 'oni' | 'runner' | null = null;
  btn.addEventListener('click', () => {
    sound.unlock();
    if (phase === 'hit') {
      // ドンのあとは、タップで閉じる
      hitUntil = 0;
      return;
    }
    if (phase !== 'roll' || mode !== 'tap' || performance.now() - rollAt < REVEAL_TAP_GUARD_MS) return;
    deps.onTap();
    hit(pendingRole);
  });

  return {
    el,
    update(view, role) {
      pendingRole = role;
      const d = view.drum ?? null;
      const now = performance.now();
      if (d) {
        if (phase !== 'roll') {
          el.classList.remove('is-hit');
          setPhase('roll');
          rollAt = now;
          lastCount = null;
          sound.startRoll();
        }
        mode = d.mode;
        el.dataset.mode = d.mode;
        if (d.count !== lastCount) {
          lastCount = d.count;
          count.textContent = d.count === null ? '' : String(d.count);
          count.classList.remove('tick');
          if (d.count !== null) {
            void count.offsetWidth;
            count.classList.add('tick');
            sound.tick();
          }
        }
        return;
      }
      // 流れていたのが止まった（全員同時の時刻が来た・主催者が開始を押した）
      if (phase === 'roll') hit(role);
      if (phase === 'hit' && now > hitUntil) setPhase('off');
    },
  };
}

/**
 * ドラムロールの音（Web Audio）。画面に一度触れたあとでないと鳴らない。iPhone の消音スイッチが入っていると鳴らない。
 * 鳴らなくても、ドンは見た目だけで成り立つ
 */
class DrumSound {
  private ac: AudioContext | null | undefined;
  private noiseBuf: AudioBuffer | null = null;
  private rollId: ReturnType<typeof setInterval> | null = null;

  unlock(): void {
    this.ctx();
  }

  private ctx(): AudioContext | null {
    if (this.ac === undefined) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      try {
        this.ac = C ? new C() : null;
      } catch {
        this.ac = null;
      }
    }
    try {
      if (this.ac?.state === 'suspended') void this.ac.resume();
    } catch {
      // 触れたあとでないと再開できない
    }
    return this.ac?.state === 'running' ? this.ac : null;
  }

  private noise(ac: AudioContext): AudioBuffer {
    if (!this.noiseBuf) {
      const b = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = b;
    }
    return this.noiseBuf;
  }

  private stroke(ac: AudioContext, t: number, gain: number, freq: number, len: number): void {
    const s = ac.createBufferSource();
    s.buffer = this.noise(ac);
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 0.8;
    const v = ac.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    v.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(f);
    f.connect(v);
    v.connect(ac.destination);
    s.start(t, Math.random() * 0.5);
    s.stop(t + len + 0.02);
  }

  /** 56ms ごとの打音。だんだん大きくなる */
  startRoll(): void {
    if (this.rollId) return;
    const ac = this.ctx();
    if (!ac) return;
    const t0 = ac.currentTime;
    let next = t0 + 0.03;
    let k = 0;
    this.rollId = setInterval(() => {
      if (next < ac.currentTime) next = ac.currentTime + 0.01;
      while (next < ac.currentTime + 0.12) {
        const g = Math.min(0.55, 0.16 + (next - t0) * 0.12) * (k % 2 ? 0.75 : 1);
        this.stroke(ac, next, g, 2300, 0.055);
        next += 0.056;
        k++;
      }
    }, 30);
  }

  stopRoll(): void {
    if (this.rollId) clearInterval(this.rollId);
    this.rollId = null;
  }

  tick(): void {
    const ac = this.ctx();
    if (ac) this.stroke(ac, ac.currentTime + 0.01, 0.6, 4200, 0.07);
  }

  don(): void {
    const ac = this.ctx();
    if (!ac) return;
    const t = ac.currentTime + 0.01;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const v = ac.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(1, t + 0.006);
    v.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(v);
    v.connect(ac.destination);
    o.start(t);
    o.stop(t + 1);
    this.stroke(ac, t, 0.9, 500, 0.16);
    this.stroke(ac, t, 0.5, 3000, 0.05);
  }
}
