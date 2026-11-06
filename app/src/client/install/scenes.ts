/**
 * 置き方の案内の「場面」。押す人の画面を大きく描き、その場面で押す1か所に輪を出す。
 *
 * - 場面はすべて同じ部品（電話の縁・ページ・バー・メニュー・シート・ホーム画面・押す輪）の組み合わせで描く
 * - OS の文字は、押すところの1語だけ書く（押す人が自分の画面で同じ字を探せるように）。ほかの行は灰色の棒
 * - 電話は、操作が起きる側（下のバー・下からのシートなら下、上のバー・メニューなら上）だけを切り取って見せる
 */
import type { InstallPath } from './detect';
import { glyphAt, type GlyphName } from './glyphs';

const W = 320, H = 300;
type Side = 'top' | 'bottom';

export interface Scenes {
  /** 1手ずつの場面（SVG） */
  frames: string[];
  /** 本物の画面で、最初に押すボタンのある所（案内のページの端から矢印で指す） */
  pointer: 'bottom-right' | 'bottom-center' | 'top-right';
  /** 案内の絵を置く側（OS のメニューやシートに隠れない側） */
  stage: Side;
}

// ---------- 部品 ----------

const bar = (x: number, y: number, w: number, h = 9, cls = 'faint') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
const label = (x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'start', cls = 'lbl') =>
  `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central">${text}</text>`;
/** 押すところ。止まった輪と、そこから広がる輪（押す物そのものは隠さない） */
const tap = (x: number, y: number, r = 22) =>
  `<circle class="tap" cx="${x}" cy="${y}" r="${r}"/><circle class="ring" cx="${x}" cy="${y}" r="${r}"/>`;
/** 字のボタンを押すところ（字を囲む角丸の輪） */
const tapBox = (x: number, y: number, w: number, h: number) => {
  const a = `x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"`;
  return `<rect class="tap" ${a}/><rect class="ring" ${a}/>`;
};

