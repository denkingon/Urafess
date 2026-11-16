import type { PermBanner } from '../perms';
import { say, sent, setHTML } from '../ui';

/**
 * アプリ権限の許可のバナー（見た目の層）。参加者の画面で、許可をお願いする板はこの1枚だけ。
 * 入室してすぐ（まだ押していない・確認が出ている間）は、画面全体にかぶせて、ほかの字が見えないようにする。
 * 真ん中に「タップして許可する」の押す形（波紋が広がる点と、光る丸い札）を出し、どこを押してもいい。
 * 1回押すと動き・マイク・位置の確認が順に出る。断られた・マイクが止まったときは、いままでどおり上に小さく出る
 */

export interface PermScreen {
  el: HTMLButtonElement;
  update(banner: PermBanner | null): void;
}

export function createPerm(onTap: () => void): PermScreen {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'perm-ask';
  el.hidden = true;
  el.innerHTML = `<b class="u-ask" data-k="head"></b><span data-k="sub"></span><span class="perm-cta" data-k="cta" hidden><i class="perm-tap" aria-hidden="true"></i><span class="perm-cta-l" data-k="ctaL"></span></span>`;
  const head = el.querySelector('[data-k="head"]') as HTMLElement;
  const sub = el.querySelector('[data-k="sub"]') as HTMLElement;
  const cta = el.querySelector('[data-k="cta"]') as HTMLElement;
  const ctaL = el.querySelector('[data-k="ctaL"]') as HTMLElement;
  // このタップの中で許可を聞く（iPhone はタップの直後でないと聞けないものがある）
  el.addEventListener('click', onTap);
  return {
    el,
    update(banner) {
      if (el.hidden !== !banner) el.hidden = !banner;
      if (!banner) return;
      if (el.dataset.kind !== banner.kind) el.dataset.kind = banner.kind;
      el.classList.toggle('compact', banner.compact);
      if (el.disabled !== !banner.usable) el.disabled = !banner.usable;
      setHTML(head, say(banner.head));
      setHTML(sub, sent(banner.sub));
      // 押す形：最初のお願いのときだけ（画面全体にかぶせているとき）
      const showCta = banner.kind === 'ask';
      if (cta.hidden !== !showCta) cta.hidden = !showCta;
      if (showCta) setHTML(ctaL, say(['タップして許可する', 'TAP TO ALLOW']));
    },
  };
}
