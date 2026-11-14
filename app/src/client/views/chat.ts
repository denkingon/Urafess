import './chat.css';
import {
  CARDS,
  CHAT_GAP_MS,
  chatText,
  DIGIT_MAX,
  EMOJI,
  EMOJI_MAX,
  teamInput,
  teamOpen,
  type CardDef,
  type ChatCh,
  type ChatMode,
  type ChatMsg,
} from '../../shared/chat';
import { bearingDeg, compassName, compassNameEn, distanceM, distanceText, distanceTextEn } from '../../shared/run';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState, GameClient } from '../core/game-client';
import type { Sensors } from '../sense';
import { esc, say, sent, setHTML, type Pair } from '../ui';

/**
 * チャット（見た目の層）。参加者の画面に、長押しの板のすぐ上の「1行の帯」と、開いたときの「板」を差し込む。
 *
 * - 帯：いちばん新しい1通と、まだ見ていない数。押すと開く
 * - 板：真ん中の絵の場所に出る（段階バーと残り時間、いちばん下の長押しの板は出したまま。開いていても「捕まった」が押せる）
 * - キーボードは出さない。送れるのは札・絵文字・数字のどれか（主催者が決める。牢屋の人は絵文字だけ）
 * - 札の代入：「ここにいる！」は自分の位置、「◯◯、一緒に来て！」は仲間を選ぶ、「◯◯で合流しよう」は場所を選ぶ
 */

export interface ChatDeps {
  client: Pick<GameClient, 'chat'>;
  sensors: Pick<Sensors, 'position'>;
  /** 参加者の画面の根っこ（開いている間 is-chat を付けて、真ん中の絵をしまう） */
  root: HTMLElement;
}

export interface ChatScreen {
  strip: HTMLElement;
  panel: HTMLElement;
  update(view: PhoneView | null, state: Pick<ClientState, 'phase' | 'online' | 'game' | 'me' | 'chat'>, serverNow: number): void;
}

/** 板の下に出す入力。closed＝この試合の会話は終わった（読むだけ）、hq＝本部あての札 */
type Pad = ChatMode | 'closed' | 'hq';

const BUBBLE =
  '<svg class="gl" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M14 16h72a8 8 0 0 1 8 8v40a8 8 0 0 1-8 8H48L26 90V72H14a8 8 0 0 1-8-8V24a8 8 0 0 1 8-8z"/></svg>';

const RULE: Record<Pad, Pair> = {
  card: ['札だけ送れる', 'CARDS ONLY'],
  emoji: ['絵文字だけ送れる', 'EMOJI ONLY'],
  digit: ['数字だけ送れる', 'DIGITS ONLY'],
  off: ['いまは送れない', 'CHAT IS OFF'],
  closed: ['この試合の会話は終わった', 'THIS ROUND IS OVER'],
  hq: ['本部にだけ届く', 'ONLY HQ SEES THIS'],
};

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 震えない端末
  }
}

