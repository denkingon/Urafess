/** 入室の画面（キャンバスの「入室」）。ニックネームを入れて参加する */
export interface JoinScreen {
  el: HTMLElement;
  update(state: { busy: boolean; error: string | null }): void;
}

export function createJoin(onJoin: (name: string) => void): JoinScreen {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    <h1>Urafess</h1>
    <p class="lead">ニックネームを入れて参加する。画面を閉じても、開き直せば同じ人として戻れる。</p>
    <form>
      <label for="nick">ニックネーム</label>
      <input id="nick" name="nick" type="text" maxlength="20" autocomplete="nickname" placeholder="例：ゆう" required>
      <p class="error" hidden></p>
      <button type="submit">参加する</button>
    </form>
    <div class="spacer"></div>
    <p class="note">ホーム画面に追加したアプリから開く。LINEの中では開かない。</p>
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
  return {
    el,
    update({ busy, error: message }) {
      button.disabled = busy;
      button.textContent = busy ? '参加しています…' : '参加する';
      error.hidden = !message;
      error.textContent = message ?? '';
    },
  };
}