/** 電話の縁。side の側だけを見せる */
function phone(id: string, side: Side, inner: string): string {
  const y = side === 'bottom' ? -64 : 12, h = 352;
  const body = `x="18" y="${y}" width="284" height="${h}" rx="40"`;
  return `<svg class="frame" viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
    `<defs><clipPath id="${id}"><rect ${body}/></clipPath></defs>` +
    `<rect class="scr" ${body}/><g clip-path="url(#${id})">${inner}</g>` +
    `<rect ${body} fill="none" stroke="currentColor" stroke-width="3"/></svg>`;
}

/** ページの中身（ぼんやり） */
function page(side: Side): string {
  const y0 = side === 'bottom' ? 24 : 104;
  return [0, 1, 2, 3].map((i) => bar(44, y0 + i * 30, i % 2 ? 150 : 210)).join('');
}

/** 少し暗くする（メニューやシートの後ろ） */
const scrim = '<rect class="scrim" x="0" y="0" width="320" height="300"/>';

/** iPhone Safari 26（標準のまとまった並べ方）：下に ‹ ・アドレス・••• */
function safari26Bar(hi: boolean): string {
  return `<circle class="chip" cx="50" cy="256" r="17"/>${glyphAt('back', 40, 246, 20, 'quiet')}` +
    `<rect class="chip" x="76" y="239" width="170" height="34" rx="17"/>${bar(120, 252, 82, 8)}` +
    `<circle class="chip" cx="270" cy="256" r="17"/>${glyphAt('more', 253, 239, 34)}` +
    (hi ? tap(270, 256) : '');
}

/** iPhone Safari 18（下の並べ方）：アドレスと、‹ › 共有 本 タブ */
function safari18Bar(hi: boolean): string {
  const icons: GlyphName[] = ['back', 'forward', 'share', 'book', 'tabs'];
  return `<rect class="chip" x="44" y="190" width="232" height="32" rx="10"/>${bar(118, 202, 84, 8)}` +
    `<rect class="barbg" x="0" y="232" width="320" height="70"/>` +
    icons.map((g, i) => glyphAt(g, 42 + i * 52, 242, 28, g === 'share' ? '' : 'quiet')).join('') +
    (hi ? tap(160, 256) : '');
}

/** 上のバー（iPhone の Chrome・Android の Chrome・アプリの中のブラウザ） */
function topBar(kind: 'share' | 'kebab' | 'dots', hi: boolean): string {
  const left = kind === 'dots' ? glyphAt('close', 34, 54, 24, 'quiet') : '';
  const x0 = kind === 'dots' ? 70 : 36;
  const right: GlyphName = kind;
  return `<rect class="barbg" x="0" y="12" width="320" height="86"/>` + left +
    `<rect class="chip" x="${x0}" y="50" width="${240 - x0}" height="32" rx="16"/>${bar(x0 + 30, 62, 120, 8)}` +
    glyphAt(right, 254, 50, 32) + (hi ? tap(270, 66) : '');
}

/** メニュー（開いた先の1行だけ字を書く） */
function menu(x: number, y: number, w: number, rows: number, hiRow: number, glyph: GlyphName, text: string): string {
  const rh = 36;
  let s = `<rect class="pop" x="${x}" y="${y}" width="${w}" height="${rows * rh + 12}" rx="14"/>`;
  for (let i = 0; i < rows; i++) {
    const ry = y + 6 + i * rh;
    if (i === hiRow) {
      s += `<rect class="hirow" x="${x + 6}" y="${ry}" width="${w - 12}" height="${rh}" rx="9"/>` +
        glyphAt(glyph, x + 14, ry + 7, 22) + label(x + 54, ry + rh / 2, text) + tap(x + 25, ry + rh / 2, 19);
    } else {
      s += `<circle class="faint" cx="${x + 25}" cy="${ry + rh / 2}" r="7"/>${bar(x + 46, ry + rh / 2 - 4, w * 0.45, 8)}`;
    }
  }
  return s;
}

/** iPhone の共有シート（下から出る）。「ホーム画面に追加」の行を押す */
function shareSheet(): string {
  const apps = [56, 108, 160, 212, 264].map((x) => `<circle class="faint" cx="${x}" cy="110" r="18"/>`).join('');
  const rowY = (i: number) => 140 + i * 38;
  let rows = `<rect class="group" x="32" y="140" width="256" height="170" rx="12"/>`;
  for (const i of [0, 1, 3]) rows += bar(48, rowY(i) + 15, 110, 8) + `<rect class="faint" x="252" y="${rowY(i) + 10}" width="18" height="18" rx="4"/>`;
  rows += `<rect class="hirow" x="32" y="${rowY(2)}" width="256" height="38"/>` + label(48, rowY(2) + 19, 'ホーム画面に追加') +
    glyphAt('addHome', 248, rowY(2) + 7, 24) + tap(260, rowY(2) + 19, 20);
  return scrim + `<rect class="sheet" x="18" y="28" width="284" height="300" rx="24"/>${bar(140, 36, 40, 5)}` +
    `<rect class="faint" x="36" y="50" width="34" height="34" rx="8"/>${bar(82, 56, 120, 8)}${bar(82, 72, 80, 7)}` + apps + rows;
}

/** iPhone の「ホーム画面に追加」の画面。右上の「追加」を押す */
function addSheet(icon: string, toggle: boolean): string {
  return scrim + `<rect class="sheet" x="18" y="14" width="284" height="320" rx="24"/>` +
    `<circle class="chip" cx="50" cy="44" r="16"/>${glyphAt('close', 40, 34, 20, 'quiet')}${bar(126, 40, 70, 8)}` +
    `<rect class="hipill" x="234" y="28" width="56" height="32" rx="16"/>` + label(262, 44, '追加', 'middle', 'lbl on') + tapBox(229, 24, 66, 40) +
    `<rect class="group" x="32" y="78" width="256" height="76" rx="12"/>` +
    `<image href="${icon}" x="44" y="88" width="56" height="56" style="clip-path:inset(0 round 13px)"/>` + label(114, 116, 'Urafess', 'start', 'lbl quiet') +
    (toggle
      ? `<rect class="group" x="32" y="166" width="256" height="46" rx="12"/>${bar(48, 185, 120, 8)}` +
        `<rect class="tog" x="232" y="176" width="44" height="26" rx="13"/><circle class="scr" cx="263" cy="189" r="10"/>`
      : '');
}

/** ホーム画面。置いたアイコンを押す */
function home(icon: string): string {
  let s = '';
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const x = 40 + c * 64, y = 20 + r * 56;
    if (r === 2 && c === 1) {
      s += `<image href="${icon}" x="${x}" y="${y}" width="44" height="44" style="clip-path:inset(0 round 10px)"/>` + tap(x + 22, y + 22, 30);
    } else s += `<rect class="faint" x="${x}" y="${y}" width="44" height="44" rx="10"/>`;
  }
  return s + `<rect class="chip" x="30" y="244" width="260" height="62" rx="22"/>` +
    [52, 116, 180, 244].map((x) => `<rect class="faint" x="${x}" y="254" width="40" height="40" rx="10"/>`).join('');
}

/** Android の「インストール」の確かめの窓 */
function androidDialog(icon: string): string {
  return scrim + `<rect class="pop" x="40" y="118" width="240" height="150" rx="20"/>` +
    `<image href="${icon}" x="60" y="138" width="44" height="44" style="clip-path:inset(0 round 10px)"/>` + label(116, 160, 'Urafess', 'start', 'lbl quiet') +
    bar(80, 238, 56, 8) + label(258, 242, 'インストール', 'end') + tapBox(152, 222, 118, 40);
}

// ---------- 道ごとの場面 ----------

export function scenesFor(path: Exclude<InstallPath, 'installed' | 'desktop'>, icon: string, id = 'scene'): Scenes {
  let n = 0;
  const f = (side: Side, inner: string) => phone(`${id}-${n++}`, side, inner);
  switch (path) {
    case 'ios-safari-26':
      return {
        pointer: 'bottom-right', stage: 'top',
        frames: [
          f('bottom', page('bottom') + safari26Bar(true)),
          f('bottom', page('bottom') + safari26Bar(false) + menu(110, 54, 184, 5, 0, 'share', '共有')),
          f('bottom', page('bottom') + shareSheet()),
          f('bottom', addSheet(icon, true)),
          f('bottom', home(icon)),
        ],
      };
    case 'ios-safari':
      return {
        pointer: 'bottom-center', stage: 'top',
        frames: [
          f('bottom', page('bottom') + safari18Bar(true)),
          f('bottom', page('bottom') + shareSheet()),
          f('bottom', addSheet(icon, false)),
          f('bottom', home(icon)),
        ],
      };
    case 'ios-other':
      return {
        pointer: 'top-right', stage: 'top',
        frames: [
          f('top', page('top') + topBar('share', true)),
          f('bottom', page('bottom') + shareSheet()),
          f('bottom', addSheet(icon, false)),
          f('bottom', home(icon)),
        ],
      };
    case 'android':
      return {
        pointer: 'top-right', stage: 'bottom',
        frames: [
          f('top', page('top') + topBar('kebab', true)),
          f('top', page('top') + topBar('kebab', false) + menu(78, 40, 218, 6, 3, 'install', 'アプリをインストール')),
          f('top', page('top') + topBar('kebab', false) + androidDialog(icon)),
          f('bottom', home(icon)),
        ],
      };
    case 'inapp':
    case 'line':
      return {
        pointer: 'top-right', stage: 'bottom',
        frames: [
          f('top', page('top') + topBar('dots', true)),
          f('top', page('top') + topBar('dots', false) + menu(96, 86, 198, 5, 1, 'browser', 'ブラウザで開く')),
        ],
      };
  }
}
