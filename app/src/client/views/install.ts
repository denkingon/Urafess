/**
 * 置き方の案内（ブラウザで開いた人にだけ出す）。押すものを、押す順に、全部を一度に並べる。
 *
 * 11/6 夜の実機で「すんごいわかりにくい」。前の形（大きな絵を2秒ごとに1手ずつ映す）でつまずいた所を直した：
 * - 勝手に進まない。本物の画面と見比べている間に絵が変わってしまっていた
 * - 一覧はページの上に置く。OS のメニューやシートは下から出て画面の下半分を隠すが、上の一覧は操作の途中も見えたまま
 * - iOS 26 の「その他」の1手を足した（共有シートは最初に4つだけ見せ、「ホーム画面に追加」はその先にある）
 * - 押すものは OS の画面の字と絵で書く（共有・その他・ホーム画面に追加・追加）。自分の画面で同じ字を探せるように
 * - 最初に押すボタンは、本物のバーと同じ並びの絵で場所を見せ、本物のボタンを矢印で指す（ずっと出しておく）
 * - 題は OS の字（「ホーム画面に追加」など）とアイコン。自分たちの言葉は足さない。
 *   言葉を添える案（WORDS）は、手ごとに一言（右下の ••• など）を足す
 */
import type { InstallPath } from '../install/detect';
import { glyphAt } from '../install/glyphs';
import { scenesFor } from '../install/scenes';
import { guideFor, type Step } from '../install/steps';
import { urajiArrow, urajiDigit } from '../install/uraji';

export interface InstallScreen {
  el: HTMLElement;
  /** Android の Chrome がボタン1つで入れる準備をしたら渡す（null で取り消し） */
  setPrompt(prompt: (() => Promise<boolean>) | null): void;
  /** 入った（Android でボタンから入れた・別の入れ方で入った） */
  done(): void;
  stop(): void;
}

/** 手ごとに一言を添えるか（本人が選ぶ。添えないときも OS の字は出す） */
export const WORDS = false;

const g = (name: Parameters<typeof glyphAt>[0], size = 28) =>
  `<svg class="gl" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${glyphAt(name, 0, 0, size)}</svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** 押すもの1つを、OS の画面での見た目に似せて描く */
function control(s: Step, icon: string): string {
  const label = s.label ? `<b>${esc(s.label)}</b>` : '';
  switch (s.kind) {
    case 'circle':
      return `<span class="ctl circle">${s.glyph ? g(s.glyph, 34) : ''}</span>`;
    case 'tool':
      return `<span class="ctl tool">${s.glyph ? g(s.glyph, 30) : ''}</span>`;
    case 'menu':
      return `<span class="ctl menu">${s.glyph ? g(s.glyph, 24) : ''}${label}</span>`;
    case 'action':
      return `<span class="ctl action"><span class="disc">${s.glyph ? g(s.glyph, 24) : ''}</span>${label}</span>`;
    case 'row':
      return `<span class="ctl row">${label}${s.glyph ? g(s.glyph, 24) : ''}</span>`;
    case 'pill':
      return `<span class="ctl pill">${label}</span>`;
    case 'icon':
      return `<span class="ctl appicon"><img src="${icon}" alt="" width="44" height="44"></span>`;
  }
}

/** 画面のどこにあるか（小さな電話の縁と、その隅の点） */
const where = (w: Step['where']) => (w ? `<span class="where" data-where="${w}" aria-hidden="true"></span>` : '');

/** 読み上げ用の一言（画面には出さない） */
function spoken(s: Step, i: number): string {
  const what = s.label ?? (s.kind === 'icon' ? 'ホーム画面のアイコン' : s.hint);
  return `${i + 1}. ${what}${s.optional ? '（出たときだけ）' : ''}`;
}

export function createInstall(opts: {
  path: Exclude<InstallPath, 'installed' | 'desktop'>;
  icon: string;
  onSkip: () => void;
  ua?: string;
}): InstallScreen {
  const guide = guideFor(opts.path, opts.ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent));
  const top = guide.pointer === 'top-right';
  // 最初に押すボタンのある所：1枚目の場面の、バーのある帯だけを切り出す（本物のバーと同じ並び）
  const first = scenesFor(opts.path, opts.icon, 'inst').frames[0].replace('viewBox="0 0 320 300"', `viewBox="${top ? '0 0 320 112' : '0 188 320 112'}"`);
  const el = document.createElement('main');
  el.className = 'phone install';
  el.dataset.pointer = guide.pointer;
  el.dataset.words = WORDS ? 'on' : 'off';

  const rows = guide.steps
    .map(
      (s, i) =>
        `<li class="st" data-kind="${s.kind}"${s.optional ? ' data-optional=""' : ''} aria-label="${esc(spoken(s, i))}">` +
        `<span class="no" aria-hidden="true">${urajiDigit(i + 1)}</span>` +
        `<span class="what" aria-hidden="true">${control(s, opts.icon)}${where(s.where)}</span>` +
        (s.hint ? `<span class="hint" aria-hidden="true">${esc(s.hint)}</span>` : '') +
        `</li>`,
    )
    .join('');
  const bar = `<div class="bar-pic" aria-hidden="true">${first}</div>`;
  el.innerHTML = `
    <button type="button" class="skip" aria-label="置かずに、このままブラウザで開く"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    ${top ? bar : ''}
    <header class="ttl"><img src="${opts.icon}" alt="" width="40" height="40"><h1>${esc(guide.title)}</h1></header>
    <ol class="list">${rows}</ol>
    <section class="one" hidden>
      <button type="button" class="one-tap" aria-label="${esc(guide.title)}"><img src="${opts.icon}" alt="" width="52" height="52"><span class="arrow">${urajiArrow('down')}</span></button>
    </section>
    <div class="spacer"></div>
    ${top ? '' : bar}
    <div class="pointer" aria-hidden="true">${urajiArrow('down')}</div>
  `;
  const list = el.querySelector('.list') as HTMLElement;
  const one = el.querySelector('.one') as HTMLElement;
  const oneTap = el.querySelector('.one-tap') as HTMLButtonElement;
  const barPic = el.querySelector('.bar-pic') as HTMLElement;
  el.querySelector('.skip')!.addEventListener('click', opts.onSkip);

  let prompt: (() => Promise<boolean>) | null = null;
  oneTap.addEventListener('click', async () => {
    if (!prompt) return;
    oneTap.disabled = true;
    const ok = await prompt().catch(() => false);
    oneTap.disabled = false;
    if (ok) done();
  });

  /** 入った。あとはホーム画面のアイコンから開くだけ（最後の手だけを明るく） */
  function done(): void {
    prompt = null;
    one.hidden = true;
    list.hidden = false;
    barPic.hidden = true;
    el.classList.remove('prompt');
    el.classList.add('installed');
  }

  return {
    el,
    setPrompt(p) {
      prompt = p;
      // ボタン1つで入れられるなら、手順の代わりにボタンだけを出す
      one.hidden = !p;
      list.hidden = !!p;
      barPic.hidden = !!p;
      el.classList.toggle('prompt', !!p);
    },
    done,
    stop() {
      // 動いているものは無い（勝手に進む絵をやめた）
    },
  };
}
