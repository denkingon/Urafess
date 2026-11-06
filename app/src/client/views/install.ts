/**
 * 置き方の案内（ブラウザで開いた人にだけ出す）。押すものを、押す順に、全部を一度に並べる。
 *
 * 11/6 夜の実機で「すんごいわかりにくい」。前の形（大きな絵を2秒ごとに1手ずつ映す）でつまずいた所を直した：
 * - 勝手に進まない。本物の画面と見比べている間に絵が変わってしまっていた
 * - 一覧はページの上に置く。OS のメニューやシートは下から出て画面の下半分を隠すが、上の一覧は操作の途中も見えたまま
 * - iOS 26 の「その他」の1手を足した（共有シートは最初に4つだけ見せ、「ホーム画面に追加」はその先にある）
 * - 押すものは OS の画面の字と絵で書く。字はスマホの言葉に合わせる（日本語の iPhone なら「共有」、英語なら「Share」）
 * - 手ごとに一言（場所・見つからないとき）を添え、もう一方の言葉でも書く（本人「B かつ英語も入れて」）
 * - 最初に押すボタンは、本物のバーと同じ並びの絵で場所を見せ、本物のボタンを矢印で指す（ずっと出しておく）
 */
import type { InstallPath } from '../install/detect';
import { glyphAt } from '../install/glyphs';
import { scenesFor } from '../install/scenes';
import { guideFor, hintsFor, langOf, type Lang, type Step } from '../install/steps';
import { urajiArrow, urajiDigit } from '../install/uraji';

export interface InstallScreen {
  el: HTMLElement;
  /** Android の Chrome がボタン1つで入れる準備をしたら渡す（null で取り消し） */
  setPrompt(prompt: (() => Promise<boolean>) | null): void;
  /** 入った（Android でボタンから入れた・別の入れ方で入った） */
  done(): void;
  stop(): void;
}

const g = (name: Parameters<typeof glyphAt>[0], size = 28) =>
  `<svg class="gl" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${glyphAt(name, 0, 0, size)}</svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** 押すもの1つを、OS の画面での見た目に似せて描く（字はスマホの言葉） */
function control(s: Step, icon: string, lang: Lang): string {
  const label = s.label ? `<b>${esc(s.label[lang])}</b>` : '';
  switch (s.kind) {
    case 'circle':
      return `<span class="ctl circle">${s.glyph ? g(s.glyph, 32) : ''}</span>`;
    case 'tool':
      return `<span class="ctl tool">${s.glyph ? g(s.glyph, 28) : ''}</span>`;
    case 'menu':
      return `<span class="ctl menu">${s.glyph ? g(s.glyph, 22) : ''}${label}</span>`;
    case 'action':
      return `<span class="ctl action"><span class="disc">${s.glyph ? g(s.glyph, 22) : ''}</span>${label}</span>`;
    case 'row':
      return `<span class="ctl row">${label}${s.glyph ? g(s.glyph, 22) : ''}</span>`;
    case 'pill':
      return `<span class="ctl pill">${label}</span>`;
    case 'icon':
      return `<span class="ctl appicon"><img src="${icon}" alt="" width="40" height="40"></span>`;
  }
}

/** 画面のどこにあるか（小さな電話の縁と、その隅の点） */
const where = (w: Step['where']) => (w ? `<span class="where" data-where="${w}" aria-hidden="true"></span>` : '');

/** 添える一言：スマホの言葉の一言と、もう一方の言葉で「押すものの字＋場所」 */
function hint(s: Step, lang: Lang): string {
  const h = hintsFor(s, lang);
  const main = h.main ? `<span lang="${lang}">${esc(h.main)}</span>` : '';
  const other = h.other ? `<span lang="${h.otherLang}" class="alt">${esc(h.other)}</span>` : '';
  return main || other ? `<span class="hint" aria-hidden="true">${main}${other}</span>` : '';
}

/** 読み上げ用の一言（スマホの言葉で） */
function spoken(s: Step, i: number, lang: Lang): string {
  const what = s.label?.[lang] ?? s.hint[lang];
  const extra = s.label && s.hint[lang] ? `（${s.hint[lang]}）` : '';
  return `${i + 1}. ${what}${extra}`;
}

export function createInstall(opts: {
  path: Exclude<InstallPath, 'installed' | 'desktop'>;
  icon: string;
  onSkip: () => void;
  ua?: string;
  /** 字を出す言葉。省くとスマホの言葉（navigator.language）に合わせる */
  lang?: Lang;
}): InstallScreen {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const lang = opts.lang ?? langOf(nav?.language);
  const other: Lang = lang === 'ja' ? 'en' : 'ja';
  const guide = guideFor(opts.path, opts.ua ?? nav?.userAgent ?? '');
  const top = guide.pointer === 'top-right';
  // 最初に押すボタンのある所：1枚目の場面の、バーのある帯だけを切り出す（本物のバーと同じ並び）
  const crop = top ? '0 0 320 112' : opts.path === 'ios-safari' ? '0 184 320 116' : '0 214 320 86';
  const first = scenesFor(opts.path, opts.icon, 'inst').frames[0].replace('viewBox="0 0 320 300"', `viewBox="${crop}"`);
  const el = document.createElement('main');
  el.className = 'phone install';
  el.dataset.pointer = guide.pointer;
  el.lang = lang;

  const rows = guide.steps
    .map(
      (s, i) =>
        `<li class="st" data-kind="${s.kind}"${s.optional ? ' data-optional=""' : ''} aria-label="${esc(spoken(s, i, lang))}">` +
        `<span class="no" aria-hidden="true">${urajiDigit(i + 1)}</span>` +
        `<span class="what" aria-hidden="true">${control(s, opts.icon, lang)}${where(s.where)}</span>` +
        hint(s, lang) +
        `</li>`,
    )
    .join('');
  const bar = `<div class="bar-pic" aria-hidden="true">${first}</div>`;
  el.innerHTML = `
    <button type="button" class="skip" aria-label="${lang === 'ja' ? '置かずに、このままブラウザで開く' : 'Skip and continue in the browser'}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    ${top ? bar : ''}
    <header class="ttl"><img src="${opts.icon}" alt="" width="40" height="40"><div><h1>${esc(guide.title[lang])}</h1><span class="sub" lang="${other}">${esc(guide.title[other])}</span></div></header>
    <ol class="list">${rows}</ol>
    <section class="one" hidden>
      <button type="button" class="one-tap" aria-label="${esc(guide.title[lang])}"><img src="${opts.icon}" alt="" width="52" height="52"><span class="arrow">${urajiArrow('down')}</span></button>
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
