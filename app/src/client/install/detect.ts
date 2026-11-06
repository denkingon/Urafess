/**
 * ホーム画面への置き方を、端末とブラウザから選ぶ（画面には触らない、純粋な関数）。
 *
 * - iPhone の Safari 26 からは、共有ボタンが「•••」の中に入った。Safari 26 は UA の OS の版を 18_x に固定しているので、
 *   版は Version/26 の方で見る
 * - LINE の中のブラウザはホーム画面に置けない。URL に openExternalBrowser=1 を付けると LINE が外のブラウザで開き直す
 * - Instagram・Facebook などアプリの中のブラウザも置けない。右上のメニューからブラウザで開き直してもらう
 */

export type InstallPath =
  | 'installed' //      ホーム画面のアプリとして開いている
  | 'line' //           LINE の中（外のブラウザへ逃がす）
  | 'inapp' //          ほかのアプリの中のブラウザ（右上のメニューからブラウザで開く）
  | 'ios-safari-26' //  iPhone の Safari 26 以降（••• → 共有 → ホーム画面に追加）
  | 'ios-safari' //     iPhone の Safari 18 以前（共有 → ホーム画面に追加）
  | 'ios-other' //      iPhone の Chrome など（右上の共有 → ホーム画面に追加）
  | 'android' //        Android（⋮ → インストール／ホーム画面に追加。Chrome はボタン1つで出せることがある）
  | 'desktop'; //       パソコン（案内しない）

export interface InstallEnv {
  ua: string;
  /** display-mode: standalone、または iPhone の navigator.standalone */
  standalone: boolean;
  /** iPad の Safari はパソコンの UA を名乗るので、触れる指の数で見分ける */
  maxTouchPoints: number;
}

export function detectInstall({ ua, standalone, maxTouchPoints }: InstallEnv): InstallPath {
  if (standalone) return 'installed';
  if (/\bLine\//i.test(ua)) return 'line';
  if (/Instagram|FBAN|FBAV|FB_IAB|FBIOS|TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'inapp';

  const iPadAsMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadAsMac;
  if (ios) {
    if (/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA\//.test(ua)) return 'ios-other';
    const v = /Version\/(\d+)/.exec(ua);
    if (!v) return 'inapp'; // Safari を名乗らない WebView（アプリの中）
    return Number(v[1]) >= 26 ? 'ios-safari-26' : 'ios-safari';
  }
  if (/Android/.test(ua)) {
    if (/; wv\)/.test(ua)) return 'inapp'; // Android の WebView
    return 'android';
  }
  return 'desktop';
}

/** LINE から外のブラウザへ開き直す URL。すでに付けて開き直したのに LINE の中にいるときは null（案内に切り替える） */
export function lineEscapeUrl(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.has('openExternalBrowser')) return null;
  url.searchParams.set('openExternalBrowser', '1');
  return url.toString();
}
