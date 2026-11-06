import type { PhoneView } from '../../shared/viewmodel';

/**
 * 見た目の層。キャンバス「Urafess アプリ画面」の共通部品 Phone をそのまま写した仮の画面。
 * しくみからは PhoneView だけを受け取る。見た目を差し替えるときはこのファイルと styles.css を替えればいい。
 */

const STEP_NAMES = ['配役', '逃走', '追跡', 'ゲーム', '帰還', '結果'];
/** 大きい数字の上限。光の地図を出している間は、地図に場所を譲って小さめにする */
const BIG_MAX_PX = 104;
const BIG_MAX_GLOW_PX = 52;

export interface PhoneScreen {
  el: HTMLElement;
  /** 捕獲の画面などを差し込む場所（下の段階バーのすぐ上。親指が届く） */
  slot: HTMLElement;
  /** 走ると光るの地図などを差し込む場所（時計と長押しの間。空いている高さを全部使う） */
  stage: HTMLElement;
  update(view: PhoneView): void;
}

export function createPhone(): PhoneScreen {
  const el = document.createElement('main');
  el.className = 'phone';
  el.innerHTML = `
    <div class="top"><span data-k="round"></span><span class="link"><span class="dot"></span><span data-k="link"></span></span></div>
    <div class="offline" data-k="offline" hidden>通信が切れている。タイマーはこのまま進む。</div>
    <div class="badge-row"><span class="badge" data-k="badge"></span><span class="label-inline" data-k="label2"></span></div>
    <div class="label" data-k="label"></div>
    <div class="big" data-k="big" aria-live="polite"></div>
    <div class="message" data-k="message"></div>
    <div class="stage" data-k="stage"></div>
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
    label2: q('label2'),
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
    stage: q('stage'),
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
      // 光の地図を出す間は、段階の名前を役の札の横に寄せる（地図に高さを譲る）
      parts.label2.textContent = view.label;
      // 光の地図を出す間（ゲームの段階）は、上を詰めて地図に高さを譲る
      el.classList.toggle('is-glow', view.glow === 'live');
      parts.big.textContent = view.big;
      // 夜の最後：SEE YOU AGAIN だけを真ん中に出す（段階バー・人数・役の札は隠す）
      el.classList.toggle('is-ended', view.ended === true);
      parts.big.style.fontSize = `${Math.min(view.glow === 'live' ? BIG_MAX_GLOW_PX : BIG_MAX_PX, bigFontSize(view.big, parts.big.clientWidth || 342))}px`;
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
  // 英大文字（SEE YOU AGAIN など）は数字より幅広い。0.62 だと右にはみ出す
  const em = [...text].reduce((sum, ch) => sum + (/[A-Z]/.test(ch) ? 0.8 : ch.charCodeAt(0) < 256 ? 0.62 : 1), 0);
  return Math.max(24, Math.min(104, Math.floor((width - 6) / Math.max(em, 1))));
}
