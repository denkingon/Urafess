import './hq.css';
import { AREA_OUT_CONFIRM_MS, AREA_OUT_MARGIN_M, isFarOutside } from '../../shared/area';
import { zoneAt } from '../../shared/shrink';
import { HOLD_MIN_MS, MATES_SEND_EVERY_MS, MATES_STALE_MS, PHASES, RESCUE_IMMUNE_MS, RUN_STALE_MS, RUN_STOP_MS } from '../../shared/rules';
import { formatClock, isDone, positionAt } from '../../shared/schedule';
import { glowPhase, hostStatus } from '../../shared/viewmodel';
import { chatText } from '../../shared/chat';
import type { Sensors } from '../sense';
import { setFramePad } from './overview';
import { createTerm } from './term';
import { createNightPalette } from './night';
import { durationPicker, hqSelect, numberOptions, pickerRow } from './hq-picker';
import './night.css';
import './term.css';
import { createHost, type HostActions, type HostInput, type HostScreen } from './host';

/**
 * 本部（新しい主催者画面）。キャンバス「Urafess 本部（管理者画面）」の並びを、いまの主催者画面の上にかぶせる。
 *
 * しくみは前の主催者画面（createHost）をそのまま使う：中の部品（地図・捕獲と牢屋・ミッション・時間や割合の欄・ボタン）を
 * 地図と要約をダッシュボードにまとめ、タイムラインと進行操作を下に置く。
 * だから、押したときに起きることは前の画面と同じ。
 *
 * 決まり：
 * - 月白の板（塗り）は「返事を待っている」ものだけ。下の並び（押すもの）に出るのは、その段階で要るものだけ
 * - 要対応は、どの場所にいても、いちばん上の1件が選択肢つきで出る
 * - 幅の広い画面では要約を地図の横に置き、スマホでは縦に並べる
 */

type Tab = 'map' | 'people' | 'chat' | 'mission' | 'deck';
const TABS: [Tab, string][] = [['map', '地図'], ['people', '参加者'], ['chat', 'チャット'], ['mission', 'ミッション'], ['deck', 'ルール設定']];

/** 下の並びに出すボタンと重さ（wait＝月白の板、hold＝取り返しがつかない操作） */
type DockItem = [op: string, weight: 'wait' | 'norm' | 'hold'];
/** 下の並びでは短い名前で出す（押したときの確かめの文は前のまま） */
const SHORT: Record<string, string> = { reset: '配役に戻す', end: '夜を終える', clear: '新しい夜', csv: '記録を保存' };

