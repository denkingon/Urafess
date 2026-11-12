import { HANDOFF_TTL_MS, type AccountError, type AccountView } from '../../shared/account';
import type { Identity } from '../core/game-client';
import { esc, glyph, say, sent, setHTML } from '../ui';

/**
 * 自分のページ（ステータスと設定）。名前のボタンの画面と、試合の外の参加者の画面から開く。
 * 上＝名前と来た夜の帯、真ん中＝役と捕獲の数、下＝設定（名前を変える・新しいスマホへ移す・このスマホから出る・名簿から消える）。
 * 数はサーバーの記録から数える（/api/game/<id>/me）。
 */

export interface AccountDeps {
  gameId: string;
  identity(): Identity | null;
  /** 名前を変えた（このスマホの覚えている名前も替える） */
  renamed(name: string): void;
  /** このスマホから出る（名簿には残る） */
  forget(): void;
  close(): void;
}

export interface AccountScreen {
  el: HTMLElement;
  open(): void;
  /** inMatch：試合中で今夜に入っている（名前を変える・名簿から消えるはできない） */
  update(inMatch: boolean): void;
}

const ERROR_TEXT: Record<AccountError | 'network', [string, string]> = {
  unknown: ['このスマホの合い鍵が使えない。ほかのスマホへ移したかもしれない', 'This phone is no longer linked to you'],
  invalid: ['名前は1〜20文字', 'Names are 1–20 characters'],
  taken: ['その名前は名簿のほかの人のもの', 'Someone on the list already has that name'],
  busy: ['試合中はできない。結果のあとで', 'Not during a match. Try after the result'],
  'bad-code': ['合言葉が違うか、切れている。古いスマホでもう一度出す', 'Wrong or expired code. Get a new one on your old phone'],
  locked: ['打ち間違いが多い。10分たってから', 'Too many tries. Wait 10 minutes'],
  'bad-input': ['うまく送れなかった', 'Something went wrong'],
  network: ['つながらない。電波のいい所でもう一度', 'Offline. Try again with a better signal'],
};

export function errorText(e: AccountError | 'network'): string {
  const [ja, en] = ERROR_TEXT[e] ?? ERROR_TEXT['bad-input'];
  return `${ja}／${en}`;
}

