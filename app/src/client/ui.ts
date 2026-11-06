/**
 * 見た目の決め事（参加者の画面）。値はパレット「裏フェス 画面のパレット」の既定（2026-11-06）。
 * https://claude.ai/artifact/2uVdsAzPTMrhuJATQKsznX で決めた値が来たら、ここと player.css の :root を替える。
 */
export const UI = {
  /** いちばん小さい字（スマホの実寸 px）。URAJI は字の背が低い（字の高さ 0.7em）ので、この 1.2 倍を下限にする */
  minText: 16,
  /** 言語：ja＝日本語だけ、ja+en＝日本語＋英語、en＝英語だけ */
  lang: 'ja+en' as 'ja' | 'ja+en' | 'en',
  /** 地に混ぜる役の色（0〜1） */
  tint: 0.12,
  /** ピクトの拍（秒） */
  beat: 0.5,
  /** 人数を印で出す上限（これより多いと数字にする） */
  marksMaxOni: 6,
  marksMaxRunners: 14,
};

/** 裏フェスの色（ピクトのトークンと同じ） */
export const COLOR = {
  yami: '#0b0c10',
  raised: '#181a21',
  sen: '#2b2e38',
  tsuki: '#f1ede4',
  muted: '#a29d93',
  shu: '#ff6a3d',
  chikko: '#b8ff5a',
} as const;

/** 日本語と英語の組 */
export type Pair = readonly [ja: string, en: string];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** 短い言葉。英語は URAJI の大文字 */
export function say([ja, en]: Pair): string {
  if (UI.lang === 'ja' || !en) return `<span class="ja">${esc(ja)}</span>`;
  if (UI.lang === 'en') return `<span class="en u solo">${esc(en)}</span>`;
  return `<span class="ja">${esc(ja)}</span><span class="en u">${esc(en)}</span>`;
}

/** 文。英語はゴシック */
export function sent([ja, en]: Pair): string {
  if (UI.lang === 'ja' || !en) return `<span class="ja">${esc(ja)}</span>`;
  if (UI.lang === 'en') return `<span class="en solo">${esc(en)}</span>`;
  return `<span class="ja">${esc(ja)}</span><span class="en">${esc(en)}</span>`;
}

/** 同じ中身なら書き換えない（毎フレーム呼ばれるため） */
export function setHTML(el: HTMLElement, html: string): void {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** 小さい印（色は currentColor。大きさは CSS で決める） */
export const glyph = {
  /** 追跡者（鬼）：角2本の頭 */
  oni: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g fill="currentColor"><path d="M34 42 L20 6 L47 34 Z"/><path d="M66 42 L80 6 L53 34 Z"/><circle cx="50" cy="61" r="28"/></g></svg>',
  /** 逃走者が捕まった：両手を上げた人 */
  handsUp:
    '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-linecap="round"><circle cx="50" cy="22" r="13" stroke="none"/><rect x="37" y="39" width="26" height="33" rx="7" stroke="none"/><line x1="38" y1="44" x2="20" y2="12" stroke-width="10"/><line x1="62" y1="44" x2="80" y2="12" stroke-width="10"/><line x1="44" y1="72" x2="42" y2="95" stroke-width="10"/><line x1="56" y1="72" x2="58" y2="95" stroke-width="10"/></g></svg>',
  /** 逃走者（一覧の印） */
  runner: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="currentColor"/></svg>',
  mic: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"><rect x="36" y="8" width="28" height="52" rx="14" fill="currentColor" stroke="none"/><path d="M22 46 a28 28 0 0 0 56 0"/><line x1="50" y1="76" x2="50" y2="92"/><line x1="34" y1="92" x2="66" y2="92"/></g></svg>',
  person: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g fill="currentColor"><circle cx="50" cy="30" r="20"/><path d="M14 100 Q14 58 50 58 Q86 58 86 100 Z"/></g></svg>',
  list: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g stroke="currentColor" stroke-width="10" stroke-linecap="round"><line x1="22" y1="30" x2="78" y2="30"/><line x1="22" y1="50" x2="78" y2="50"/><line x1="22" y1="70" x2="78" y2="70"/></g></svg>',
  cross: '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><g stroke="currentColor" stroke-width="11" stroke-linecap="round"><line x1="26" y1="26" x2="74" y2="74"/><line x1="74" y1="26" x2="26" y2="74"/></g></svg>',
  beacon: '<svg class="gl" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#b8ff5a"/></svg>',
  /** 長押しの間の「)))」 */
  waves:
    '<svg class="gl waves" viewBox="0 0 56 80" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"><path d="M16 28 A12 12 0 0 1 16 52"/><path d="M22 16 A24 24 0 0 1 22 64" opacity=".75"/><path d="M28 4 A36 36 0 0 1 28 76" opacity=".5"/></g></svg>',
};
