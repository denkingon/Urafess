/**
 * OS のボタンの絵（共有・ホーム画面に追加・••• など）。押す人が自分の画面で見るものに似せて、線で描く。
 * 中身は 48×48 の枠。場面の絵（scenes.ts）の中に、置きたい位置と大きさで埋め込む。
 */

const dot = (cx: number, cy: number, r = 3.4) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

const INNER = {
  /** iPhone Safari 26 の「•••」 */
  more: `<circle cx="24" cy="24" r="19"/>${dot(15, 24, 2.6)}${dot(24, 24, 2.6)}${dot(33, 24, 2.6)}`,
  /** 共有（四角から上へ抜ける矢印） */
  share: '<path d="M17 19h-5v24h24V19h-5"/><path d="M24 5v24"/><path d="M16.5 12.5 24 5l7.5 7.5"/>',
  /** ホーム画面に追加（角丸の四角に＋） */
  addHome: '<rect x="7" y="7" width="34" height="34" rx="8"/><path d="M24 16v16M16 24h16"/>',
  /** Android の「⋮」 */
  kebab: `${dot(24, 10)}${dot(24, 24)}${dot(24, 38)}`,
  /** Android の「アプリをインストール」（電話に下向きの矢印） */
  install: '<rect x="13" y="4" width="22" height="40" rx="5"/><path d="M24 14v15"/><path d="M18 23.5 24 29.5l6-6"/>',
  /** ブラウザで開く（羅針盤） */
  browser: '<circle cx="24" cy="24" r="19"/><path d="m31 17-4.6 9.4L17 31l4.6-9.4Z" fill="currentColor"/>',
  /** アプリの中のブラウザのメニュー（横の点3つ） */
  dots: `${dot(10, 24)}${dot(24, 24)}${dot(38, 24)}`,
  /** 戻る（‹） */
  back: '<path d="M29 10 15 24l14 14"/>',
  /** 進む（›） */
  forward: '<path d="M19 10l14 14-14 14"/>',
  /** ブックマーク（開いた本） */
  book: '<path d="M24 13c-4-3-10-4-16-3v26c6-1 12 0 16 3 4-3 10-4 16-3V10c-6-1-12 0-16 3Z"/><path d="M24 13v26"/>',
  /** タブ（重なった四角） */
  tabs: '<rect x="8" y="14" width="26" height="26" rx="5"/><path d="M15 8h20a5 5 0 0 1 5 5v20"/>',
  /** 閉じる（×） */
  close: '<path d="M14 14l20 20M34 14 14 34"/>',
} as const;

export type GlyphName = keyof typeof INNER;

/** 場面の絵の中に置く（x, y は左上、s は一辺） */
export function glyphAt(name: GlyphName, x: number, y: number, s: number, cls = ''): string {
  return `<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="0 0 48 48"${cls ? ` class="${cls}"` : ''} fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${INNER[name]}</svg>`;
}
