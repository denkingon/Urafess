import type { LookupView } from '../../shared/protocol';
import type { AnnounceChime } from '../sound/chime';

/**
 * 本部の「前を向いて（LOOK UP / LISTEN）」点滅版。
 *
 * 参加者のスマホ：本部が押すと、サーバーが決めた瞬間（showAt）から全員同じ拍で点滅する。
 *   画面が一瞬白く光る → 上向きの矢印3段が下から上へ順に点き（蓄光）、LOOK UP が点滅。前を向いて・LISTEN は点いたまま。
 *   本部が「終わり」を押すまで続く。拍は showAt からの時間だけで決めるので、全員のスマホが同じ拍で光る。
 * 主催者の画面：全画面は出さない（「終わり」を押せなくなるので）。本部のボタンが「流れている」になる。
 */

export interface LookupScreen {
  el: HTMLElement;
  update(lookup: LookupView | null): void;
}

/** 音を鳴らすのは、流し始めてからこの時間までに気づいたときだけ（途中で開いた人には鳴らさない） */
const RING_WITHIN_MS = 3_000;
/** 点滅の1周（ms）。矢印は下から上へ 0.22 周ずつずれて 0.42 周ずつ点く。LOOK UP は前半だけ点く */
const PERIOD_MS = 900;

const CHEVRON =
  '<svg viewBox="0 0 260 150" aria-hidden="true"><path d="M30 122 L130 34 L230 122" fill="none" stroke="currentColor" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    <div class="lu-arrows">${CHEVRON}${CHEVRON}${CHEVRON}</div>
    <div class="lu-en">LOOK UP</div>
    <div class="lu-ja">前を向いて</div>
    <div class="lu-sub">LISTEN<i>話を聞いて</i></div>
    <div class="lu-flash"></div>
  `;
  // 上から並んでいるので、下＝0 になるよう逆に
  const arrows = [...el.querySelectorAll('.lu-arrows svg')].reverse() as SVGElement[];
  const en = el.querySelector('.lu-en') as HTMLElement;
  const flash = el.querySelector('.lu-flash') as HTMLElement;

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
    flash.style.opacity = (t < 90 ? 1 : Math.max(0, 1 - (t - 90) / 430)).toFixed(3);
    const ph = (t % PERIOD_MS) / PERIOD_MS;
    arrows.forEach((a, i) => a.classList.toggle('on', ph >= i * 0.22 && ph < i * 0.22 + 0.42));
    en.classList.toggle('off', ph >= 0.5);
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
