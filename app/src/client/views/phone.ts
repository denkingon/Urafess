import type { PhoneView } from '../../shared/viewmodel';

/**
 * 見た目の層。キャンバス「Urafess アプリ画面」の共通部品 Phone をそのまま写した仮の画面。
 * しくみからは PhoneView だけを受け取る。見た目を差し替えるときはこのファイルと styles.css を替えればいい。
 */

const STEP_NAMES = ['配役', '逃走', '追跡', 'ゲーム', '帰還', '結果'];

export interface PhoneScreen {
  el: HTMLElement;
  /** 捕獲の画面などを差し込む場所（下の段階バーのすぐ上。親指が届く） */
  slot: HTMLElement;
  update(view: PhoneView): void;
}

export function createPhone(): PhoneScreen {
  const el = document.createElement('main');
  el.className = 'phone';
  el.innerHTML = `
    <div class="top"><span data-k="round"></span><span class="link"><span class="dot"></span><span data-k="link"></span></span></div>
    <div class="offline" data-k="offline" hidden>通信が切れている。タイマーはこのまま進む。</div>
    <div class="badge-row"><span class="badge" data-k="badge"></span></div>
    <div class="label" data-k="label"></div>
    <div class="big" data-k="big" aria-live="polite"></div>
    <div class="message" data-k="message"></div>
    <div class="spacer"></div>
    <div class="slot" data-k="slot"></div>
    <div class="steps">${STEP_NAMES.map((n) => `<div class="step"><div class="bar"></div><span>${n}</span></div>`).join('')}</div>
    <div class="foot"><span data-k="oni"></span><span data-k="runners"></span></div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const parts = {
    round: q('round'),
    link: q('link'),
    offline: q('offline'),
    badge: q('badge'),
    label: q('label'),
    big: q('big'),
    message: q('message'),
    oni: q('oni'),
    runners: q('runners'),
  };
  const steps = [...el.querySelectorAll('.step')] as HTMLElement[];
  let last = '';

  return {
    el,
    slot: q('slot'),
    update(view) {
      const key = JSON.stringify(view);
      if (key === last) return;
      last = key;
      parts.round.textContent = `ラウンド ${view.round}`;
      parts.link.textContent = view.offline ? '切断中' : '接続中';
      el.classList.toggle('is-offline', view.offline);
      parts.offline.hidden = !view.offline;
      parts.badge.textContent = view.role === 'なし' ? '役はまだない' : view.caught ? `${view.role}・捕まった` : view.role;
      parts.badge.dataset.role = view.caught ? 'caught' : view.role === '鬼' ? 'oni' : view.role === '逃走者' ? 'runner' : 'none';
      parts.label.textContent = view.label;
      parts.big.textContent = view.big;
      parts.big.style.fontSize = `${bigFontSize(view.big, parts.big.clientWidth || 342)}px`;
      parts.message.textContent = view.message;
      parts.oni.textContent = `鬼 ${view.oni}人`;
      parts.runners.textContent = `逃走者 ${view.runners}人`;
      steps.forEach((s, i) => {
        s.dataset.state = i + 1 < view.step ? 'done' : i + 1 === view.step ? 'now' : 'later';
      });
    },
  };
}

/** キャンバスの Phone と同じ決め方：数字は細め、漢字は1文字分で幅を見積もり、はみ出さない大きさにする */
export function bigFontSize(text: string, width: number): number {
  const em = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 256 ? 0.62 : 1), 0);
  return Math.max(24, Math.min(104, Math.floor((width - 6) / Math.max(em, 1))));
}
