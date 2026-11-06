/**
 * 置き方の案内（ブラウザで開いた人にだけ出す）。
 *
 * - 押す人の画面を大きく描いた場面を、1手ずつ順に映す（4拍＝2秒ごとに次の場面。最後まで行ったら最初から）
 * - 下の数字（URAJI）を押すと、その場面で止まる。もう一度押すと、また流れる
 * - 最初に押すボタンは、本物の画面の端（Safari のバーのある所など）をページの端から矢印で指す
 * - 絵は、OS のメニューやシートが出ても隠れない側に置く（下から出るなら上、上から出るなら下）
 * - 動きを減らす設定の人には、流さずに1手目で止めておく（数字で送る）
 */
import type { InstallPath } from '../install/detect';
import { scenesFor } from '../install/scenes';
import { urajiArrow, urajiDigit } from '../install/uraji';

export interface InstallScreen {
  el: HTMLElement;
  /** Android の Chrome がボタン1つで入れる準備をしたら渡す（null で取り消し） */
  setPrompt(prompt: (() => Promise<boolean>) | null): void;
  /** 入った（Android でボタンから入れた・別の入れ方で入った） */
  done(): void;
  stop(): void;
}

const STEP_MS = 2000;

export function createInstall(opts: {
  path: Exclude<InstallPath, 'installed' | 'desktop'>;
  icon: string;
  onSkip: () => void;
}): InstallScreen {
  const sc = scenesFor(opts.path, opts.icon, 'inst');
  const el = document.createElement('main');
  el.className = 'phone install';
  el.dataset.stage = sc.stage;
  el.dataset.pointer = sc.pointer;

  const nav = sc.frames
    .map((_, i) => `<button type="button" class="step" data-i="${i}" aria-label="${i + 1}手目">${urajiDigit(i + 1)}</button>`)
    .join('');
  el.innerHTML = `
    <button type="button" class="skip" aria-label="このままブラウザで開く"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <section class="movie">
      <div class="screens">${sc.frames.join('')}</div>
      <nav class="steps">${nav}</nav>
    </section>
    <section class="one">
      <button type="button" class="one-tap" aria-label="ホーム画面に追加"><img src="${opts.icon}" alt="" width="52" height="52"><span class="arrow">${urajiArrow('down')}</span></button>
    </section>
    <div class="pointer" aria-hidden="true">${urajiArrow('down')}</div>
  `;
  const frames = Array.from(el.querySelectorAll<SVGElement>('.screens .frame'));
  const steps = Array.from(el.querySelectorAll<HTMLButtonElement>('.steps .step'));
  const one = el.querySelector('.one') as HTMLElement;
  const oneTap = el.querySelector('.one-tap') as HTMLButtonElement;
  one.hidden = true;
  el.querySelector('.skip')!.addEventListener('click', opts.onSkip);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let now = 0;
  let playing = !reduce;
  let timer: number | undefined;

  function show(i: number): void {
    now = i;
    frames.forEach((f, k) => f.classList.toggle('now', k === i));
    steps.forEach((s, k) => {
      s.classList.toggle('now', k === i);
      s.setAttribute('aria-pressed', String(k === i && !playing));
    });
    // 本物のボタンを指す矢印は、1手目を映している間だけ
    el.classList.toggle('first', i === 0);
  }
  function play(): void {
    window.clearInterval(timer);
    timer = undefined;
    if (!playing || frames.length < 2) return;
    timer = window.setInterval(() => show((now + 1) % frames.length), STEP_MS);
  }
  steps.forEach((s, i) =>
    s.addEventListener('click', () => {
      // 映っている場面の数字を押すと流す／止めるが切り替わる。別の数字なら、そこへ飛んで止まる
      playing = i === now ? !playing : false;
      show(i);
      play();
    }),
  );
  show(0);
  play();

  let prompt: (() => Promise<boolean>) | null = null;
  oneTap.addEventListener('click', async () => {
    if (!prompt) return;
    oneTap.disabled = true;
    const ok = await prompt().catch(() => false);
    oneTap.disabled = false;
    if (ok) done();
  });

  /** 入った。あとはホーム画面のアイコンから開くだけ（最後の場面で止める） */
  function done(): void {
    prompt = null;
    one.hidden = true;
    el.querySelector<HTMLElement>('.movie')!.hidden = false;
    el.classList.add('installed');
    playing = false;
    show(frames.length - 1);
    play();
  }

  return {
    el,
    setPrompt(p) {
      prompt = p;
      // ボタン1つで入れられるなら、場面の代わりにボタンだけを出す
      one.hidden = !p;
      el.querySelector<HTMLElement>('.movie')!.hidden = !!p;
      el.classList.toggle('prompt', !!p);
    },
    done,
    stop() {
      window.clearInterval(timer);
      timer = undefined;
    },
  };
}
