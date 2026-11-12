import { esc, say, sent } from '../ui';

/**
 * 入室の画面（キャンバスの「入室」）。4つの姿を持つ
 * - 名前：はじめての人がニックネームを入れる（一度入れたら名簿に残る）
 * - 名前のボタン：名簿にいる人。名前を押すだけで今夜に入る
 * - 前の◯◯？：入れた名前が名簿のほかの人のもの。前の自分なら主催者につないでもらう
 * - 待つ：主催者がつなぐのを待っている
 */
export type EntryMode = 'name' | 'known' | 'taken' | 'wait';

export interface EntryState {
  mode: EntryMode;
  busy: boolean;
  error: string | null;
  /** known のとき：自分の名前。taken・wait のとき：名簿にある名前 */
  name: string | null;
}

export interface EntryActions {
  join(name: string): void;
  /** 名前のボタン：今夜に入る */
  enter(): void;
  /** 別の人として入る（このスマホが覚えている人を忘れる） */
  forget(): void;
  /** 前の自分に戻る（主催者がつなぐのを待つ） */
  reclaim(): void;
  /** ちがう名前にする／待つのをやめる */
  backToName(message: string | null): void;
  /** 自分のページを開く（名前のボタンの画面から） */
  openAccount(): void;
  /** 前のスマホに出した6桁で移る。うまくいけば null、だめなら画面に出す文 */
  take(code: string): Promise<string | null>;
}

export interface JoinScreen {
  el: HTMLElement;
  update(state: EntryState): void;
}

