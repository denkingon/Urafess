import './chat.css';
import { CHAT_MODE_NAME, chatText, HQ_TEXT_MAX, PLACE_NAME_MAX, PLACES_MAX, type ChatJail, type ChatMode, type ChatMsg } from '../../shared/chat';
import type { GameView } from '../../shared/protocol';
import type { ClientState } from '../core/game-client';

/**
 * チャット（本部・主催者の側）。
 *
 * - 流れ：全部の回線が見える（鬼の回線・逃走者の回線・本部あて・本部から）。札で絞れる
 * - 送る：本部は文字で打てる。あて先は 全員・鬼・逃走者・1人（本部あての1通の「返事」を押す）
 * - 制約：仲間の回線で送れるもの（札／絵文字／数字／送れない）と、牢屋の人（絵文字だけ／同じ）を切り替える。場所の名前を変える
 */

export interface ChatHostActions {
  chat(to: string, text: string): boolean;
  command(op: 'chat-mode' | 'chat-places', extra: { chatMode?: ChatMode; chatJail?: ChatJail; places?: string[] }): void;
}

export interface ChatHostInput {
  game: GameView | null;
  chat?: ClientState['chat'];
  online: boolean;
}

export interface ChatHostScreen {
  /** 流れと、送る欄 */
  feed: HTMLElement;
  /** 制約と場所の名前 */
  settings: HTMLElement;
  update(input: ChatHostInput): void;
  /** 本部あてで、まだ返事も「見た」もしていない分（古い順） */
  pending(): ChatMsg[];
  dismiss(id: number): void;
  /** その1通の人を、返事のあて先にする */
  replyTo(id: number): void;
}

