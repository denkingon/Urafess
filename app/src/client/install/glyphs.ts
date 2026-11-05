/**
 * 置き方の案内に出す絵。言葉は使わない。
 * - OS のボタンの絵（共有・ホーム画面に追加・••• など）は、押す人が画面で見るものに似せて線で描く
 * - 小さい電話の絵は「どこを押すか」。押す場所に点を打つ
 */

const svg = (inner: string, box = '0 0 48 48', cls = 'g') =>
  `<svg class="${cls}" viewBox="${box}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

/** OS のボタン */
export const OS = {
  /** iPhone Safari 26 の「•••」 */
  more: svg('<circle cx="24" cy="24" r="19"/><circle cx="15" cy="24" r="2.6" fill="currentColor" stroke="none"/><circle cx="24" cy="24" r="2.6" fill="currentColor" stroke="none"/><circle cx="33" cy="24" r="2.6" fill="currentColor" stroke="none"/>'),
  /** 共有（四角から上へ抜ける矢印） */
  share: svg('<path d="M17 19h-5v24h24V19h-5"/><path d="M24 5v24"/><path d="M16.5 12.5 24 5l7.5 7.5"/>'),
  /** ホーム画面に追加（角丸の四角に＋） */
  addHome: svg('<rect x="7" y="7" width="34" height="34" rx="8"/><path d="M24 16v16M16 24h16"/>'),
  /** 「Web アプリとして開く」が入っている（スイッチが右） */
  toggleOn: svg('<rect x="4" y="13" width="40" height="22" rx="11" fill="currentColor"/><circle cx="33" cy="24" r="8" fill="var(--bg)" stroke="none"/>'),
  /** Android の「⋮」 */
  kebab: svg('<circle cx="24" cy="10" r="3.4" fill="currentColor" stroke="none"/><circle cx="24" cy="24" r="3.4" fill="currentColor" stroke="none"/><circle cx="24" cy="38" r="3.4" fill="currentColor" stroke="none"/>'),
  /** Android の「アプリをインストール／ホーム画面に追加」（電話に下向きの矢印） */
  install: svg('<rect x="13" y="4" width="22" height="40" rx="5"/><path d="M24 14v15"/><path d="M18 23.5 24 29.5l6-6"/>'),
  /** ブラウザで開く（羅針盤） */
  browser: svg('<circle cx="24" cy="24" r="19"/><path d="m31 17-4.6 9.4L17 31l4.6-9.4Z" fill="currentColor"/>'),
  /** 「•••」だけのアプリ内ブラウザのメニュー（横の点3つ） */
  dots: svg('<circle cx="10" cy="24" r="3.4" fill="currentColor" stroke="none"/><circle cx="24" cy="24" r="3.4" fill="currentColor" stroke="none"/><circle cx="38" cy="24" r="3.4" fill="currentColor" stroke="none"/>'),
};

/** 押す場所。電話の絵の中の点の位置と、そのときに出ている面（バー・メニュー・下からのシート） */
export type Spot =
  | 'bottom-right' // 下のバーの右（Safari 26 の •••）
  | 'bottom-center' // 下のバーの真ん中（Safari 18 の共有）
  | 'menu-low' // 右下に開いたメニューの中
  | 'sheet' // 下から出たシートの下の方（少し下へ送ると出てくる）
  | 'top-right' // 上の右（追加・共有・⋮）
  | 'menu-high' // 右上に開いたメニューの中
  | 'dialog' // 真ん中に出た確かめの窓の右下
  | 'home'; // ホーム画面のアイコン

/** 小さい電話の絵。点 = 押す場所 */
export function phone(spot: Spot, icon: string): string {
  const W = 40, H = 72;
  const face = '<rect x="1.5" y="1.5" width="37" height="69" rx="7" fill="none" stroke="currentColor" stroke-width="2.4"/>';
  const faint = 'class="faint" fill="currentColor"';
  let ctx = '';
  let dot: [number, number] = [20, 36];
  // home のときだけ点を打たず、アイコンを枠で囲む
  switch (spot) {
    case 'bottom-right':
      ctx = `<rect x="6" y="58" width="22" height="7" rx="3.5" ${faint}/>`;
      dot = [32, 61.5];
      break;
    case 'bottom-center':
      ctx = `<rect x="5" y="58" width="30" height="7" rx="2" ${faint}/>`;
      dot = [20, 61.5];
      break;
    case 'menu-low':
      ctx = `<rect x="15" y="30" width="20" height="26" rx="3" ${faint}/>`;
      dot = [25, 50];
      break;
    case 'sheet':
      ctx = `<rect x="3" y="28" width="34" height="41" rx="5" ${faint}/>`;
      dot = [20, 56];
      break;
    case 'top-right':
      ctx = `<rect x="5" y="7" width="30" height="7" rx="2" ${faint}/>`;
      dot = [31, 10.5];
      break;
    case 'menu-high':
      ctx = `<rect x="15" y="9" width="20" height="28" rx="3" ${faint}/>`;
      dot = [25, 20];
      break;
    case 'dialog':
      ctx = `<rect x="5" y="24" width="30" height="22" rx="3" ${faint}/>`;
      dot = [29, 41];
      break;
    case 'home': {
      const cells: string[] = [];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
        if (r === 1 && c === 1) continue;
        cells.push(`<rect x="${6 + c * 10}" y="${8 + r * 11}" width="8" height="8" rx="2" ${faint}/>`);
      }
      ctx = cells.join('') + `<image href="${icon}" x="15" y="18" width="10" height="10" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 2.4px)"/>`;
      dot = [20, 23];
      break;
    }
  }
  const [x, y] = dot;
  const mark = spot === 'home'
    ? `<rect class="ring" x="12" y="15" width="16" height="16" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/>`
    : `<circle class="ring" cx="${x}" cy="${y}" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="${x}" cy="${y}" r="3" fill="currentColor"/>`;
  return `<svg class="where" viewBox="0 0 ${W} ${H}" aria-hidden="true">${face}${ctx}${mark}</svg>`;
}
