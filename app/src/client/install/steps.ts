/**
 * 置き方の案内の「手順の一覧」。押すものを、押す順に全部並べる（画面には触らない、純粋な関数）。
 *
 * - 押すものは OS の画面にある字（共有・その他・ホーム画面に追加・追加 など）と絵で書く。自分の画面で同じ字を探せるように
 * - 一覧は一度に全部見せる。OS のメニューやシートが下から出て画面の下半分を隠しても、上に置いた一覧は見えたまま
 * - iPhone の iOS 26 から、共有シートは最初に4つだけ見せ、「ホーム画面に追加」は「その他」の先に入った
 *   （ソフトバンクの iOS 26 の手順、MacStories の iOS 26 の記事。11/6 の実機で、この1手が無い絵で迷った）
 */
import type { InstallPath } from './detect';
import type { GlyphName } from './glyphs';

/** 押すものの形 */
export type StepKind =
  | 'circle' //  丸いボタン（Safari 26 の •••）
  | 'tool' //    字の無いボタン（共有・⋮ など、バーの中の絵だけのもの）
  | 'menu' //    メニューの1行（絵＋字）
  | 'action' //  共有シートの丸いボタン（絵の下に字）
  | 'row' //     共有シートの一覧の1行（字＋右に絵）
  | 'pill' //    字だけのボタン（追加・インストール）
  | 'icon'; //   ホーム画面のアイコン

export type Where = 'bottom-right' | 'bottom-center' | 'top-right';

export interface Step {
  kind: StepKind;
  /** OS の画面にある字。無いものは null */
  label: string | null;
  /** OS の画面にある絵。無いものは null */
  glyph: GlyphName | null;
  /** 画面のどこにあるか。最初のボタンと、隅にある「追加」だけに付ける */
  where?: Where;
  /** 出ないこともある手（点線で描く。iPhone の Chrome などで「その他」が出ない版がある） */
  optional?: boolean;
  /** 言葉を添える案のときだけ出す一言 */
  hint: string;
}

export interface Guide {
  /** 何をしているか（OS の字。題に使う） */
  title: string;
  steps: Step[];
  /** 本物の画面で、最初に押すボタンのある所（ページの端から矢印で指す） */
  pointer: Where;
}

/** UA の「OS 26_1」から iOS の版。Safari 26 からは 18 に固定されているので、Safari には使わない */
export function iosMajor(ua: string): number | null {
  const m = /OS (\d+)_\d+/.exec(ua);
  return m ? Number(m[1]) : null;
}

const more = (optional = false): Step => ({ kind: 'action', label: 'その他', glyph: 'dots', optional, hint: '共有シートの右端' });
const addHome = (hint: string): Step => ({ kind: 'row', label: 'ホーム画面に追加', glyph: 'addHome', hint });
const add: Step = { kind: 'pill', label: '追加', glyph: null, where: 'top-right', hint: '右上' };
const open: Step = { kind: 'icon', label: null, glyph: null, hint: 'ホーム画面のアイコンから開く' };

export function guideFor(path: Exclude<InstallPath, 'installed' | 'desktop'>, ua = ''): Guide {
  switch (path) {
    case 'ios-safari-26':
      return {
        title: 'ホーム画面に追加',
        pointer: 'bottom-right',
        steps: [
          { kind: 'circle', label: null, glyph: 'more', where: 'bottom-right', hint: '右下の •••' },
          { kind: 'menu', label: '共有', glyph: 'share', hint: '' },
          more(),
          addHome('見えなければ上へ送る'),
          add,
          open,
        ],
      };
    case 'ios-safari':
      return {
        title: 'ホーム画面に追加',
        pointer: 'bottom-center',
        steps: [
          { kind: 'tool', label: null, glyph: 'share', where: 'bottom-center', hint: '下の真ん中' },
          addHome('下へ送ると出る'),
          add,
          open,
        ],
      };
    case 'ios-other': {
      // iPhone の Chrome などは共有シートが iOS のもの。iOS 26 からは「その他」の先（版が分からなければ、点線で入れておく）
      const v = iosMajor(ua);
      const steps: Step[] = [{ kind: 'tool', label: null, glyph: 'share', where: 'top-right', hint: '右上' }];
      if (v === null || v >= 26) steps.push(more(v === null));
      steps.push(addHome('見えなければ上へ送る'), add, open);
      return { title: 'ホーム画面に追加', pointer: 'top-right', steps };
    }
    case 'android':
      return {
        title: 'アプリをインストール',
        pointer: 'top-right',
        steps: [
          { kind: 'tool', label: null, glyph: 'kebab', where: 'top-right', hint: '右上の ⋮' },
          { kind: 'menu', label: 'アプリをインストール', glyph: 'install', hint: '「ホーム画面に追加」のこともある' },
          { kind: 'pill', label: 'インストール', glyph: null, hint: '' },
          open,
        ],
      };
    case 'inapp':
    case 'line':
      return {
        title: 'ブラウザで開く',
        pointer: 'top-right',
        steps: [
          { kind: 'tool', label: null, glyph: 'dots', where: 'top-right', hint: '右上のメニュー' },
          { kind: 'menu', label: 'ブラウザで開く', glyph: 'browser', hint: '開き直した先で、置き方が出る' },
        ],
      };
  }
}