export function createJoin(actions: EntryActions): JoinScreen {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    <h1 class="u">Urafess</h1>
    <section data-mode="name">
      <p class="lead">${sent(['ニックネームを入れて参加する。一度入れたら、次からは名前を押すだけで入れる', 'Enter a nickname to join. Next time, just tap your name'])}</p>
      <form>
        <label for="nick">${say(['ニックネーム', 'NICKNAME'])}</label>
        <input id="nick" name="nick" type="text" maxlength="20" autocomplete="nickname" placeholder="例：ゆう" required>
        <p class="error" hidden></p>
        <button type="submit"></button>
      </form>
    </section>
    <section data-mode="known" hidden>
      <p class="lead">${sent(['名前を押すと、今夜に入る', 'Tap your name to join tonight'])}</p>
      <button type="button" class="me" data-a="enter"></button>
      <p class="error" hidden></p>
    </section>
    <section data-mode="taken" hidden>
      <p class="lead" data-k="takenLead"></p>
      <button type="button" class="primary" data-a="reclaim">${say(['前の自分に戻る', "IT'S ME"])}</button>
      <button type="button" data-a="other">${say(['ちがう名前にする', 'USE ANOTHER NAME'])}</button>
      <p class="note">${sent(['前の自分に戻るときは、主催者がつなぐ。スマホを変えた・置き直したときに', 'The host reconnects you. For a new phone or a reinstalled app'])}</p>
    </section>
    <section data-mode="move" hidden>
      <p class="lead">${sent(['前のスマホで「自分のページ → 新しいスマホへ移す」を押すと、6桁の合言葉が出る。それをここに打つ', 'On your old phone, open My page → Move to a new phone. Type the 6 digits here'])}</p>
      <form data-k="moveForm">
        <label for="move-code">${say(['合言葉（6桁）', 'CODE (6 DIGITS)'])}</label>
        <input id="move-code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="one-time-code" class="u code" required>
        <p class="error" hidden></p>
        <button type="submit" class="primary" data-k="moveBtn">${say(['移す', 'MOVE'])}</button>
      </form>
      <button type="button" data-a="moveBack">${say(['もどる', 'BACK'])}</button>
    </section>
    <section data-mode="wait" hidden>
      <p class="lead" data-k="waitLead"></p>
      <button type="button" data-a="stop">${say(['やめる', 'CANCEL'])}</button>
    </section>
    <div class="spacer"></div>
    <p class="note" data-k="foot">${sent(['ホーム画面に追加したアプリから開く。LINEの中では開かない', 'Open it from the app on your home screen, not inside LINE'])}</p>
    <button type="button" class="quiet" data-a="account" hidden>${say(['自分のページ', 'MY PAGE'])}</button>
    <button type="button" class="quiet" data-a="move" hidden>${say(['前のスマホから移す', 'MOVE FROM YOUR OLD PHONE'])}</button>
    <button type="button" class="quiet" data-a="forget" hidden>${say(['別の人として入る', 'JOIN AS SOMEONE ELSE'])}</button>
  `;
  const sections = [...el.querySelectorAll('section')] as HTMLElement[];
  const form = el.querySelector('section[data-mode="name"] form') as HTMLFormElement;
  const moveForm = el.querySelector('[data-k="moveForm"]') as HTMLFormElement;
  const moveInput = el.querySelector('#move-code') as HTMLInputElement;
  const moveBtn = el.querySelector('[data-k="moveBtn"]') as HTMLButtonElement;
  const moveError = moveForm.querySelector('.error') as HTMLElement;
  const accountBtn = el.querySelector('[data-a="account"]') as HTMLButtonElement;
  const moveOpen = el.querySelector('[data-a="move"]') as HTMLButtonElement;
  const input = el.querySelector('input')!;
  const submit = form.querySelector('button') as HTMLButtonElement;
  const me = el.querySelector('[data-a="enter"]') as HTMLButtonElement;
  const forget = el.querySelector('[data-a="forget"]') as HTMLButtonElement;
  const errors = [...el.querySelectorAll('section:not([data-mode="move"]) .error')] as HTMLElement[];
  let mode: EntryMode | 'move' = 'name';
  /** 「前のスマホから移す」を開いている（入室の名前・前の◯◯？のどちらからでも開ける） */
  let moving = false;
  let moveBusy = false;
  let lastState: EntryState | null = null;
  let takenName = '';
  // 同じ中身なら書き換えない（毎フレーム呼ばれるので、押している途中のボタンを作り直さない）
  const last = new Map<string, string>();
  const setOnce = (key: string, html: string, target?: HTMLElement) => {
    if (last.get(key) === html) return;
    last.set(key, html);
    (target ?? (el.querySelector(`[data-k="${key}"]`) as HTMLElement)).innerHTML = html;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name) actions.join(name);
  });
  moveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = moveInput.value.replace(/\D/g, '');
    if (moveBusy) return;
    if (code.length !== 6) {
      moveError.hidden = false;
      moveError.textContent = '合言葉は6桁の数字／The code is 6 digits';
      return;
    }
    moveBusy = true;
    moveError.hidden = true;
    if (lastState) api.update(lastState);
    const err = await actions.take(code);
    moveBusy = false;
    if (err) {
      moveError.hidden = false;
      moveError.textContent = err;
    } else {
      moving = false;
      moveInput.value = '';
    }
    if (lastState) api.update(lastState);
  });
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    switch (a) {
      case 'account':
        actions.openAccount();
        return;
      case 'move':
        moving = true;
        moveError.hidden = true;
        if (lastState) api.update(lastState);
        setTimeout(() => moveInput.focus(), 0);
        return;
      case 'moveBack':
        moving = false;
        if (lastState) api.update(lastState);
        return;
      case 'enter':
        actions.enter();
        return;
      case 'forget':
        if (confirm('このスマホは、いまの名前を忘れる（名簿には残る）。別の人として入るか？\nThis phone forgets your name (it stays on the list). Join as someone else?')) actions.forget();
        return;
      case 'reclaim':
        actions.reclaim();
        return;
      case 'other':
        actions.backToName(`「${takenName}」は前に来た人の名前。ちがう名前にする（例：${takenName}2）／"${takenName}" is taken. Try another (e.g. ${takenName}2)`);
        return;
      case 'stop':
        actions.backToName(null);
        return;
    }
  });

  const api: JoinScreen = {
    el,
    update(state) {
      lastState = state;
      const { busy, error, name } = state;
      // 「前のスマホから移す」は、名前を入れる前（入室・前の◯◯？）だけ開ける
      if (moving && state.mode !== 'name' && state.mode !== 'taken') moving = false;
      const next: EntryMode | 'move' = moving ? 'move' : state.mode;
      if (next !== mode) {
        mode = next;
        for (const s of sections) s.hidden = s.dataset.mode !== next;
        if (next === 'name') setTimeout(() => input.focus(), 0);
      }
      moveBtn.disabled = moveBusy;
      moveInput.disabled = moveBusy;
      setOnce('moveBtn', say(moveBusy ? ['移している…', 'MOVING…'] : ['移す', 'MOVE']), moveBtn);
      accountBtn.hidden = next !== 'known' || busy;
      moveOpen.hidden = next !== 'name' && next !== 'taken';
      if (next === 'taken' || next === 'wait') takenName = name ?? '';
      const t = esc(takenName);
      setOnce('takenLead', sent([`「${t}」は、前に来た人の名前`, `"${t}" is a name from a past night`]));
      setOnce('waitLead', sent([`主催者が「${t}」とつなぐのを待っている。主催者に声をかける`, `Waiting for the host to reconnect "${t}". Tell the host`]));
      setOnce('me', busy && next === 'known' ? say(['入っている…', 'JOINING…']) : esc(name ?? ''), me);
      me.disabled = busy;
      submit.disabled = busy;
      setOnce('submit', say(busy && next === 'name' ? ['参加しています…', 'JOINING…'] : ['参加する', 'JOIN']), submit);
      forget.hidden = next !== 'known' || busy;
      for (const err of errors) {
        const show = !!error && err.closest('section')?.dataset.mode === next;
        err.hidden = !show;
        err.textContent = show ? error : '';
      }
    },
  };
  return api;
}
