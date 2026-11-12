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
}

export interface JoinScreen {
  el: HTMLElement;
  update(state: EntryState): void;
}

/** 主催者の入口（合言葉の画面）への道。ホーム画面のアプリには URL の欄が無いので、入室から行く */
export interface HostDoor {
  href: string;
  /**
   * 右上に「主催者 HOST」を出すか。一度主催者で入ったスマホにだけ出す（参加者には見せない）。
   * 出していないスマホでは、題「URAFESS」を長押しすると入口が開く
   */
  visible: boolean;
}

/** 題の長押しで主催者の入口が開くまで */
const DOOR_HOLD_MS = 1500;

export function createJoin(actions: EntryActions, door: HostDoor = { href: '/host', visible: false }): JoinScreen {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    ${door.visible ? `<a class="door" href="${esc(door.href)}">${say(['主催者', 'HOST'])}</a>` : ''}
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
    <section data-mode="wait" hidden>
      <p class="lead" data-k="waitLead"></p>
      <button type="button" data-a="stop">${say(['やめる', 'CANCEL'])}</button>
    </section>
    <div class="spacer"></div>
    <p class="note" data-k="foot">${sent(['ホーム画面に追加したアプリから開く。LINEの中では開かない', 'Open it from the app on your home screen, not inside LINE'])}</p>
    <button type="button" class="quiet" data-a="forget" hidden>${say(['別の人として入る', 'JOIN AS SOMEONE ELSE'])}</button>
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
  // 題の長押し：主催者の入口。画面には何も出さない（参加者には見せない道）
  const title = el.querySelector('h1')!;
  let hold: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (hold !== null) clearTimeout(hold);
    hold = null;
  };
  title.addEventListener('pointerdown', () => {
    release();
    hold = setTimeout(() => location.assign(door.href), DOOR_HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) title.addEventListener(type, release);
  title.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    switch (a) {
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

  return {
    el,
    update({ mode: next, busy, error, name }) {
      if (next !== mode) {
        mode = next;
        for (const s of sections) s.hidden = s.dataset.mode !== next;
        if (next === 'name') setTimeout(() => input.focus(), 0);
      }
      if (next === 'taken' || next === 'wait') takenName = name ?? '';
      const t = esc(takenName);
      setOnce('takenLead', sent([`「${t}」は、前に来た人の名前`, `"${t}" is a name from a past night`]));
      setOnce('waitLead', sent([`主催者が「${t}」とつなぐのを待っている。主催者に声をかける`, `Waiting for the host to reconnect "${t}". Tell the host`]));
      setOnce('me', busy && next === 'known' ? say(['入っている…', 'JOINING…']) : esc(name ?? ''), me);
      me.disabled = busy;
      submit.disabled = busy;
      setOnce('submit', say(busy && next === 'name' ? ['参加しています…', 'JOINING…'] : ['参加する', 'JOIN']), submit);
      forget.hidden = next !== 'known';
      for (const err of errors) {
        const show = !!error && err.closest('section')?.dataset.mode === next;
        err.hidden = !show;
        err.textContent = show ? error : '';
      }
    },
  };
}
