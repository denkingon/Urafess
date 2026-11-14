import type { CaptureNews } from './protocol';
import { ANNOUNCE_SHOW_MS, ANNOUNCE_SOUND_LATE_MS, type AnnounceSettings, type AnnounceShow, type AnnounceSound } from './rules';

/**
 * 捕まったときの全員への知らせ。帯に出す言葉・残す一行・鳴らすかどうかを決める（見た目を知らない）。
 * サーバーは設定に合わせて名前を入れる／入れないを決めて配る。ここは届いたものから言葉を作るだけ。
 */

/** 主催者の画面に出す、設定の名前 */
export const SHOW_NAME: Record<AnnounceShow, string> = {
  both: '捕まえた鬼も',
  runner: '捕まった人',
  count: '人数だけ',
  off: '知らせない',
};

export const SOUND_NAME: Record<AnnounceSound, string> = {
  all: '全員',
  oni: '逃げている逃走者は鳴らさない',
  none: '鳴らさない',
};

/** 設定の例（主催者の画面で、選んだものがどう見えるか） */
export const SHOW_EXAMPLE: Record<AnnounceShow, string> = {
  both: '「さむ → ゆいか 確保」',
  runner: '「ゆいか 確保」',
  count: '「1人 確保」',
  off: '帯も音も出さない（人数の表示だけ変わる）',
};

const SHOWS: readonly AnnounceShow[] = ['both', 'runner', 'count', 'off'];
const SOUNDS: readonly AnnounceSound[] = ['all', 'oni', 'none'];

export function isAnnounceSettings(x: unknown): x is AnnounceSettings {
  if (!x || typeof x !== 'object') return false;
  const v = x as Record<string, unknown>;
  return SHOWS.includes(v.show as AnnounceShow) && SOUNDS.includes(v.sound as AnnounceSound);
}

export interface NewsText {
  /** 帯のいちばん上の小さい札（確保・取り消し・テスト） */
  label: string;
  /** 同じ札の英語 */
  en: string;
  /** 大きい字（さむ → ゆいか／ゆいか／1人） */
  who: string;
  /** その下の一行（逃走者 残り 6/7） */
  left: string;
}

/** 帯に出す言葉 */
export function newsText(n: CaptureNews): NewsText {
  const left = n.total > 0 ? `逃走者 残り ${n.left}/${n.total}` : '';
  if (n.kind === 'test') {
    return { label: '知らせのテスト', en: 'TEST', who: '音が鳴ればOK', left: '鳴らなければ、画面に一度触れる' };
  }
  const runner = n.runner?.name ?? '1人';
  if (n.kind === 'release') {
    return { label: '確保の取り消し', en: 'CANCELED', who: runner, left };
  }
  return { label: '確保', en: 'CAUGHT', who: n.oni && n.runner ? `${n.oni.name} → ${n.runner.name}` : runner, left };
}

/** 帯が消えたあとも画面に残す一行（次の配役まで）。試しの知らせは残さない */
export function newsLine(n: CaptureNews | null | undefined, serverNow: number): string {
  if (!n || n.kind === 'test') return '';
  const t = newsText(n);
  const ago = Math.max(0, Math.floor((serverNow - n.showAt) / 1000));
  const when = ago < 60 ? `${ago}秒前` : `${Math.floor(ago / 60)}分前`;
  return `${n.kind === 'release' ? '確保の取り消し' : '最新の確保'}：${t.who}・${when}`;
}

/**
 * この端末で鳴らしてよいか。freeRunner＝今の配役の逃走者で、まだ捕まっていない（隠れているかもしれない）。
 * 「逃げている逃走者は鳴らさない」では、捕まった逃走者・鬼・見学・主催者は鳴らす
 */
export function mayRing(sound: AnnounceSound, freeRunner: boolean): boolean {
  if (sound === 'none') return false;
  if (sound === 'oni') return !freeRunner;
  return true;
}

/**
 * いまの時刻で、この知らせをどうするか。
 * wait＝まだ出す瞬間の前、show＝帯を出して鳴らす、quiet＝帯だけ（遅れて届いた）、over＝もう出さない
 */
export function newsTiming(n: CaptureNews, serverNow: number): 'wait' | 'show' | 'quiet' | 'over' {
  const d = serverNow - n.showAt;
  if (d < 0) return 'wait';
  if (d >= ANNOUNCE_SHOW_MS) return 'over';
  return d < ANNOUNCE_SOUND_LATE_MS ? 'show' : 'quiet';
}