const clock = (at: number) => {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function createChat({ client, sensors, root }: ChatDeps): ChatScreen {
  const strip = document.createElement('button');
  strip.type = 'button';
  strip.className = 'chat-strip';
  strip.hidden = true;
  strip.innerHTML = `<span class="chat-ico">${BUBBLE}</span><span class="chat-last" data-k="last"></span><b class="chat-n u" data-k="n" hidden></b>`;

  const panel = document.createElement('section');
  panel.className = 'chat';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="chat-head">
      <div class="chat-tabs" role="tablist">
        <button type="button" role="tab" data-tab="team">${say(['仲間', 'TEAM'])}<i hidden></i></button>
        <button type="button" role="tab" data-tab="hq">${say(['本部', 'HQ'])}<i hidden></i></button>
      </div>
      <button type="button" class="chat-close" aria-label="チャットを閉じる">×</button>
    </div>
    <ol class="chat-list" data-k="list" aria-live="polite"></ol>
    <p class="chat-rule" data-k="rule"></p>
    <div class="chat-pad" data-k="pad"></div>
  `;
  const q = (el: HTMLElement, k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const list = q(panel, 'list');
  const pad = q(panel, 'pad');
  const tabBtn = { team: panel.querySelector('[data-tab="team"]') as HTMLButtonElement, hq: panel.querySelector('[data-tab="hq"]') as HTMLButtonElement };

  let open = false;
  let tab: ChatCh = 'team';
  /** 札を押して、仲間・場所を選んでいる途中 */
  let pick: CardDef | null = null;
  let emojiDraft: number[] = [];
  let digitDraft = '';
  /** それぞれの回線で、ここまで見た */
  const seen: Record<ChatCh, number> = { team: 0, hq: 0 };
  let sentAt = 0;
  /** いちばん新しい1通（帯を光らせるのに使う） */
  let newestId = 0;
  let flashUntil = 0;
  let started = false;
  let hadTeam = false;
  // いちばん新しい update の中身（押したときに使う）
  let cur: { pad: Pad; online: boolean; team: { num: number; name: string }[]; places: string[] } | null = null;

  const setOpen = (v: boolean) => {
    open = v;
    pick = null;
  };
  strip.addEventListener('click', () => setOpen(true));
  panel.querySelector('.chat-close')!.addEventListener('click', () => setOpen(false));
  for (const key of ['team', 'hq'] as const) {
    tabBtn[key].addEventListener('click', () => {
      tab = key;
      pick = null;
    });
  }

  const afterSend = (ok: boolean) => {
    if (!ok) return;
    sentAt = Date.now();
    pick = null;
    emojiDraft = [];
    digitDraft = '';
    vibrate(12);
  };
  const myPos = () => {
    const f = sensors.position(Date.now());
    return f ? { lat: f.lat, lon: f.lon, acc: f.acc } : null;
  };

  pad.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b || b.disabled || !cur || !cur.online) return;
    if (Date.now() - sentAt < CHAT_GAP_MS) return;
    const d = b.dataset;
    if (d.card) {
      const c = CARDS.find((x) => x.id === d.card);
      if (!c) return;
      if (c.pick) pick = c;
      else afterSend(client.chat({ ch: c.ch, card: c.id, pos: c.pos ? myPos() : null }));
    } else if (d.person && pick) {
      afterSend(client.chat({ ch: pick.ch, card: pick.id, person: Number(d.person), pos: pick.pos ? myPos() : null }));
    } else if (d.place !== undefined && pick) {
      afterSend(client.chat({ ch: pick.ch, card: pick.id, place: d.place }));
    } else if (d.act === 'back') {
      pick = null;
    } else if (d.emoji) {
      if (emojiDraft.length < EMOJI_MAX) emojiDraft = [...emojiDraft, Number(d.emoji)];
    } else if (d.digit) {
      if (digitDraft.length < DIGIT_MAX) digitDraft += d.digit;
    } else if (d.act === 'del') {
      emojiDraft = emojiDraft.slice(0, -1);
      digitDraft = digitDraft.slice(0, -1);
    } else if (d.act === 'send-emoji' && emojiDraft.length) {
      afterSend(client.chat({ ch: 'team', emoji: emojiDraft }));
    } else if (d.act === 'send-digit' && digitDraft) {
      afterSend(client.chat({ ch: 'team', digit: digitDraft }));
    }
  });

  /** 位置つきの1通：自分から見た方角と距離（自分の位置が取れていなければ「位置つき」） */
  const where = (m: ChatMsg, mine: boolean): string => {
    if (!m.pos || mine) return '';
    const me = sensors.position(Date.now());
    if (!me) return '位置つき';
    const deg = bearingDeg(me, m.pos);
    const dist = distanceM(me, m.pos);
    return dist < 15 ? `${distanceText(dist)} ${distanceTextEn(dist)}` : `${compassName(deg)} ${compassNameEn(deg)} ${distanceText(dist)}`;
  };

  const cardBtn = (c: CardDef) => {
    // 選ぶ札は、代入するところを ○○ で見せる
    const blank = (s: string) => s.replace('{person}', '○○').replace('{place}', '○○');
    return `<button type="button" class="chat-card" data-card="${c.id}"${c.pick ? ' data-pick="1"' : ''}>${say([blank(c.text[0]), blank(c.text[1])])}</button>`;
  };

  function padHTML(kind: Pad, c: NonNullable<typeof cur>): string {
    if (kind === 'off' || kind === 'closed') return '';
    if (pick) {
      const items =
        pick.pick === 'person'
          ? c.team.map((t) => `<button type="button" class="chat-opt" data-person="${t.num}">${esc(t.name)}</button>`)
          : c.places.map((p) => `<button type="button" class="chat-opt" data-place="${esc(p)}">${esc(p)}</button>`);
      const empty = pick.pick === 'person' ? sent(['仲間がいない', 'No teammates']) : sent(['場所がまだ無い', 'No places yet']);
      return `<p class="chat-ask">${say(pick.pick === 'person' ? ['だれ？', 'WHO?'] : ['どこ？', 'WHERE?'])}</p>
        <div class="chat-opts">${items.join('') || `<p class="chat-none">${empty}</p>`}</div>
        <button type="button" class="chat-back" data-act="back">${say(['戻る', 'BACK'])}</button>`;
    }
    if (kind === 'card' || kind === 'hq') {
      return `<div class="chat-cards">${CARDS.filter((x) => x.ch === (kind === 'hq' ? 'hq' : 'team')).map(cardBtn).join('')}</div>`;
    }
    if (kind === 'emoji') {
      return `<div class="chat-emoji">${EMOJI.map((e, i) => `<button type="button" data-emoji="${i}">${e}</button>`).join('')}</div>
        <div class="chat-go"><div class="chat-draft" aria-label="送る絵文字">${emojiDraft.map((i) => EMOJI[i]).join('') || '<span class="chat-ph">…</span>'}</div>
        <button type="button" data-act="del" aria-label="1つ消す">⌫</button><button type="button" class="chat-send" data-act="send-emoji"${emojiDraft.length ? '' : ' disabled'}>${say(['送る', 'SEND'])}</button></div>`;
    }
    return `<div class="chat-digits">${'1234567890'.split('').map((n) => `<button type="button" class="u" data-digit="${n}">${n}</button>`).join('')}</div>
      <div class="chat-go"><div class="chat-draft u" aria-label="送る数字">${esc(digitDraft) || '<span class="chat-ph">…</span>'}</div>
      <button type="button" data-act="del" aria-label="1つ消す">⌫</button><button type="button" class="chat-send" data-act="send-digit"${digitDraft ? '' : ' disabled'}>${say(['送る', 'SEND'])}</button></div>`;
  }

  return {
    strip,
    panel,
    update(view, state, serverNow) {
      const game = state.game;
      const me = state.me;
      const rules = game?.chat;
      const on = state.phase === 'ready' && !!game && !!me && !!rules && !!state.chat && !me.removed && view?.ended !== true;
      if (!on) {
        open = false;
        pick = null;
        started = false;
        strip.hidden = true;
        panel.hidden = true;
        root.classList.remove('is-chat');
        return;
      }
      const msgs = state.chat!.msgs;
      const hasTeam = me!.role !== null;
      // 役が決まったら仲間の回線を前に出す。役が無い間（待合室・見学）は本部だけ
      if (hasTeam && !hadTeam) tab = 'team';
      hadTeam = hasTeam;
      if (!hasTeam && tab === 'team') tab = 'hq';
      const mine = (m: ChatMsg) => m.from?.num === me!.num;

      // 最初に届いた分（つなぎ直して届いた前からの分）は「見た」ことにする。そこから先が新しい分
      if (!started) {
        started = true;
        for (const m of msgs) seen[m.ch] = Math.max(seen[m.ch], m.id);
        newestId = msgs.at(-1)?.id ?? 0;
      }
      const last = msgs.at(-1) ?? null;
      if (last && last.id > newestId) {
        newestId = last.id;
        if (!mine(last) && !open) {
          flashUntil = Date.now() + 4_000;
          vibrate(30);
        }
      }
      if (open) for (const m of msgs) if (m.ch === tab) seen[tab] = Math.max(seen[tab], m.id);
      const unread = { team: 0, hq: 0 };
      for (const m of msgs) if (m.id > seen[m.ch] && !mine(m) && (m.ch !== 'team' || hasTeam)) unread[m.ch]++;

      // ---- 帯 ----
      strip.hidden = open;
      const total = unread.team + unread.hq;
      const lastText = last ? `${last.from ? last.from.name : '本部'}：${chatText(last)[0]}` : '';
      setHTML(q(strip, 'last'), last ? `<span class="ja">${esc(lastText)}</span>` : say(['話す', 'TALK']));
      const n = q(strip, 'n');
      n.hidden = total === 0;
      if (n.textContent !== String(total)) n.textContent = String(total);
      strip.classList.toggle('is-new', Date.now() < flashUntil);
      strip.setAttribute('aria-label', `チャットを開く${total ? `（新しい ${total}通）` : ''}`);

      // ---- 板 ----
      panel.hidden = !open;
      root.classList.toggle('is-chat', open);
      if (!open) return;
      for (const key of ['team', 'hq'] as const) {
        tabBtn[key].hidden = key === 'team' && !hasTeam;
        tabBtn[key].setAttribute('aria-selected', String(tab === key));
        const badge = tabBtn[key].querySelector('i') as HTMLElement;
        const count = tab === key ? 0 : unread[key];
        badge.hidden = count === 0;
        if (badge.textContent !== String(count)) badge.textContent = String(count);
      }
      const kind: Pad = tab === 'hq' ? 'hq' : teamOpen(game!, serverNow) ? teamInput(rules!.mode, rules!.jail, me!.caught != null) : 'closed';
      cur = { pad: kind, online: state.online, team: state.chat!.team, places: rules!.places };
      panel.dataset.pad = kind;

      const shown = msgs.filter((m) => m.ch === tab);
      const listKey = shown
        .map((m) => {
          const [ja, en] = chatText(m);
          const cls = [mine(m) ? 'is-mine' : '', m.from ? '' : 'is-hq', m.jail ? 'is-jail' : '', m.kind !== 'card' && m.kind !== 'text' ? 'is-big' : ''].filter(Boolean).join(' ');
          const who = m.from ? esc(m.from.name) : `本部${m.toName ? ` → ${esc(m.toName)}` : ''}`;
          const w = where(m, mine(m));
          return `<li class="${cls}"><span class="chat-who">${who}${m.jail ? '<small>牢屋</small>' : ''}<time>${clock(m.at)}</time></span>`
            + `<span class="chat-what">${esc(ja)}${m.kind === 'card' && en ? `<small class="u">${esc(en)}</small>` : ''}</span>`
            + (w ? `<span class="chat-where u">${esc(w)}</span>` : '') + '</li>';
        })
        .join('');
      const empty = tab === 'hq' ? sent(['本部からの知らせがここに出る', 'Messages from HQ appear here']) : sent(['まだ何も無い', 'Nothing yet']);
      const html = listKey || `<li class="chat-empty">${empty}</li>`;
      if (list.dataset.html !== html) {
        setHTML(list, html);
        list.scrollTop = list.scrollHeight;
      }

      const jailed = kind === 'emoji' && rules!.mode !== 'emoji';
      setHTML(q(panel, 'rule'), state.online ? say(jailed ? ['牢屋：絵文字だけ', 'JAIL: EMOJI'] : RULE[kind]) : sent(['通信が切れている。つながったら送れる', 'Offline. Send when it reconnects']));
      setHTML(pad, padHTML(kind, cur));
      panel.classList.toggle('is-cool', Date.now() - sentAt < CHAT_GAP_MS);
      panel.classList.toggle('is-offline', !state.online);
    },
  };
}
