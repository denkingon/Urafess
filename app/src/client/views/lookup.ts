import type { LookupView } from '../../shared/protocol';
import type { AnnounceChime } from '../sound/chime';

/**
 * 本部の「前を向いて（LOOK UP / LISTEN）」。
 *
 * 参加者のスマホ：本部が押すと、サーバーが決めた瞬間（showAt）から全員同じ時刻でアニメを流す。
 *   ① 画面が一瞬白く光る → ② うつむいてスマホを見ている人 → ③ 前から音（蓄光の弧）が届く → ④ 顔を上げてスマホを下ろす
 *   → ⑤ LOOK UP／前を向いて／LISTEN 話を聞いて → ⑥ 約5秒で画面が暗くなり、下に小さく残る（スマホを見ても何もない）。
 *   本部が「終わり」を押すまで止まったまま。どの瞬間も showAt からの時間だけで描くので、途中で開いた人も同じ絵になる。
 * 主催者の画面：全画面は出さない（「終わり」を押せなくなるので）。本部のボタンが「流れている」になる。
 */

export interface LookupScreen {
  el: HTMLElement;
  update(lookup: LookupView | null): void;
}

/** 音を鳴らすのは、流し始めてからこの時間までに気づいたときだけ（途中で開いた人には鳴らさない） */
const RING_WITHIN_MS = 3_000;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const back = (t: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

// ピクトの骨組み（picto/engine.js と同じ寸法：線 80・縁 112・胴 127×313・頭 r76・切れ目 y396〜439）
const T = 'var(--tsuki,#f1ede4)';
const G = 'var(--picto-ground,#0b0c10)';
const M = 'var(--tsuki-muted,#a29d93)';
const C = 'var(--chikko,#b8ff5a)';
const limb = (len: number, col: string, w: number) =>
  `<line x1="0" y1="0" x2="0" y2="${len}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
const arm = (u: number, f: number, col: string, w: number, phone = '') =>
  `<g transform="rotate(${u})">${limb(102.4, col, w)}<g transform="translate(0,102.4) rotate(${f})">${limb(94.8, col, w)}${phone}</g></g>`;
const leg = (t: number, s: number, col: string, w: number) =>
  `<g transform="rotate(${t})">${limb(159, col, w)}<g transform="translate(0,159) rotate(${s})">${limb(154, col, w)}</g></g>`;

/** k = 0（うつむいてスマホ）→ 1（顔を上げてスマホを下ろす）。右が前 */
function figure(k: number, glow: number): string {
  const tor = lerp(12, -2, k);
  const head = lerp(58, -4, k);
  const aU = lerp(-16, -4, k);
  const aF = lerp(-78, -8, k);
  const bU = lerp(-8, 6, k);
  const bF = lerp(-84, -14, k);
  const lit = lerp(1, 0, k);
  const phone =
    `<g transform="translate(0,104) rotate(${lerp(10, 0, k)})"><rect x="-34" y="-58" width="68" height="116" rx="14" fill="${M}"/>` +
    `<rect x="-24" y="-46" width="48" height="88" rx="6" fill="${T}" opacity="${(0.25 + 0.75 * lit * glow).toFixed(3)}"/></g>`;
  return (
    `<g transform="translate(500,904.2) scale(0.95)"><g transform="translate(0,-343.9)">` +
    leg(-6, 2, T, 80) +
    `<g transform="rotate(${tor})">` +
    `<g transform="translate(0,-273)">${arm(bU, bF, T, 80)}</g>` +
    `<rect x="-63.6" y="-313" width="127.1" height="313" rx="24" fill="${T}"/>` +
    `<g transform="translate(0,-300) rotate(${head})"><circle cx="0" cy="-100" r="76" fill="${T}"/></g>` +
    `<g transform="translate(0,-273)">${arm(aU, aF, G, 112)}</g>` +
    `<g transform="translate(0,-273)">${arm(aU, aF, T, 80, phone)}</g>` +
    `</g>` +
    leg(8, -4, G, 112) +
    leg(8, -4, T, 80) +
    `</g></g>`
  );
}

/** 前（右）から届く音の弧。頭へ向かって寄ってくる */
function waves(t: number, amp: number): string {
  let s = '';
  const cx = 560;
  const cy = 330;
  const ang = (34 * Math.PI) / 180;
  for (let i = 0; i < 3; i++) {
    if (t < 900 + i * 200) continue;
    const p = ((t - 900) / 1500 + i / 3) % 1;
    const r = lerp(430, 190, easeOut(p));
    const a = Math.sin(Math.PI * p) * amp;
    const x1 = cx + r * Math.cos(-ang);
    const y1 = cy + r * Math.sin(-ang);
    const x2 = cx + r * Math.cos(ang);
    const y2 = cy + r * Math.sin(ang);
    s += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${C}" stroke-width="40" stroke-linecap="round" opacity="${a.toFixed(3)}"/>`;
  }
  return s;
}

const MASK =
  `<defs><mask id="lu-line" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">` +
  `<rect width="1000" height="1000" fill="#fff"/><rect x="0" y="396" width="1000" height="43" fill="#000"/></mask></defs>`;

function vibrate(): void {
  try {
    navigator.vibrate?.([200, 120, 200]);
  } catch {
    // iPhone はウェブから震わせられない
  }
}

