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
}

export interface JoinScreen {
  el: HTMLElement;
  update(state: EntryState): void;
}

export function createJoin(actions: EntryActions): JoinScreen {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    <h1>Urafess</h1>
    <section data-mode="name">
      <p class="lead">ニックネームを入れて参加する。一度入れたら、次からは名前を押すだけで入れる。</p>
      <form>
        <label for="nick">ニックネーム</label>
        <input id="nick" name="nick" type="text" maxlength="20" autocomplete="nickname" placeholder="例：ゆう" required>
        <p class="error" hidden></p>
        <button type="submit">参加する</button>
      </form>
    </section>
    <section data-mode="known" hidden>
      <p class="lead">名前を押すと、今夜に入る。</p>
      <button type="button" class="me" data-a="enter"></button>
      <p class="error" hidden></p>
    </section>
    <section data-mode="taken" hidden>
      <p class="lead"><span data-k="taken"></span>は、前に来た人の名前。</p>
      <button type="button" class="primary" data-a="reclaim">前の自分に戻る</button>
      <button type="button" data-a="other">ちがう名前にする</button>
      <p class="note">前の自分に戻るときは、主催者がつなぐ。スマホを変えた・置き直したときに。</p>
    </section>
    <section data-mode="wait" hidden>
      <p class="lead">主催者が<span data-k="wait"></span>とつなぐのを待っている。主催者に声をかける。</p>
      <button type="button" data-a="stop">やめる</button>
    </section>
    <div class="spacer"></div>
    <p class="note" data-k="foot">ホーム画面に追加したアプリから開く。LINEの中では開かない。</p>
    <button type="button" class="quiet" data-a="forget" hidden>別の人として入る</button>
  `;
  const sections = [...el.querySelectorAll('section')] as HTMLElement[];
  const form = el.querySelector('form')!;
  const input = el.querySelector('input')!;
  const submit = form.querySelector('button') as HTMLButtonElement;
  const me = el.querySelector('[data-a="enter"]') as HTMLButtonElement;
  const forget = el.querySelector('[data-a="forget"]') as HTMLButtonElement;
  const errors = [...el.querySelectorAll('.error')] as HTMLElement[];
  let mode: EntryMode = 'name';
  let takenName = '';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name) actions.join(name);
  });
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    switch (a) {
      case 'enter':
        actions.enter();
        return;
      case 'forget':
        if (confirm('このスマホは、いまの名前を忘れる（名簿には残る）。別の人として入るか？')) actions.forget();
        return;
      case 'reclaim':
        actions.reclaim();
        return;
      case 'other':
        actions.backToName(`「${takenName}」は前に来た人の名前。ちがう名前にする（例：${takenName}2）。`);
        return;
      case 'stop':
        actions.backToName(null);
        return;
    }
  });

  return {
    el,
    update({ mode: next, busy, error, name }) {
      if (next !== mode) {
        mode = next;
        for (const s of sections) s.hidden = s.dataset.mode !== next;
        if (next === 'name') setTimeout(() => input.focus(), 0);
      }
      if (next === 'taken' || next === 'wait') takenName = name ?? '';
      (el.querySelector('[data-k="taken"]') as HTMLElement).textContent = `「${takenName}」`;
      (el.querySelector('[data-k="wait"]') as HTMLElement).textContent = `「${takenName}」`;
      me.textContent = busy && next === 'known' ? '入っている…' : name ?? '';
      me.disabled = busy;
      submit.disabled = busy;
      submit.textContent = busy && next === 'name' ? '参加しています…' : '参加する';
      forget.hidden = next !== 'known';
      for (const err of errors) {
        const show = !!error && err.closest('section')?.dataset.mode === next;
        err.hidden = !show;
        err.textContent = show ? error : '';
      }
    },
  };
}
