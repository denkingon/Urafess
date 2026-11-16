import type { PermBanner } from '../perms';
import { say, sent, setHTML } from '../ui';

/**
 * スマホの許可のバナー（見た目の層）。参加者の画面で、許可をお願いする板はこの1枚だけ。
 * 入室してすぐに出て、1回押すと動き・マイク・位置の確認が順に出る。断られた・マイクが止まったときも、同じ場所に小さく出る
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
  el.innerHTML = `<b class="u-ask" data-k="head"></b><span data-k="sub"></span>`;
  const head = el.querySelector('[data-k="head"]') as HTMLElement;
  const sub = el.querySelector('[data-k="sub"]') as HTMLElement;
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
    },
  };
}