/** /api/game/<id>/me に頼む。答えか、断られた理由を返す */
export async function callAccount<T>(
  gameId: string,
  method: 'GET' | 'POST',
  identity: Identity | null,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; error: AccountError | 'network' }> {
  try {
    const headers: Record<string, string> = {};
    if (identity) {
      headers['x-pid'] = identity.pid;
      headers['x-key'] = identity.key;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`/api/game/${gameId}/me`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const json = (await r.json().catch(() => ({}))) as { error?: AccountError } & T;
    if (!r.ok || json.error) return { ok: false, error: json.error ?? 'bad-input' };
    return { ok: true, value: json };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export function createAccount(deps: AccountDeps): AccountScreen {
  const el = document.createElement('main');
  el.className = 'phone join account';
  el.innerHTML = `
    <div class="ac-top">
      <button type="button" class="quiet ac-back" data-a="close">${say(['← もどる', 'BACK'])}</button>
    </div>
    <h1 class="ac-name" data-k="name"></h1>
    <p class="note" data-k="since"></p>

    <section class="ac-stats" aria-live="polite">
      <div class="ac-loading" data-k="loading">${sent(['記録を読んでいる…', 'Loading your record…'])}</div>
      <div data-k="stats" hidden>
        <div class="ac-nights">
          <div class="ac-big"><span class="u" data-k="nightsN"></span><span class="ac-unit">${say(['夜', 'NIGHTS'])}</span></div>
          <div class="ac-strip" data-k="strip"></div>
        </div>
        <div class="ac-grid">
          <div class="ac-tile oni"><span class="ac-ic">${glyph.oni}</span><span class="u" data-k="oni"></span><span class="ac-lbl">${say(['鬼', 'CHASER'])}</span></div>
          <div class="ac-tile run"><span class="ac-ic">${glyph.runner}</span><span class="u" data-k="runner"></span><span class="ac-lbl">${say(['逃走者', 'RUNNER'])}</span></div>
          <div class="ac-tile"><span class="u" data-k="caught"></span><span class="ac-lbl">${say(['捕まえた', 'CAUGHT'])}</span></div>
          <div class="ac-tile"><span class="u" data-k="gotCaught"></span><span class="ac-lbl">${say(['捕まった', 'GOT CAUGHT'])}</span></div>
          <div class="ac-tile"><span class="u" data-k="freed"></span><span class="ac-lbl">${say(['助けた', 'FREED'])}</span></div>
        </div>
      </div>
      <p class="error" data-k="loadError" hidden></p>
    </section>

    <h2 class="ac-h">${say(['設定', 'SETTINGS'])}</h2>

    <section class="ac-set">
      <form data-k="renameForm">
        <label for="ac-rename">${say(['名前を変える', 'CHANGE NAME'])}</label>
        <div class="ac-row">
          <input id="ac-rename" name="name" type="text" maxlength="20" autocomplete="nickname" required>
          <button type="submit" data-k="renameBtn">${say(['変える', 'SAVE'])}</button>
        </div>
        <p class="note" data-k="renameNote"></p>
        <p class="error" data-k="renameError" hidden></p>
      </form>
    </section>

    <section class="ac-set">
      <button type="button" data-a="handoff">${say(['新しいスマホへ移す', 'MOVE TO A NEW PHONE'])}</button>
      <div class="ac-code" data-k="code" hidden>
        <p class="note">${sent(['新しいスマホでアプリを開き、「前のスマホから移す」を押してこの6桁を打つ', 'On the new phone, open the app, tap “Move from your old phone” and type these 6 digits'])}</p>
        <div class="ac-digits u" data-k="digits"></div>
        <p class="note" data-k="left"></p>
      </div>
      <p class="error" data-k="handoffError" hidden></p>
    </section>

    <section class="ac-set">
      <button type="button" data-a="forget">${say(['このスマホから出る', 'SIGN OUT ON THIS PHONE'])}</button>
      <p class="note">${sent(['このスマホが名前を忘れる。名簿と記録は残る。次は同じ名前を入れて、主催者につないでもらう', 'This phone forgets you. Your record stays. Next time, type your name and the host reconnects you'])}</p>
    </section>

    <section class="ac-set">
      <button type="button" class="danger" data-a="leave">${say(['名簿から消える', 'LEAVE THE LIST'])}</button>
      <p class="note">${sent(['名前が空き、記録の名前は「消えた人」になる。元に戻せない', 'Your name is freed and your record becomes “gone”. This cannot be undone'])}</p>
      <p class="error" data-k="leaveError" hidden></p>
    </section>
  `;
  const q = <T extends HTMLElement = HTMLElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
  const input = el.querySelector('#ac-rename') as HTMLInputElement;
  const renameBtn = q<HTMLButtonElement>('renameBtn');
  const leaveBtn = el.querySelector('[data-a="leave"]') as HTMLButtonElement;
  const handoffBtn = el.querySelector('[data-a="handoff"]') as HTMLButtonElement;
  let view: AccountView | null = null;
  let loading = false;
  let busy = false;
  let inMatchNow = false;
  let code: { code: string; until: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const showError = (k: string, e: AccountError | 'network' | null) => {
    const p = q(k);
    p.hidden = !e;
    p.textContent = e ? errorText(e) : '';
  };

  const render = () => {
    const id = deps.identity();
    const name = view?.name ?? id?.name ?? '';
    setHTML(q('name'), esc(name));
    setHTML(q('since'), view ? sent([`名簿に入った夜 ${dateLabel(view.since)}`, `On the list since ${dateLabel(view.since)}`]) : '');
    q('loading').hidden = !loading || !!view;
    q('stats').hidden = !view;
    if (view) {
      const s = view.stats;
      setHTML(q('nightsN'), String(s.nightsHere));
      setHTML(
        q('strip'),
        s.nights
          .map((n) => `<div class="ac-n${n.here ? ' here' : ''}" title="${esc(n.label)}"><i></i><span>${esc(n.label)}</span></div>`)
          .join(''),
      );
      setHTML(q('oni'), String(s.roles.oni));
      setHTML(q('runner'), String(s.roles.runner));
      setHTML(q('caught'), String(s.caught));
      setHTML(q('gotCaught'), String(s.gotCaught));
      setHTML(q('freed'), String(s.freed));
    }
    const locked = inMatchNow || (view?.busy ?? false);
    renameBtn.disabled = busy || locked;
    input.disabled = busy || locked;
    leaveBtn.disabled = busy || locked;
    handoffBtn.disabled = busy;
    setHTML(q('renameNote'), locked ? sent(['試合中は変えられない。結果のあとで', 'Not during a match']) : sent(['名前は名簿の中で1人1つ', 'Each name belongs to one person']));
    // 合言葉と残り時間
    const left = code ? code.until - Date.now() : 0;
    q('code').hidden = !code || left <= 0;
    if (code && left > 0) {
      setHTML(q('digits'), `${code.code.slice(0, 3)}<span class="sp"></span>${code.code.slice(3)}`);
      const m = Math.floor(left / 60_000);
      const sec = Math.floor((left % 60_000) / 1000);
      setHTML(q('left'), sent([`あと ${m}:${String(sec).padStart(2, '0')}。1回だけ使える`, `${m}:${String(sec).padStart(2, '0')} left. One use only`]));
    }
  };

  const load = async () => {
    const id = deps.identity();
    if (!id) return;
    loading = true;
    showError('loadError', null);
    render();
    const r = await callAccount<AccountView>(deps.gameId, 'GET', id);
    loading = false;
    if (r.ok) {
      view = r.value;
      if (r.value.name !== id.name) deps.renamed(r.value.name);
    } else {
      showError('loadError', r.error);
    }
    render();
  };

  el.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || busy) return;
    busy = true;
    showError('renameError', null);
    render();
    const r = await callAccount<{ name: string }>(deps.gameId, 'POST', deps.identity(), { op: 'rename', name });
    busy = false;
    if (r.ok) {
      deps.renamed(r.value.name);
      if (view) view = { ...view, name: r.value.name };
      input.value = '';
      input.blur();
    } else {
      showError('renameError', r.error);
    }
    render();
  });

  el.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    if (!a || busy) return;
    if (a === 'close') {
      deps.close();
    } else if (a === 'handoff') {
      busy = true;
      showError('handoffError', null);
      render();
      const r = await callAccount<{ code: string; until: number }>(deps.gameId, 'POST', deps.identity(), { op: 'handoff' });
      busy = false;
      if (r.ok) {
        // サーバーの時刻ではなく、このスマホの時計で残り時間を数える（受け取った瞬間から、少し短めに）
        code = { code: r.value.code, until: Date.now() + HANDOFF_TTL_MS - 5_000 };
      } else {
        showError('handoffError', r.error);
      }
      render();
    } else if (a === 'forget') {
      if (confirm('このスマホから出る。名簿と記録は残る。いいか？\nSign out on this phone? Your record stays.')) deps.forget();
    } else if (a === 'leave') {
      const name = deps.identity()?.name ?? '';
      if (!confirm(`「${name}」を名簿から消す。名前は空き、記録の名前は「消えた人」になる。元に戻せない。消すか？\nLeave the list? This cannot be undone.`)) return;
      busy = true;
      showError('leaveError', null);
      render();
      const r = await callAccount<{ ok: true }>(deps.gameId, 'POST', deps.identity(), { op: 'leave' });
      busy = false;
      if (r.ok) deps.forget();
      else showError('leaveError', r.error);
      render();
    }
  });

  return {
    el,
    open() {
      view = null;
      code = null;
      input.value = '';
      for (const k of ['renameError', 'handoffError', 'leaveError', 'loadError']) showError(k, null);
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!el.isConnected) {
          clearInterval(timer!);
          timer = null;
          return;
        }
        if (code) render();
      }, 1000);
      el.scrollTop = 0;
      window.scrollTo(0, 0);
      void load();
    },
    update(inMatch) {
      if (inMatch === inMatchNow && el.dataset.drawn) return;
      inMatchNow = inMatch;
      el.dataset.drawn = '1';
      render();
    },
  };
}

/** 2026-11-06 21:30（日本時間）→ 11/6 */
function dateLabel(at: number): string {
  const d = new Date(at + 9 * 3600_000 - 6 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
