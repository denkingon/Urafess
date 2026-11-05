/**
 * 置き方の案内（ブラウザで開いた人にだけ出す）。言葉を使わず、数字（URAJI）・押す場所・ボタンの絵だけで見せる。
 * 押す場所の点は、1つずつ順に光る（動くのは同時に1つ）。動きを減らす設定の人には、全部の点を止めて見せる。
 */
import type { InstallPath } from '../install/detect';
import { OS, phone, type Spot } from '../install/glyphs';
import { urajiArrow, urajiDigit } from '../install/uraji';

type Glyph = keyof typeof OS | 'icon' | 'scroll';
interface Step { spot: Spot; glyphs: Glyph[] }

const STEPS: Record<Exclude<InstallPath, 'installed' | 'desktop'>, Step[]> = {
  'ios-safari-26': [
    { spot: 'bottom-right', glyphs: ['more'] },
    { spot: 'menu-low', glyphs: ['share'] },
    { spot: 'sheet', glyphs: ['scroll', 'addHome'] },
    { spot: 'top-right', glyphs: ['toggleOn'] },
    { spot: 'home', glyphs: ['icon'] },
  ],
  'ios-safari': [
    { spot: 'bottom-center', glyphs: ['share'] },
    { spot: 'sheet', glyphs: ['scroll', 'addHome'] },
    { spot: 'top-right', glyphs: ['icon'] },
    { spot: 'home', glyphs: ['icon'] },
  ],
  'ios-other': [
    { spot: 'top-right', glyphs: ['share'] },
    { spot: 'sheet', glyphs: ['scroll', 'addHome'] },
    { spot: 'top-right', glyphs: ['icon'] },
    { spot: 'home', glyphs: ['icon'] },
  ],
  android: [
    { spot: 'top-right', glyphs: ['kebab'] },
    { spot: 'menu-high', glyphs: ['install'] },
    { spot: 'dialog', glyphs: ['icon'] },
    { spot: 'home', glyphs: ['icon'] },
  ],
  // アプリの中のブラウザ：右上のメニューから、ふだんのブラウザで開き直す（開き直した先で、その端末の案内が出る）
  inapp: [
    { spot: 'top-right', glyphs: ['dots'] },
    { spot: 'menu-high', glyphs: ['browser'] },
  ],
  line: [
    { spot: 'top-right', glyphs: ['dots'] },
    { spot: 'menu-high', glyphs: ['browser'] },
  ],
};

export interface InstallScreen {
  el: HTMLElement;
  /** Android の Chrome がボタン1つで入れる準備をしたら渡す（null で取り消し） */
  setPrompt(prompt: (() => Promise<boolean>) | null): void;
  /** 入った（Android でボタンから入れた・別の入れ方で入った） */
  done(): void;
  stop(): void;
}

export function createInstall(opts: {
  path: Exclude<InstallPath, 'installed' | 'desktop'>;
  icon: string;
  onSkip: () => void;
}): InstallScreen {
  const el = document.createElement('main');
  el.className = 'phone install';
  const iconImg = (cls: string) => `<img class="${cls}" src="${opts.icon}" alt="" width="48" height="48">`;
  const glyph = (g: Glyph) =>
    g === 'icon' ? iconImg('app') : g === 'scroll' ? `<span class="scroll">${urajiArrow('down')}</span>` : OS[g];
  const rows = (steps: Step[]) =>
    steps
      .map((s, i) => `<li class="row"><span class="num">${urajiDigit(i + 1)}</span>${phone(s.spot, opts.icon)}<span class="glyphs">${s.glyphs.map(glyph).join('')}</span></li>`)
      .join('');

  el.innerHTML = `
    <button type="button" class="skip" aria-label="このままブラウザで開く">${xMark()}</button>
    <div class="target">${iconImg('big')}</div>
    <ol class="steps">${rows(STEPS[opts.path])}</ol>
    <button type="button" class="one-tap" hidden aria-label="ホーム画面に追加">${iconImg('app')}<span class="arrow">${urajiArrow('down')}</span></button>
  `;
  const list = el.querySelector('.steps') as HTMLElement;
  const oneTap = el.querySelector('.one-tap') as HTMLButtonElement;
  el.querySelector('.skip')!.addEventListener('click', opts.onSkip);

  // 点を1つずつ順に光らせる（2拍＝1秒ごと）
  const items = Array.from(el.querySelectorAll<HTMLElement>('.row'));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let now = 0;
  let timer: number | undefined;
  const mark = () => items.forEach((li, i) => li.classList.toggle('now', reduce || i === now));
  mark();
  if (!reduce && items.length > 1) {
    timer = window.setInterval(() => {
      now = (now + 1) % items.length;
      mark();
    }, 1000);
  }

  let prompt: (() => Promise<boolean>) | null = null;
  oneTap.addEventListener('click', async () => {
    if (!prompt) return;
    oneTap.disabled = true;
    const ok = await prompt().catch(() => false);
    oneTap.disabled = false;
    if (ok) done();
  });

  /** 入った。あとはホーム画面のアイコンから開くだけ */
  function done(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    prompt = null;
    list.innerHTML = rows([{ spot: 'home', glyphs: ['icon'] }]);
    list.querySelector('.row')?.classList.add('now');
    list.hidden = false;
    oneTap.hidden = true;
  }

  return {
    el,
    setPrompt(p) {
      prompt = p;
      // ボタン1つで入れられるなら、手順の代わりにボタンを出す
      oneTap.hidden = !p;
      list.hidden = !!p;
    },
    done,
    stop() {
      if (timer !== undefined) window.clearInterval(timer);
    },
  };
}

function xMark(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
}