export function createLookup(chime: AnnounceChime | null, serverNow: () => number): LookupScreen {
  const el = document.createElement('div');
  el.className = 'lookup';
  el.hidden = true;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.innerHTML = `
    <div class="lu-from" data-k="from"><b>HQ</b>本部から</div>
    <div class="lu-stage"><svg data-k="pic" viewBox="0 0 1000 1000" aria-hidden="true"></svg></div>
    <div class="lu-words">
      <div class="lu-en" data-k="en">LOOK UP</div>
      <div class="lu-ja" data-k="ja">前を向いて</div>
      <div><span class="lu-listen" data-k="listen">LISTEN<i>話を聞いて</i></span></div>
    </div>
    <div class="lu-dim" data-k="dim"></div>
    <div class="lu-rest" data-k="rest"><b>LOOK UP</b><span>前を向いて · 話を聞いて</span></div>
    <div class="lu-flash" data-k="flash"></div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const pic = q('pic') as unknown as SVGSVGElement;
  const parts = { from: q('from'), en: q('en'), ja: q('ja'), listen: q('listen'), dim: q('dim'), rest: q('rest'), flash: q('flash') };

  let cur: LookupView | null = null;
  /** 音を鳴らした（または鳴らさないと決めた）番号 */
  let rung = -1;
  let raf = 0;

  const draw = () => {
    raf = 0;
    if (!cur?.on) return;
    const t = serverNow() - cur.showAt;
    if (t < 0) {
      // まだ出す瞬間の前。全員と同じ瞬間を待つ
      el.hidden = true;
      raf = requestAnimationFrame(draw);
      return;
    }
    if (el.hidden) el.hidden = false;
    if (rung !== cur.seq) {
      rung = cur.seq;
      if (t < RING_WITHIN_MS) {
        chime?.play('lookup');
        vibrate();
      }
    }
    // ① 白く光る
    parts.flash.style.opacity = (t < 90 ? 1 : 1 - easeOut(seg(t, 90, 520))).toFixed(3);
    parts.from.style.opacity = easeOut(seg(t, 250, 650)).toFixed(3);
    // ②〜④ ピクト（暗くなったあとは描き直さない）
    if (t < 6600) {
      const k = back(seg(t, 1550, 2150));
      const appear = easeOut(seg(t, 300, 800));
      const amp = t < 900 ? 0 : t < 2100 ? 1 : 0.55;
      pic.innerHTML =
        MASK +
        `<g opacity="${appear.toFixed(3)}" transform="translate(-60,${lerp(30, 0, appear).toFixed(1)})">` +
        `<g mask="url(#lu-line)">${figure(k, 0.75 + 0.25 * Math.sin(t / 140))}</g>` +
        waves(t, amp) +
        `</g>`;
    }
    // ⑤ 言葉
    const e = easeOut(seg(t, 2050, 2550));
    parts.en.style.clipPath = `inset(${((1 - e) * 100).toFixed(1)}% 0 0 0)`;
    parts.en.style.transform = `translateY(${((1 - e) * 18).toFixed(1)}px)`;
    parts.ja.style.opacity = easeOut(seg(t, 2350, 2750)).toFixed(3);
    parts.listen.style.opacity = (easeOut(seg(t, 2700, 3100)) * (t > 3100 ? 0.75 + 0.25 * Math.cos((t - 3100) / 260) : 1)).toFixed(3);
    // ⑥ 暗くなって、下に小さく残る
    parts.dim.style.opacity = easeInOut(seg(t, 5200, 6400)).toFixed(3);
    const breathe = t > 6400 ? 0.55 + 0.45 * (0.5 + 0.5 * Math.cos((t - 6400) / 700)) : 1;
    parts.rest.style.opacity = (easeOut(seg(t, 6000, 6600)) * breathe).toFixed(3);
    raf = requestAnimationFrame(draw);
  };

  return {
    el,
    update(lookup) {
      const on = !!lookup?.on;
      const changed = on !== !!cur?.on || lookup?.seq !== cur?.seq;
      cur = lookup;
      if (!on) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        el.hidden = true;
        return;
      }
      if (changed || !raf) {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    },
  };
}

/** 主催者・本部の画面に出す「前を向いて」のボタン（どちらの主催者画面にも浮かせて出す） */
export function createLookupButton(send: (on: boolean) => void): { el: HTMLElement; update(lookup: LookupView | null): void } {
  const el = document.createElement('div');
  el.className = 'lookup-btn';
  el.innerHTML = `
    <button type="button" data-k="go"><b>LOOK UP</b><span>前を向いて（全員に流す）</span></button>
    <button type="button" data-k="end" hidden><b>■ 終わり</b><span>全員のスマホで流れている</span></button>
  `;
  const go = el.querySelector('[data-k="go"]') as HTMLButtonElement;
  const end = el.querySelector('[data-k="end"]') as HTMLButtonElement;
  go.addEventListener('click', () => send(true));
  end.addEventListener('click', () => send(false));
  return {
    el,
    update(lookup) {
      const on = !!lookup?.on;
      go.hidden = on;
      end.hidden = !on;
      el.dataset.on = on ? '1' : '0';
    },
  };
}
