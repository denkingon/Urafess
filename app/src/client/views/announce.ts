import { mayRing, newsText, newsTiming } from '../../shared/announce';
import type { CaptureNews } from '../../shared/protocol';
import { ANNOUNCE_SHOW_MS } from '../../shared/rules';
import type { AnnounceChime } from '../sound/chime';

/**
 * 捕まったときの全員への知らせ（見た目の層）。画面のいちばん上に帯を出し、確保の音を鳴らす。
 * 帯と音は、サーバーが決めた瞬間（news.showAt）に全員のスマホで同時に出る。
 * 捕まった本人と捕まえた鬼には、自分の知らせ（「◯◯に捕まった」「◯◯を捕まえた」）が出るので帯は重ねない（音は鳴らす）。
 */

export interface AnnounceInput {
  news: CaptureNews | null;
  /** 知らせが自分のこと（捕まった本人・捕まえた鬼） */
  aboutMe: boolean;
  /** サーバー時刻の見積もり */
  serverNow: number;
  /** 今の配役の逃走者で、まだ捕まっていない（「逃げている逃走者は鳴らさない」の対象） */
  freeRunner: boolean;
  /** この端末がほかの音（「捕まった」の番号）を鳴らしている最中。止めないよう、知らせの音は鳴らさない */
  busy: boolean;
}

export interface AnnounceScreen {
  el: HTMLElement;
  update(input: AnnounceInput): void;
}

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末（iPhone はウェブから震わせられない）
  }
}

export function createAnnounce(chime: AnnounceChime): AnnounceScreen {
  const el = document.createElement('div');
  el.className = 'announce';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  el.innerHTML = `
    <span class="an-label"><b data-k="label"></b><i data-k="en"></i></span>
    <b class="an-who" data-k="who"></b>
    <span class="an-left" data-k="left"></span>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  // 触れたら消す（消えたあとも、画面に「最新の確保」が残る）
  el.addEventListener('click', () => (el.hidden = true));

  /** 帯を出し終えた（または出さないと決めた）知らせの番号 */
  let done = -1;
  let hideAt = 0;

  return {
    el,
    update({ news, aboutMe, serverNow, freeRunner, busy }) {
      if (!news) {
        // 配役が変わった・部屋が空になった：出ている帯も消す
        el.hidden = true;
        return;
      }
      if (news.seq !== done) {
        const timing = newsTiming(news, serverNow);
        if (timing === 'wait') return; // まだ出す瞬間の前。全員と同じ瞬間を待つ
        done = news.seq;
        if (timing !== 'over') {
          if (!aboutMe) {
            const t = newsText(news);
            q('label').textContent = t.label;
            q('en').textContent = t.en;
            q('who').textContent = t.who;
            q('left').textContent = t.left;
            el.dataset.kind = news.kind;
            el.hidden = false;
            hideAt = news.showAt + ANNOUNCE_SHOW_MS;
            vibrate(news.kind === 'release' ? [60, 60, 60] : [120, 70, 120, 70, 240]);
          }
          if (timing === 'show' && !busy && mayRing(news.sound, freeRunner)) chime.play(news.kind);
        }
      }
      if (!el.hidden && serverNow >= hideAt) el.hidden = true;
    },
  };
}
