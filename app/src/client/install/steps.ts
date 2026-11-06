/**
 * 置き方の案内の「手順の一覧」。押すものを、押す順に全部並べる（画面には触らない、純粋な関数）。
 *
 * - 押すものは OS の画面にある字（共有・その他・ホーム画面に追加・追加 など）と絵で書く。自分の画面で同じ字を探せるように。
 *   OS の字はスマホの言葉で変わる（英語の iPhone なら Share・More・Add to Home Screen・Add）ので、日本語と英語の両方を持つ
 * - 手ごとに一言（右下・上へ送る など）を添える。日本語と英語の両方を持つ（11/6 本人「B かつ英語も入れて」）
 * - 一覧は一度に全部見せる。OS のメニューやシートが下から出て画面の下半分を隠しても、上に置いた一覧は見えたまま
 * - iPhone の iOS 26 から、共有シートは最初に4つだけ見せ、「ホーム画面に追加」は「その他」の先に入った
 *   （ソフトバンクの iOS 26 の手順、MacStories の iOS 26 の記事。11/6 の実機で、この1手が無い絵で迷った）
 */
import type { InstallPath } from './detect';
import type { GlyphName } from './glyphs';

export type Lang = 'ja' | 'en';
/** 日本語と英語の両方 */
export type Both = Record<Lang, string>;

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
  /** OS の画面にある字（スマホの言葉ごと）。無いものは null */
  label: Both | null;
  /** OS の画面にある絵。無いものは null */
  glyph: GlyphName | null;
  /** 画面のどこにあるか。最初のボタンと、隅にある「追加」だけに付ける */
  where?: Where;
  /** 出ないこともある手（点線で描く。iPhone の Chrome などで「その他」が出ない版がある） */
  optional?: boolean;
  /** 添える一言（場所・見つからないとき）。無ければ空 */
  hint: Both;
}

export interface Guide {
  /** 何をしているか（OS の字。題に使う） */
  title: Both;
  steps: Step[];
  /** 本物の画面で、最初に押すボタンのある所（ページの端から矢印で指す） */
  pointer: Where;
}

/** UA の「OS 26_1」から iOS の版。Safari 26 からは 18 に固定されているので、Safari には使わない */
export function iosMajor(ua: string): number | null {
  const m = /OS (\d+)_\d+/.exec(ua);
  return m ? Number(m[1]) : null;
}

/** スマホの言葉（日本語でなければ英語の字を出す） */
export function langOf(language: string | undefined | null): Lang {
  return /^ja\b/i.test(language ?? 'ja') ? 'ja' : 'en';
}

const none: Both = { ja: '', en: '' };
const more = (optional = false): Step => ({
  kind: 'action',
  label: { ja: 'その他', en: 'More' },
  glyph: 'dots',
  optional,
  hint: { ja: '共有シートの右端', en: 'right end of the sheet' },
});
const addHome = (hint: Both): Step => ({ kind: 'row', label: { ja: 'ホーム画面に追加', en: 'Add to Home Screen' }, glyph: 'addHome', hint });
const add: Step = { kind: 'pill', label: { ja: '追加', en: 'Add' }, glyph: null, where: 'top-right', hint: { ja: '右上', en: 'top right' } };
const open: Step = { kind: 'icon', label: null, glyph: null, hint: { ja: 'ホーム画面のアイコンから開く', en: 'open from the Home Screen' } };
const swipeUp: Both = { ja: '見えなければ上へ送る', en: 'swipe up if hidden' };
const homeTitle: Both = { ja: 'ホーム画面に追加', en: 'Add to Home Screen' };

export function guideFor(path: Exclude<InstallPath, 'installed' | 'desktop'>, ua = ''): Guide {
  switch (path) {
    case 'ios-safari-26':
      return {
        title: homeTitle,
        pointer: 'bottom-right',
        steps: [
          { kind: 'circle', label: null, glyph: 'more', where: 'bottom-right', hint: { ja: '右下の •••', en: '••• at the bottom right' } },
          { kind: 'menu', label: { ja: '共有', en: 'Share' }, glyph: 'share', hint: none },
          more(),
          addHome(swipeUp),
          add,
          open,
        ],
      };
    case 'ios-safari':
      return {
        title: homeTitle,
        pointer: 'bottom-center',
        steps: [
          { kind: 'tool', label: null, glyph: 'share', where: 'bottom-center', hint: { ja: '下の真ん中の共有', en: 'Share, bottom center' } },
          addHome({ ja: '下へ送ると出る', en: 'scroll down to find it' }),
          add,
          open,
        ],
      };
    case 'ios-other': {
      // iPhone の Chrome などは共有シートが iOS のもの。iOS 26 からは「その他」の先（版が分からなければ、点線で入れておく）
      const v = iosMajor(ua);
      const steps: Step[] = [{ kind: 'tool', label: null, glyph: 'share', where: 'top-right', hint: { ja: '右上の共有', en: 'Share, top right' } }];
      if (v === null || v >= 26) steps.push(more(v === null));
      steps.push(addHome(swipeUp), add, open);
      return { title: homeTitle, pointer: 'top-right', steps };
    }
    case 'android':
      return {
        title: { ja: 'アプリをインストール', en: 'Install app' },
        pointer: 'top-right',
        steps: [
          { kind: 'tool', label: null, glyph: 'kebab', where: 'top-right', hint: { ja: '右上の ⋮', en: '⋮ at the top right' } },
          {
            kind: 'menu',
            label: { ja: 'アプリをインストール', en: 'Install app' },
            glyph: 'install',
            hint: { ja: '「ホーム画面に追加」のこともある', en: 'may say “Add to Home screen”' },
          },
          { kind: 'pill', label: { ja: 'インストール', en: 'Install' }, glyph: null, hint: none },
          open,
        ],
      };
    case 'inapp':
    case 'line':
      return {
        title: { ja: 'ブラウザで開く', en: 'Open in browser' },
        pointer: 'top-right',
        steps: [
          { kind: 'tool', label: null, glyph: 'dots', where: 'top-right', hint: { ja: '右上のメニュー', en: 'menu, top right' } },
          {
            kind: 'menu',
            label: { ja: 'ブラウザで開く', en: 'Open in browser' },
            glyph: 'browser',
            hint: { ja: '開き直した先で、置き方が出る', en: 'the guide continues there' },
          },
        ],
      };
  }
}

/** 先頭を大文字に（英語の一言を文の頭に置くとき） */
const cap = (s: string, lang: Lang) => (lang === 'en' && s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * 手ごとに添える一言（2つ）。1つ目はスマホの言葉で場所など、2つ目はもう一方の言葉で「押すものの字＋場所」。
 * 例（日本語のスマホ）：「共有シートの右端」「More — right end of the share sheet」
 */
export function hintsFor(s: Step, lang: Lang): { main: string; other: string; otherLang: Lang } {
  const otherLang: Lang = lang === 'ja' ? 'en' : 'ja';
  const label = s.label?.[otherLang] ?? '';
  const hint = s.hint[otherLang];
  const other =
    otherLang === 'en'
      ? cap([label, hint].filter(Boolean).join(' — '), 'en')
      : [label ? `「${label}」` : '', hint].filter(Boolean).join(' ');
  return { main: cap(s.hint[lang], lang), other, otherLang };
}