type Filter = 'all' | 'oni' | 'runner' | 'hq';
const FILTERS: [Filter, string][] = [['all', '全部'], ['oni', '鬼'], ['runner', '逃走者'], ['hq', '本部']];
const MODES: ChatMode[] = ['card', 'emoji', 'digit', 'off'];
/** 4つ並べる札の上の短い名前 */
const MODE_SHORT: Record<ChatMode, string> = { card: '札', emoji: '絵文字', digit: '数字', off: 'なし' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clock = (at: number) => {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function createChatHost(actions: ChatHostActions): ChatHostScreen {
  const feed = document.createElement('section');
  feed.className = 'cap-host chat-host';
  feed.dataset.k = 'chatFeed';
  feed.innerHTML = `
    <div class="cap-host-head"><b>チャット</b><span data-c="count"></span></div>
    <div class="seg chat-filter" role="group" aria-label="見る回線">
      ${FILTERS.map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${k === 'all'}">${label}</button>`).join('')}
    </div>
    <ol class="chat-feed" data-c="list" aria-live="polite"></ol>
    <form data-c="form">
      <div class="seg chat-to" role="group" aria-label="あて先">
        <button type="button" data-to="all" aria-pressed="true">全員へ</button>
        <button type="button" data-to="oni" aria-pressed="false">鬼へ</button>
        <button type="button" data-to="runner" aria-pressed="false">逃走者へ</button>
        <button type="button" data-to="one" aria-pressed="false" hidden></button>
      </div>
      <div class="chat-line">
        <input type="text" maxlength="${HQ_TEXT_MAX}" placeholder="本部から送る（${HQ_TEXT_MAX}字まで）" aria-label="本部から送る文" enterkeyhint="send" autocomplete="off">
        <button type="submit" class="primary">送る</button>
      </div>
    </form>
  `;
  const settings = document.createElement('section');
  settings.className = 'cap-host chat-host chat-set';
  settings.dataset.k = 'chatSet';
  settings.innerHTML = `
    <div class="cap-host-head"><b>チャットの制約</b><span data-c="now"></span></div>
    <div class="seg" role="group" aria-label="仲間の回線で送れるもの">
      ${MODES.map((m) => `<button type="button" data-mode="${m}" aria-pressed="false" aria-label="${CHAT_MODE_NAME[m]}">${MODE_SHORT[m]}</button>`).join('')}
    </div>
    <div class="chat-jail">
      <span>牢屋の人</span>
      <div class="seg" role="group" aria-label="牢屋の人が送れるもの">
        <button type="button" data-jail="emoji" aria-pressed="false">絵文字だけ</button>
        <button type="button" data-jail="same" aria-pressed="false">外と同じ</button>
      </div>
    </div>
    <p class="note">参加者は文字を打てない。仲間の回線（鬼どうし・逃走者どうし）で送れるものを、ここで決める。試合中でも、押した瞬間から全員に効く。本部あての札（本部、来て・アプリが動かない・ルールを教えて）は、どの制約でも送れる。</p>
    <form data-c="places">
      <label for="chat-places">場所の名前（札「○○で合流しよう」「○○に相手がいる」に入る。1行に1つ・${PLACES_MAX}個まで・${PLACE_NAME_MAX}字まで）</label>
      <textarea id="chat-places" rows="5" autocomplete="off" spellcheck="false"></textarea>
      <button type="submit">場所の名前を変える</button>
    </form>
  `;
  const c = (root: HTMLElement, k: string) => root.querySelector(`[data-c="${k}"]`) as HTMLElement;
  const list = c(feed, 'list');
  const form = c(feed, 'form') as HTMLFormElement;
  const input = form.querySelector('input')!;
  const oneBtn = form.querySelector('[data-to="one"]') as HTMLButtonElement;
  const placesForm = c(settings, 'places') as HTMLFormElement;
  const placesBox = placesForm.querySelector('textarea')!;

  let filter: Filter = 'all';
  let to = 'all';
  /** 1人への返事のあて先 */
  let one: { pid: string; name: string } | null = null;
  let msgs: ChatMsg[] = [];
  const dismissed = new Set<number>();
  let started = false;
  let editingPlaces = false;
  let placesKey = '';
  let listKey = '';

  const setTo = (v: string) => {
    to = v;
    for (const b of form.querySelectorAll('[data-to]') as NodeListOf<HTMLButtonElement>) {
      b.setAttribute('aria-pressed', String(b.dataset.to === (v.startsWith('pid:') ? 'one' : v)));
    }
  };
  const setOne = (m: ChatMsg) => {
    if (!m.pid || !m.from) return;
    one = { pid: m.pid, name: m.from.name };
    oneBtn.hidden = false;
    oneBtn.textContent = `${one.name} へ`;
    setTo(`pid:${one.pid}`);
    input.focus();
  };

  feed.querySelector('.chat-filter')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.filter) return;
    filter = b.dataset.filter as Filter;
    for (const x of feed.querySelectorAll('[data-filter]')) x.setAttribute('aria-pressed', String(x === b));
    listKey = '';
  });
  form.querySelector('.chat-to')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.to) return;
    setTo(b.dataset.to === 'one' ? (one ? `pid:${one.pid}` : 'all') : b.dataset.to);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (!actions.chat(to, text)) return;
    // 1人に返事をしたら、その人の本部あては済みにする
    if (to.startsWith('pid:')) for (const m of msgs) if (m.pid === to.slice(4) && m.from) dismissed.add(m.id);
    input.value = '';
  });
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-reply]') as HTMLButtonElement | null;
    const m = b ? msgs.find((x) => x.id === Number(b.dataset.reply)) : undefined;
    if (m) setOne(m);
  });
  settings.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    if (b.dataset.mode) actions.command('chat-mode', { chatMode: b.dataset.mode as ChatMode });
    else if (b.dataset.jail) actions.command('chat-mode', { chatJail: b.dataset.jail as ChatJail });
  });
  placesBox.addEventListener('focus', () => (editingPlaces = true));
  placesForm.addEventListener('submit', (e) => {
    e.preventDefault();
    editingPlaces = false;
    placesKey = '';
    const places = placesBox.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (places.length) actions.command('chat-places', { places });
  });

  const isPending = (m: ChatMsg) =>
    m.ch === 'hq' && m.from !== null && !dismissed.has(m.id) && !msgs.some((r) => r.from === null && r.pid === m.pid && r.scope === 'hq' && r.id > m.id);

  return {
    feed,
    settings,
    pending: () => msgs.filter(isPending),
    dismiss: (id) => void dismissed.add(id),
    replyTo: (id) => {
      const m = msgs.find((x) => x.id === id);
      if (m) setOne(m);
    },
    update({ game, chat, online }) {
      const rules = game?.chat;
      const on = !!rules && !!chat;
      feed.hidden = !on;
      settings.hidden = !on;
      if (!on) return;
      msgs = chat!.msgs;
      // 開いたときにもうあった本部あては、済みとして扱う（開き直すたびに要対応が戻らないように）
      if (!started) {
        started = true;
        for (const m of msgs) dismissed.add(m.id);
      }
      form.querySelector('button[type="submit"]')!.toggleAttribute('disabled', !online);

      const shown = msgs.filter((m) =>
        filter === 'all' ? true : filter === 'hq' ? m.ch === 'hq' : m.ch === 'team' && m.scope === filter,
      );
      const key = `${filter}|${shown.map((m) => `${m.id}${isPending(m) ? '!' : ''}`).join(',')}`;
      if (key !== listKey) {
        listKey = key;
        list.innerHTML =
          shown
            .map((m) => {
              const line = m.ch === 'team' ? (m.scope === 'oni' ? 'oni' : 'runner') : 'hq';
              const mark = line === 'oni' ? '鬼' : line === 'runner' ? '逃' : '本部';
              const who = m.from
                ? `${esc(m.from.name)}${m.ch === 'hq' ? ' → 本部' : ''}`
                : `本部 → ${m.scope === 'all' ? '全員' : m.scope === 'oni' ? '鬼' : m.scope === 'runner' ? '逃走者' : esc(m.toName ?? '1人')}`;
              const reply = m.ch === 'hq' && m.from && m.pid ? `<button type="button" class="ghost" data-reply="${m.id}">返事</button>` : '';
              return `<li data-line="${line}"${isPending(m) ? ' class="is-pending"' : ''}><span class="chat-mark">${mark}</span>`
                + `<span class="chat-body"><span class="chat-who">${who}${m.jail ? '（牢屋）' : ''}<time>${clock(m.at)}</time></span>`
                + `<span class="chat-what">${esc(chatText(m)[0])}${m.pos ? '<small>位置つき</small>' : ''}</span></span>${reply}</li>`;
            })
            .join('') || '<li class="chat-empty">まだ何も無い</li>';
        list.scrollTop = list.scrollHeight;
      }
      c(feed, 'count').textContent = `${msgs.length}通（画面に残る分）`;

      c(settings, 'now').textContent = `いま：${CHAT_MODE_NAME[rules!.mode]}`;
      for (const b of settings.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.mode === rules!.mode));
      for (const b of settings.querySelectorAll('[data-jail]')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.jail === rules!.jail));
      const pk = rules!.places.join('\n');
      if (!editingPlaces && pk !== placesKey) {
        placesKey = pk;
        placesBox.value = pk;
      }
    },
  };
}
