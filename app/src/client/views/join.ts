import { say, sent } from '../ui';

/** 入室の画面（キャンバスの「入室」）。ニックネームを入れて参加する */
export interface JoinScreen {
  el: HTMLElement;
  update(state: { busy: boolean; error: string | null }): void;
}

export function createJoin(onJoin: (name: string) => void): JoinScreen {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    <h1 class="u">Urafess</h1>
    <p class="lead">${sent(['ニックネームを入れて参加する。画面を閉じても、開き直せば同じ人として戻れる', 'Enter a nickname to join. If you close the app, open it again to come back as the same person'])}</p>
    <form>
      <label for="nick">${say(['ニックネーム', 'NICKNAME'])}</label>
      <input id="nick" name="nick" type="text" maxlength="20" autocomplete="nickname" placeholder="例：ゆう" required>
      <p class="error" hidden></p>
      <button type="submit"></button>
    </form>
    <div class="spacer"></div>
    <p class="note">${sent(['ホーム画面に追加したアプリから開く。LINEの中では開かない', 'Open it from the app on your home screen, not inside LINE'])}</p>
  `;
  const form = el.querySelector('form')!;
  const input = el.querySelector('input')!;
  const button = el.querySelector('button')!;
  const error = el.querySelector('.error') as HTMLElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name) onJoin(name);
  });
  let lastBusy: boolean | null = null;
  return {
    el,
    update({ busy, error: message }) {
      button.disabled = busy;
      if (busy !== lastBusy) {
        lastBusy = busy;
        button.innerHTML = say(busy ? ['参加しています…', 'JOINING…'] : ['参加する', 'JOIN']);
      }
      error.hidden = !message;
      error.textContent = message ?? '';
    },
  };
}