const ONI = '<svg class="hq-m" viewBox="-14 -14 28 28" aria-hidden="true"><path d="M-5.5,-4 L-7.5,-12 L-1.5,-6 Z M5.5,-4 L7.5,-12 L1.5,-6 Z" fill="var(--shu)"/><circle r="6.5" fill="var(--shu)"/></svg>';
const RUN = '<svg class="hq-m" viewBox="-14 -14 28 28" aria-hidden="true"><circle r="6.5" fill="var(--tsuki)"/></svg>';

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function createHQ(actions: HostActions, sensors?: Sensors): HostScreen {
  // 地図は遊ぶ範囲ぴったりではなく、周りも見えるように余白を広げる
  setFramePad(0.26);
  const inner = createHost(actions, sensors);
  // 前の画面の根っこをそのまま使う（中の部品は、この根っこの下にある限り前のしくみのまま動く）
  const el = inner.el;
  el.classList.add('hq');
  const old = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;

  // ---------- 足すもの ----------
  const head = make('header', 'hq-head',
    '<h1>本部<span class="u">HQ</span></h1><div class="hq-head-r"><span data-hq="round"></span><span class="hq-conn" data-hq="conn"></span></div>');
  // ログ（端末のような窓）：記録を読める版のときだけ。窓は最後に根っこへ足す（「そのほか」に集められないように）
  let termEl: HTMLElement | null = null;
  if (actions.tailLog) {
    const tailLog = actions.tailLog;
    const term = createTerm((after, tail) => tailLog(after, tail));
    const openBtn = make('button', 'hq-term-open', '&gt;_ ログ');
    openBtn.type = 'button';
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.addEventListener('click', () => term.toggle());
    term.onChange = (on) => openBtn.setAttribute('aria-expanded', String(on));
    head.querySelector('.hq-head-r')!.append(openBtn);
    termEl = term.el;
  }
  const rail = make('ol', 'hq-rail');
  rail.setAttribute('aria-label', '段階');
  const steps = ['配役', ...PHASES.map(() => ''), '結果'].map((t) => {
    const li = make('li', '', `<span class="lbl">${t}</span><span class="bar"><i></i></span>`);
    rail.append(li);
    return { li, lbl: li.querySelector('.lbl') as HTMLElement, fill: li.querySelector('i') as HTMLElement };
  });
  const now = make('section', 'hq-now',
    '<div class="hq-now-l"><span class="hq-label" data-hq="label"></span><span class="hq-big" data-hq="big"></span><span class="hq-next" data-hq="next"></span></div>'
    + '<div class="hq-pips" data-hq="pips" role="img"></div>');
  const counts = make('ul', 'hq-counts',
    ['エントリー', '鬼', '逃走者', '捕まった人', 'スマホの許可', '戻りたい人'].map((label) => `<li><span>${label}</span><b class="u">0</b></li>`).join(''));
  counts.setAttribute('aria-label', '現在の人数（逃走者は捕まっていない人）');
  const countValues = counts.querySelectorAll('b');
  now.setAttribute('aria-label', 'いま');
  const strip = make('section', 'hq-strip');
  strip.setAttribute('aria-label', '要対応');
  strip.hidden = true;
  const body = make('div', 'hq-body');
  const panel = {} as Record<Tab, HTMLElement>;
  for (const [key, label] of TABS) {
    panel[key] = make('section', 'hq-panel');
    panel[key].dataset.panel = key;
    panel[key].setAttribute('aria-label', label);
    body.append(panel[key]);
  }
  const dock = make('div', 'hq-dock');
  const side = make('div', 'hq-dashboard-side');
  const grid = make('div', 'hq-dashboard-grid');
  grid.append(panel.map, side);
  side.append(panel.people, panel.chat);
  const dialogs = {
    people: make('dialog', 'hq-popover'),
    chat: make('dialog', 'hq-popover'),
  };
  const cards = { people: make('div', 'hq-popover-content'), chat: make('div', 'hq-popover-content'), mission: make('details', 'hq-dashboard-details') };
  for (const [key, label] of [['people', '参加者'], ['chat', 'チャット']] as const) {
    const dialog = dialogs[key];
    const title = make('h2', '', label);
    title.id = `hq-${key}-title`;
    dialog.setAttribute('aria-labelledby', title.id);
    const close = make('button', 'ghost', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    const header = make('header', 'hq-popover-head');
    header.append(title, close);
    dialog.append(header, cards[key]);
    const trigger = make('button', 'hq-popup-trigger', label);
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.addEventListener('click', () => dialog.showModal());
    panel[key].append(trigger, make('p', 'hq-summary', `<span data-hq="${key}Summary"></span>`));
  }
  panel.mission.append(make('h3', '', 'ミッション'), make('p', 'hq-summary', '<span data-hq="missionSummary"></span>'), cards.mission);
  cards.mission.append(make('summary', '', 'ミッションの詳細・操作'));
  const roster = make('div', 'hq-roster');
  cards.people.append(roster);
  // ---------- 前の部品を4つの場所へ ----------
  const hide = (sel: string) => old(sel)?.classList.add('hq-gone');
  hide('.host-head');
  hide('.status');
  hide('.spacer');
  const rolesBox = make('div', 'hq-roles');
  rolesBox.hidden = true;
  const lobbyNote = make('p', 'note hq-lobby-note');
  panel.map.append(old('[data-k="glow"]'), panel.mission);
  cards.people.append(old('[data-k="asklist"]'), lobbyNote, rolesBox, old('[data-k="cap"]'), old('[data-k="duplist"]'), old('[data-k="names"]'));
  cards.mission.append(old('[data-k="missionPhoto"]'));
  // チャット：流れと送る欄は「話」、制約と場所の名前はデッキの札
  cards.chat.append(old('[data-k="chatFeed"]'));
  const chatCard = make('section', 'hq-card');
  chatCard.append(old('[data-k="chatSet"]'));

  // デッキ：時間・鬼と逃走者・鬼のマイク・固定の札／そろい具合／夜とやり直し／記録
  const durations = old<HTMLDetailsElement>('details.durations');
  const ratio = old<HTMLDetailsElement>('details.ratio');
  durations.open = true;
  ratio.open = true;
  const timeInputs = [...durations.querySelectorAll('input')] as HTMLInputElement[];
  const timeForm = durations.querySelector('form') as HTMLFormElement;
  const ratioInputs = [...ratio.querySelectorAll('input')] as HTMLInputElement[];
  const ratioForm = ratio.querySelector('form') as HTMLFormElement;
  const picker = durationPicker();
  // 既存フォームの検証と送信を通し、HQでは現在値を1か所だけ表示する。
  const setValue = (input: HTMLInputElement, form: HTMLFormElement, value: number) => {
    if (input.disabled || input.value === String(value)) return;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  };
  const timeCard = make('section', 'hq-card', '<h2>時間<span data-hq="total"></span></h2>');
  const timeButtons = PHASES.map((p, i) => {
    const label = p.id === 'game' ? 'ゲーム時間' : p.label;
    const button = make('button', 'hq-value');
    button.type = 'button';
    button.addEventListener('click', () => picker.open(button, label, Number(timeInputs[i].value), 1,
      (value) => setValue(timeInputs[i], timeForm, value)));
    const row = make('div', 'hq-picker-row');
    const name = make('span', '');
    name.textContent = label;
    row.append(name, button);
    timeCard.append(row);
    return { button, label };
  });
  const ratioCard = make('section', 'hq-card', '<h2>鬼と逃走者</h2>');
  const ratioSelects = ratioInputs.map((input) => {
    const label = input.dataset.r === 'oni' ? '鬼の割合' : '逃走者の割合';
    const select = hqSelect(label, numberOptions(Number(input.min), Number(input.max)), input.value);
    select.addEventListener('change', () => setValue(input, ratioForm, Number(select.value)));
    ratioCard.append(pickerRow(label, select));
    return select;
  });
  ratioCard.append(old('[data-k="ratioPreview"]'));
  const micCard = make('section', 'hq-card');
  micCard.append(old('.mic-mode:not(.wish-mode):not(.reveal-mode)'));
  hide('.wish-mode');
  hide('.reveal-mode');
  hide('[data-k="cast"]');
  hide('[data-k="shrink"]');
  const announceCard = make('section', 'hq-card');
  announceCard.append(old('.announce-set'));
  // HQでは択一の操作をネイティブのピッカーで選ぶ。既存のクリック処理と可否判定を共有する。
  const exclusive = (group: HTMLElement, attr: string, label: string, showLabel = false) => {
    const options = [...group.querySelectorAll<HTMLButtonElement>(`button[data-${attr}]`)];
    const select = hqSelect(label, options.map((b) => [b.getAttribute(`data-${attr}`)!, b.getAttribute('aria-label') || b.textContent!.trim()]), '');
    group.classList.add('hq-gone');
    group.after(showLabel ? pickerRow(label, select) : select);
    select.addEventListener('change', () => {
      options.find((b) => b.getAttribute(`data-${attr}`) === select.value)?.click();
    });
    return () => {
      const checked = options.find((b) => b.getAttribute('aria-pressed') === 'true');
      if (checked) {
        const value = checked.getAttribute(`data-${attr}`)!;
        if (select.value !== value) select.value = value;
      }
      select.disabled = options.every((b) => b.disabled);
      options.forEach((b, i) => { select.options[i].disabled = b.disabled; });
    };
  };
  const syncChoices = [
    exclusive(micCard.querySelector('.seg')!, 'mic', '鬼のマイクの聞き方'),
    exclusive(announceCard.querySelector('[aria-label="帯に出すもの"]')!, 'show', '帯に出すもの', true),
    exclusive(announceCard.querySelector('[aria-label="音を鳴らすスマホ"]')!, 'sound', '音を鳴らすスマホ', true),
    exclusive(chatCard.querySelector('[aria-label="仲間の回線で送れるもの"]')!, 'mode', '仲間の回線で送れるもの', true),
    exclusive(chatCard.querySelector('[aria-label="牢屋の人が送れるもの"]')!, 'jail', '牢屋の人が送れるもの'),
  ];
  const missionFree = cards.people.querySelector<HTMLElement>('[data-k="mission"]')!;
  const freeAll = missionFree.querySelector<HTMLButtonElement>('[data-mission="all"]')!;
  const freeSome = missionFree.querySelector<HTMLButtonElement>('[data-mission="n"]')!;
  const freeNumber = missionFree.querySelector<HTMLInputElement>('[data-k="missionN"]')!;
  for (const button of missionFree.querySelectorAll('[data-mission]')) button.classList.add('hq-gone');
  freeNumber.closest('label')!.classList.add('hq-gone');
  const freeCount = hqSelect('牢屋から出す人数', [['all', '全員']], 'all');
  const free = make('button', '');
  free.type = 'button';
  free.textContent = '牢屋から出す';
  free.addEventListener('click', () => {
    if (freeCount.value === 'all') freeAll.click();
    else {
      freeNumber.value = freeCount.value;
      freeSome.click();
    }
  });
  missionFree.firstElementChild!.after(pickerRow('出す人数', freeCount), free);
  const sec = (ms: number) => `${ms / 1000}秒`;
  const fixed = make('section', 'hq-card hq-fixed',
    '<h2>固定の札<span>いまはコードの中の数字</span></h2><ul>'
    + [
      ['長押しと音', `${sec(HOLD_MIN_MS)}の長押し。鬼が1人に決まれば選ばない`],
      ['牢屋と解放', `タッチで1人出す。出て${sec(RESCUE_IMMUNE_MS)}は捕まらない`],
      ['走ると光る', `走ると名前と場所が全員に光る。止まって${sec(RUN_STOP_MS)}で消える`],
      ['仲間の地図', `同じ役の仲間だけ見える。${sec(MATES_SEND_EVERY_MS)}ごと`],
      ['遊ぶ範囲の外', `外へ${AREA_OUT_MARGIN_M}m出て${sec(AREA_OUT_CONFIRM_MS)}で「戻れ」`],
      ['終わり方', '全員が牢屋なら鬼の勝ち。時間切れで1人でも外なら逃走者の勝ち'],
    ].map(([t, x]) => `<li><b>${t}</b><span>${x}</span></li>`).join('') + '</ul>');
  const ready = make('section', 'hq-card', '<h2>そろい具合</h2>');
  ready.append(old('.stats'));
  const night = make('section', 'hq-card', '<h2>夜とやり直し</h2>');
  const buttons = old('.buttons');
  night.append(old('[data-k="old"]'), buttons);
  const rec = make('section', 'hq-card', '<h2>記録</h2>');
  const csv = old<HTMLButtonElement>('[data-op="csv"]');
  rec.append(csv, old('[data-k="foot"]'));
  const group = (label: string, ...cards: HTMLElement[]) => {
    const details = make('details', 'hq-settings-group');
    const summary = make('summary', '');
    summary.textContent = label;
    const content = make('div', 'hq-settings-content');
    content.append(...cards);
    details.append(summary, content);
    return details;
  };
  panel.deck.append(
    group('時間とチームの割合', timeCard, ratioCard),
    group('マイク・チャット・通知', micCard, chatCard, announceCard),
    fixed, durations, ratio,
  );
  durations.classList.add('hq-gone');
  ratio.classList.add('hq-gone');

  // 前の画面にあとから足された部品（ここがまだ知らないもの）は、迷子にしないでデッキの下へ集める
  const area = old('[data-k="area"]');
  panel.deck.append(area);
  const reject = old('[data-k="reject"]');
  // スマホの許可がまだの人：参加者の詳細に置く（迷子の箱には入れない）
  const permBox = old('[data-k="perm"]');
  const strays = [...el.children].filter((c) => c !== reject && c !== permBox && !c.classList.contains('hq-gone')) as HTMLElement[];
  if (strays.length) {
    panel.deck.append(group('そのほか', ...strays));
  }
  cards.people.append(ready, permBox);
  cards.mission.append(night, rec);
  const shell = make('div', 'hq-shell');
  const menu = make('nav', 'hq-sidebar');
  menu.setAttribute('aria-label', '管理画面');
  const dashboard = make('button', '', 'ダッシュボード');
  const rules = make('button', '', 'ルール設定');
  dashboard.type = rules.type = 'button';
  menu.append(dashboard, rules);
  const content = make('div', 'hq-workspace');
  const title = make('h2', 'hq-page-title', 'ダッシュボード');
  const live = make('div', 'hq-live');
  panel.map.querySelector('[data-k="glowBoard"]')!.append(counts);
  const timeline = make('section', 'hq-timeline');
  timeline.setAttribute('aria-label', 'タイムラインと進行操作');
  timeline.append(now, rail, dock);
  live.append(grid, strip, timeline);
  const locked = make('p', 'hq-rules-locked', '試合終了後に次のゲームのルールを編集できます。');
  locked.hidden = true;
  content.append(title, live, reject, locked, body);
  shell.append(menu, content);
  el.append(head, shell, picker.el, dialogs.people, dialogs.chat);
  // 夜の予定：スマホはデッキのいちばん上、幅の広い画面は全幅の帯（3列の上）
  const nightPal = createNightPalette((plan) => actions.command('night-plan', { night: plan }), {
    apply: (preset, durations) => actions.command('preset-apply', { preset, ...(durations ? { durations } : {}) }),
    durations: (durations) => actions.command('durations', { durations }),
  }, picker.open, false);
  cards.mission.insertBefore(nightPal.el, night);
  if (termEl) el.append(termEl);

  // ---------- 押したとき ----------
  let tab: 'map' | 'deck' = 'map';
  const showTab = (t: 'map' | 'deck') => {
    tab = t;
    el.dataset.tab = t;
    const settings = t === 'deck';
    title.textContent = settings ? 'ルール設定' : 'ダッシュボード';
    dashboard.toggleAttribute('aria-current', !settings);
    rules.toggleAttribute('aria-current', settings);
    live.hidden = settings;
    locked.hidden = !(settings && panel.deck.inert);
    body.hidden = !settings;
  };
  dashboard.addEventListener('click', () => {
    showTab('map');
    content.scrollIntoView({ block: 'nearest' });
  });
  rules.addEventListener('click', () => {
    showTab('deck');
  });
  showTab('map');
  const showDetails = (t: string) => {
    if (t === 'people' || t === 'chat') {
      if (!dialogs[t].open) dialogs[t].showModal();
    } else if (t === 'mission') {
      cards.mission.open = true;
      cards.mission.scrollIntoView({ block: 'nearest' });
    } else if (t === 'map') panel.map.scrollIntoView({ block: 'nearest' });
  };
  strip.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.rid) {
      const ok = b.dataset.ok === '1';
      if (ok && b.dataset.here === '1' && !confirm(`${b.dataset.name} はいまも別のスマホでつながっている。それでもつなぐか？`)) return;
      actions.command('link', { rid: b.dataset.rid, ok });
    } else if (b.dataset.chat) {
      // 本部あての1通：「返事」はあて先をその人にして「話」へ、「見た」は済みにする
      const id = Number(b.dataset.chat);
      if (b.dataset.ok === '1') {
        showDetails('chat');
        inner.chat?.replyTo(id);
      } else {
        inner.chat?.dismiss(id);
      }
    } else if (b.dataset.go) {
      showDetails(b.dataset.go);
    }
  });

  // ---------- 描く（毎コマ呼ばれるので、変わったときだけ触る） ----------
  const memo = new Map<string, string>();
  const once = (key: string, value: string, apply: () => void) => {
    if (memo.get(key) === value) return;
    memo.set(key, value);
    apply();
  };
  const hq = (k: string) => el.querySelector(`[data-hq="${k}"]`) as HTMLElement;
  const text = (k: string, value: string) => once(`t:${k}`, value, () => (hq(k).textContent = value));
  const opBtn = (op: string) => (op === 'csv' ? csv : (el.querySelector(`[data-op="${op}"]`) as HTMLButtonElement));
  const homeOrder = [...buttons.querySelectorAll('button')] as HTMLButtonElement[];
  for (const [op, short] of Object.entries(SHORT)) opBtn(op).dataset.short = short;

  return {
    el,
    update(input: HostInput) {
      inner.update(input);
      const { game, host, serverNow } = input;
      if (!game || !host) return;
      const presets = host.presets ?? [];
      nightPal.update(host.nightPlan, game.durations, game.stage, presets);
      const timer = game.timer;
      const done = game.stage === 'timer' && timer !== null && isDone(timer, serverNow);
      const running = game.stage === 'timer' && timer?.status === 'running' && !done;
      const paused = game.stage === 'timer' && timer?.status === 'paused' && !done;
      panel.deck.inert = game.stage === 'timer' && !done;
      locked.hidden = !(tab === 'deck' && panel.deck.inert);
      const pos = game.stage === 'timer' && timer ? positionAt(timer, serverNow) : null;
      const phase = pos && pos.kind === 'phase' ? pos : null;
      const kind = game.stage === 'timer' ? (done ? 'done' : 'timer') : game.stage;
      once('kind', `${kind}:${paused ? 'p' : ''}`, () => {
        el.dataset.stage = kind;
        el.toggleAttribute('data-paused', paused);
      });

      // 上の行と段階の帯
      text('round', game.stage === 'lobby' ? '' : `ラウンド ${Math.max(game.round, 1)}`);
      once('conn', `${host.connected}/${host.total}/${input.online}`, () => {
        const c = hq('conn');
        c.textContent = input.online ? `つながり ${host.connected}/${host.total}` : '切断中';
        c.classList.toggle('is-bad', !input.online || host.connected < host.total);
      });
      const cur = game.stage === 'lobby' ? -1 : game.stage === 'assigned' ? 0 : game.stage === 'result' || done ? 5 : game.stage === 'ended' ? 6 : phase ? phase.index + 1 : 0;
      const progress = phase ? 1 - phase.remainingMs / Math.max(1, game.durations[phase.index]) : 1;
      // 時間の段階の幅は、時間の長さの比そのまま（0:20 と 1:00 なら 1：3）。配役と結果は字の幅だけ
      // 幅が字より狭い段階は、字を左にそろえて、続くときは上の段と下の段に互い違いに置く（重ねない）
      // 字の形が読み終わる前に測ると幅が小さく出るので、読み終わったら測り直す
    const railKey = `${game.durations.join(',')}|${rail.clientWidth}|${document.fonts?.status ?? ''}`;
      once('railShape', railKey, () => {
        const total = game.durations.reduce((a, b) => a + b, 0) || 1;
        const inner = Math.max(0, rail.clientWidth - steps[0].li.offsetWidth - steps[steps.length - 1].li.offsetWidth - 4 * (steps.length - 1));
        steps.forEach((s, i) => {
          if (i < 1 || i > PHASES.length) return;
          const d = game.durations[i - 1];
          s.lbl.textContent = formatClock(d);
          s.li.style.flexGrow = String(d);
          const narrow = (inner * d) / total < s.lbl.offsetWidth + 4;
          s.li.dataset.fit = narrow ? 'left' : 'in';
        });
        // 実際に置いた位置で確かめる：左の字とぶつかる字は上の段へ（上の段どうしもぶつかれば下へ戻す）
        let lowRight = steps[0].lbl.getBoundingClientRect().right;
        let upRight = -Infinity;
        steps.forEach((s, i) => {
          if (i < 1 || i > PHASES.length) return;
          const r = s.lbl.getBoundingClientRect();
          if (r.left >= lowRight + 8) {
            lowRight = r.right;
            return;
          }
          const upLeft = s.li.getBoundingClientRect().left;
          if (upLeft >= upRight + 8) {
            s.li.dataset.fit = 'up';
            upRight = upLeft + r.width;
          } else lowRight = r.right;
        });
        rail.toggleAttribute('data-two', steps.some((s) => s.li.dataset.fit === 'up'));
      });
      steps.forEach((s, i) => {
        const state = i === cur ? 'now' : i < cur ? 'done' : 'later';
        once(`rs:${i}`, state, () => {
          s.li.dataset.state = state;
          s.li.toggleAttribute('aria-current', state === 'now');
        });
        const w = state === 'now' ? Math.round(progress * 100) : state === 'done' ? 100 : 0;
        once(`rw:${i}`, String(w), () => (s.fill.style.width = `${w}%`));
      });

      // いま
      const st = hostStatus(game, serverNow);
      const cap = host.capture;
      const jailed = cap ? cap.runners.filter((r) => r.caught).length : 0;
      once('freeCount', String(jailed), () => {
        const value = freeCount.value;
        freeCount.replaceChildren(new Option('全員', 'all'));
        for (const [key, label] of numberOptions(1, jailed, '人')) freeCount.add(new Option(label, key));
        freeCount.value = value !== 'all' && freeCount.querySelector(`option[value="${value}"]`) ? value : 'all';
      });
      free.disabled = freeCount.disabled = freeAll.disabled;
      missionFree.hidden = freeAll.disabled;
      const label =
        game.stage === 'lobby' ? '待合室'
        : game.stage === 'assigned' ? '配役済み'
        : phase ? `${phase.index === 2 ? '残り時間' : PHASES[phase.index].label}${paused ? '（一時停止中）' : ''}`
        : game.stage === 'ended' ? '夜は終わった。全員の画面に出ている'
        : `結果発表（${game.resultAuto === false ? '主催者が決めた' : 'アプリが決めた'}）`;
      text('label', label);
      const big = game.stage === 'lobby' || game.stage === 'assigned' ? '' : st.big;
      text('big', big);
      const next =
        game.stage === 'lobby' ? (host.registry !== undefined ? `名簿 ${host.registry}人` : '')
        : game.stage === 'assigned' ? `役の受け取り ${host.received}/${host.assigned}`
        : game.stage === 'result' || done || game.stage === 'ended' ? st.next
        : game.allCaughtAt != null ? '全員が牢屋に入った' : '';
      text('next', next);
      const assignedCapture = game.stage === 'lobby' ? null : cap;
      const liveCounts = [host.total, assignedCapture?.oni.length ?? 0, (assignedCapture?.runners.length ?? 0) - (assignedCapture ? jailed : 0), assignedCapture ? jailed : 0, host.perms ? `${host.perms.ok}/${host.perms.total}` : '—', host.reclaims?.length ?? 0];
      liveCounts.forEach((n, i) => once(`count:${i}`, String(n), () => {
        countValues[i].textContent = String(n);
      }));
      once('roster', JSON.stringify(host.roster ?? []), () => {
        const permissions = { geo: '位置', motion: '動き', mic: 'マイク' };
        roster.innerHTML = host.roster?.length
          ? '<table><thead><tr><th>名前</th><th>役・状態</th><th>スマホの許可</th><th>接続</th></tr></thead><tbody>'
            + host.roster.map((p) => {
                const role = p.caught ? '捕まった人' : p.role === 'oni' ? '鬼' : p.role === 'runner' ? '逃走者' : '未配役';
                const permission = p.need === null ? '未確認' : p.need.length ? `未許可：${p.need.map((item) => permissions[item]).join('・')}` : '許可済み';
                return `<tr><th scope="row">${esc(p.name)} <small>#${p.num}</small></th><td>${role}</td><td>${permission}</td><td>${p.connected ? '接続中' : '未接続'}</td></tr>`;
              }).join('') + '</tbody></table>'
          : '<p>エントリーした参加者はまだいません。</p>';
      });
      const showCounts = !!cap && (game.stage === 'timer' || game.stage === 'result');
      const lit = new Set((input.glow?.runs ?? []).filter((r) => serverNow - r.at <= RUN_STALE_MS).map((r) => r.num));
      const pipKey = showCounts && cap!.runners.length <= 60 ? cap!.runners.map((r) => (r.caught ? 'j' : lit.has(r.num) ? 'g' : 'f')).sort().join('') : '';
      once('pips', pipKey, () => {
        const p = hq('pips');
        p.hidden = !pipKey;
        p.setAttribute('aria-label', pipKey ? `逃走者 ${pipKey.length}人のうち 牢屋に${jailed}人` : '');
        p.innerHTML = [...pipKey].sort((a, b) => 'gfj'.indexOf(a) - 'gfj'.indexOf(b)).map((c) => `<i data-s="${c}"></i>`).join('');
      });

      // 要対応：戻りたい人 → 見ていない写真 → 範囲の外 → 同じ名前 → 前の夜のまま
      const items: string[] = [];
      for (const a of host.reclaims ?? []) {
        const d = `data-rid="${esc(a.rid)}" data-name="${esc(a.name)}" data-here="${a.here ? 1 : 0}"`;
        items.push(`<span>「${esc(a.name)}」に戻りたい人</span><button type="button" class="hq-wait" ${d} data-ok="1">つなぐ</button><button type="button" ${d} data-ok="0">断る</button>`);
      }
      const asks = inner.chat?.pending() ?? [];
      for (const m of asks) {
        items.push(`<span>本部あて：${esc(m.from?.name ?? '')}「${esc(chatText(m)[0])}」</span><button type="button" class="hq-wait" data-chat="${m.id}" data-ok="1">返事</button><button type="button" data-chat="${m.id}" data-ok="0">見た</button>`);
      }
      const pending = (host.photos ?? []).filter((p) => p.status === 'pending');
      if (pending.length) items.push(`<span>写真が届いた：${esc(pending.map((p) => p.name).join('・'))}</span><button type="button" class="hq-wait" data-go="mission">見て決める</button>`);
      const areaPts = zoneAt(game.area, game.shrink, game.timer, serverNow);
      const onMap = (input.mates?.people ?? []).filter((m) => serverNow - m.at <= MATES_STALE_MS);
      const outside = areaPts && glowPhase(game, serverNow) === 'live' ? onMap.filter((m) => isFarOutside(areaPts, m)) : [];
      if (outside.length) items.push(`<span>範囲の外：${esc(outside.map((m) => m.name).join('・'))}</span><button type="button" data-go="map">地図</button>`);
      const badNames = (host.names ?? []).filter((n) => n.hit);
      if (badNames.length) items.push(`<span>気になる名前：${esc(badNames.map((n) => n.name).join('・'))}</span><button type="button" data-go="people">人</button>`);
      if (host.dupNames.length) items.push(`<span>同じ名前：${esc(host.dupNames.map((d) => d.name).join('・'))}</span><button type="button" data-go="people">人</button>`);
      if (!old('[data-k="old"]').hidden) items.push('<span>前の夜のまま。集める前に新しい夜を始める</span><button type="button" data-go="mission">運営</button>');
      once('strip', items.length ? `${items.length}|${items[0]}` : '', () => {
        strip.hidden = items.length === 0;
        strip.innerHTML = items.length ? `<b class="hq-badge u" aria-label="要対応 ${items.length}件">${items.length}</b>${items[0]}` : '';
      });
      const mapped = new Set(onMap.map((m) => m.num)).size;
      const activeMap = glowPhase(game, serverNow) === 'live';
      text('peopleSummary', `接続 ${host.connected}/${host.total}人${activeMap ? ` ・位置取得 ${mapped}/${host.assigned}人` : ''}${outside.length ? ` ・範囲外 ${outside.length}人` : ''}`);
      const chat = input.chat?.msgs.at(-1);
      text('chatSummary', `${asks.length ? `未対応 ${asks.length}件 · ` : ''}${chat ? `${chat.from?.name ?? '本部'}：${chatText(chat)[0]}` : 'メッセージなし'}`);
      text('missionSummary', `${old('[data-k="missionNow"]').textContent ?? ''}${pending.length ? ` ・確認待ち ${pending.length}件` : ''}`);

      // 配役済み：役ごとの名前（捕獲と牢屋の一覧は、試合が始まってから出る）
      const showRoles = game.stage === 'assigned' && !!cap;
      once('roles', showRoles ? JSON.stringify([cap!.oni.map((o) => o.name), cap!.runners.map((r) => r.name)]) : '', () => {
        rolesBox.hidden = !showRoles;
        rolesBox.innerHTML = showRoles
          ? `<h2>${ONI}鬼 <b class="u">${cap!.oni.length}</b></h2><div>${cap!.oni.map((o) => `<span data-r="oni">${esc(o.name)}</span>`).join('')}</div>`
            + `<h2>${RUN}逃走者 <b class="u">${cap!.runners.length}</b></h2><div>${cap!.runners.map((r) => `<span>${esc(r.name)}</span>`).join('')}</div>`
          : '';
      });
      once('lobbyNote', game.stage === 'lobby' ? String(host.total) : '', () => {
        lobbyNote.hidden = game.stage !== 'lobby';
        lobbyNote.textContent = `いま ${host.total}人が入っている。名前は配役のあとに並ぶ。`;
      });

      // デッキの現在値と操作可否は既存フォームに合わせる。
      const total = game.durations.reduce((a, b) => a + b, 0);
      text('total', `1ラウンド ${formatClock(total)}`);
      timeInputs.forEach((inp, i) => {
        once(`tv:${i}`, `${inp.value}|${inp.disabled}`, () => {
          const { button, label } = timeButtons[i];
          button.textContent = formatClock(Number(inp.value) * 1000);
          button.setAttribute('aria-label', `${label} ${button.textContent} を選ぶ`);
          button.disabled = inp.disabled;
        });
      });
      ratioInputs.forEach((inp, i) => {
        const select = ratioSelects[i];
        if (select.value !== inp.value) select.value = inp.value;
        select.disabled = inp.disabled;
      });
      syncChoices.forEach((sync) => sync());

      // 押すもの：その段階で要るものだけを下へ。ほかは「夜とやり直し」に置いたまま
      const want: DockItem[] =
        game.stage === 'lobby' ? [['assign', 'wait']]
        : game.stage === 'assigned' ? [['assign', 'norm'], ['start', 'wait']]
        : running ? [['pause', 'norm'], ['skip', 'norm']]
        : paused ? [['reset', 'hold'], ['resume', 'wait']]
        : game.stage === 'ended' ? [['clear', 'hold'], ['csv', 'wait']]
        : [['end', 'hold'], ['assign', 'wait']];
      const skipTo = phase ? (phase.index + 1 < PHASES.length ? formatClock(game.durations[phase.index + 1]) : '結果') : '';
      once('skip', skipTo, () => (opBtn('skip').dataset.short = skipTo ? `次へ → ${skipTo}` : '次へ'));
      once('dock', JSON.stringify(want), () => {
        buttons.append(...homeOrder);
        rec.prepend(csv);
        rec.prepend(rec.querySelector('h2')!);
        for (const b of [...homeOrder, csv]) b.classList.remove('hq-wait', 'hq-hold');
        dock.replaceChildren(
          ...want.map(([op, weight]) => {
            const b = opBtn(op);
            b.classList.toggle('hq-wait', weight === 'wait');
            b.classList.toggle('hq-hold', weight === 'hold');
            return b;
          }),
        );
      });

    },
  };
}
