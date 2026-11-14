import './hq.css';
import { AREA_OUT_CONFIRM_MS, AREA_OUT_MARGIN_M, isFarOutside } from '../../shared/area';
import { HOLD_MIN_MS, MATES_SEND_EVERY_MS, MATES_STALE_MS, PHASES, RESCUE_IMMUNE_MS, RUN_STALE_MS, RUN_STOP_MS } from '../../shared/rules';
import { formatClock, isDone, positionAt } from '../../shared/schedule';
import { glowPhase, hostStatus } from '../../shared/viewmodel';
import type { Sensors } from '../sense';
import { createHost, type HostActions, type HostInput, type HostScreen } from './host';

/**
 * 本部（新しい主催者画面）。キャンバス「Urafess 本部（管理者画面）」の並びを、いまの主催者画面の上にかぶせる。
 *
 * しくみは前の主催者画面（createHost）をそのまま使う：中の部品（地図・捕獲と牢屋・ミッション・時間や割合の欄・ボタン）を
 * 4つの場所（地図・人・ミッション・デッキ）へ並べ替え、その上に「段階の帯・いま・要対応・押すもの・タブ」を足しているだけ。
 * だから、押したときに起きることは前の画面と同じ。前の画面は消していない（入口で切りかえる）。
 *
 * 決まり：
 * - 月白の板（塗り）は「返事を待っている」ものだけ。下の並び（押すもの）に出るのは、その段階で要るものだけ
 * - 要対応は、どの場所にいても、いちばん上の1件が選択肢つきで出る
 * - スマホは1つの場所だけ、幅の広い画面は3列に全部を並べる
 */

type Tab = 'map' | 'people' | 'mission' | 'deck';
const TABS: [Tab, string][] = [['map', '地図'], ['people', '人'], ['mission', 'ミッション'], ['deck', 'デッキ']];

/** 下の並びに出すボタンと重さ（wait＝月白の板、hold＝取り返しがつかない操作） */
type DockItem = [op: string, weight: 'wait' | 'norm' | 'hold'];
/** 下の並びでは短い名前で出す（押したときの確かめの文は前のまま） */
const SHORT: Record<string, string> = { reset: '配役に戻す', end: '夜を終える', clear: '新しい夜', csv: '記録を保存' };
/** 時間の ＋／− の刻み（秒）。段階ごと */
const TIME_STEP = [5, 10, 60, 30];

const ONI = '<svg class="hq-m" viewBox="-14 -14 28 28" aria-hidden="true"><path d="M-5.5,-4 L-7.5,-12 L-1.5,-6 Z M5.5,-4 L7.5,-12 L1.5,-6 Z" fill="var(--shu)"/><circle r="6.5" fill="var(--shu)"/></svg>';
const RUN = '<svg class="hq-m" viewBox="-14 -14 28 28" aria-hidden="true"><circle r="6.5" fill="var(--tsuki)"/></svg>';
const JAIL = '<svg class="hq-m" viewBox="-14 -14 28 28" aria-hidden="true"><circle r="5.5" fill="none" stroke="var(--muted)" stroke-width="2"/></svg>';

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function createHQ(actions: HostActions, sensors?: Sensors, onLeave?: () => void): HostScreen {
  const inner = createHost(actions, sensors);
  // 前の画面の根っこをそのまま使う（中の部品は、この根っこの下にある限り前のしくみのまま動く）
  const el = inner.el;
  el.classList.add('hq');
  const old = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;

  // ---------- 足すもの ----------
  const head = make('header', 'hq-head',
    '<h1>本部<span class="u">HQ</span></h1><div class="hq-head-r"><span data-hq="round"></span><span class="hq-conn" data-hq="conn"></span></div>');
  const rail = make('ol', 'hq-rail');
  rail.setAttribute('aria-label', '段階');
  const steps = ['配役', ...PHASES.map(() => ''), '結果'].map((t) => {
    const li = make('li', '', `<span class="lbl">${t}</span><span class="bar"><i></i></span>`);
    rail.append(li);
    return { li, lbl: li.querySelector('.lbl') as HTMLElement, fill: li.querySelector('i') as HTMLElement };
  });
  const now = make('section', 'hq-now',
    '<div class="hq-now-l"><span class="hq-label" data-hq="label"></span><span class="hq-big" data-hq="big"></span><span class="hq-next" data-hq="next"></span></div>'
    + '<ul class="hq-counts" data-hq="counts"></ul><div class="hq-pips" data-hq="pips" role="img"></div>');
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
  const tabs = make('nav', 'hq-tabs');
  tabs.setAttribute('aria-label', '本部の場所');
  const tabBtn = {} as Record<Tab, HTMLButtonElement>;
  for (const [key, label] of TABS) {
    const b = make('button', '', `<span>${label}</span><i hidden></i>`);
    b.type = 'button';
    b.dataset.tab = key;
    tabBtn[key] = b;
    tabs.append(b);
  }

  // ---------- 前の部品を4つの場所へ ----------
  const hide = (sel: string) => old(sel)?.classList.add('hq-gone');
  hide('.host-head');
  hide('.status');
  hide('.spacer');
  const rolesBox = make('div', 'hq-roles');
  rolesBox.hidden = true;
  const lobbyNote = make('p', 'note hq-lobby-note');
  panel.map.append(old('[data-k="glow"]'), old('[data-k="area"]'));
  panel.people.append(old('[data-k="asklist"]'), lobbyNote, rolesBox, old('[data-k="cap"]'), old('[data-k="duplist"]'));
  panel.mission.append(old('[data-k="missionPhoto"]'));

  // デッキ：時間（＋−）・鬼と逃走者（＋−）・鬼のマイク・固定の札／そろい具合／夜とやり直し／記録
  const durations = old<HTMLDetailsElement>('details.durations');
  const ratio = old<HTMLDetailsElement>('details.ratio');
  durations.open = true;
  ratio.open = true;
  const timeInputs = [...durations.querySelectorAll('input')] as HTMLInputElement[];
  const timeForm = durations.querySelector('form') as HTMLFormElement;
  const ratioInputs = [...ratio.querySelectorAll('input')] as HTMLInputElement[];
  const ratioForm = ratio.querySelector('form') as HTMLFormElement;
  const stepRow = (label: string, key: string) =>
    `<div class="hq-step" data-step="${key}"><span>${label}</span><button type="button" data-d="-1" aria-label="${label}を減らす">−</button>`
    + `<output class="u"></output><button type="button" data-d="1" aria-label="${label}を増やす">＋</button></div>`;
  const timeCard = make('section', 'hq-card',
    `<h2>時間<span data-hq="total"></span></h2>${PHASES.map((p, i) => stepRow(p.id === 'game' ? 'ゲーム' : p.label, `t${i}`)).join('')}`);
  const ratioCard = make('section', 'hq-card', `<h2>鬼と逃走者</h2>${stepRow('鬼', 'r-oni')}${stepRow('逃走者', 'r-runner')}`);
  ratioCard.append(old('[data-k="ratioPreview"]'));
  const micCard = make('section', 'hq-card');
  micCard.append(old('.mic-mode'));
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
  const leave = make('button', 'ghost hq-leave');
  leave.type = 'button';
  leave.textContent = '前の主催者画面に戻る';
  leave.hidden = !onLeave;
  leave.addEventListener('click', () => onLeave?.());
  rec.append(csv, old('[data-k="foot"]'), leave);
  panel.deck.append(timeCard, ratioCard, micCard, fixed, ready, night, rec, durations, ratio);
  durations.classList.add('hq-gone');
  ratio.classList.add('hq-gone');

  el.append(head, rail, now, strip, old('[data-k="reject"]'), body, dock, tabs);

  // ---------- 押したとき ----------
  /** ＋−：欄の値を変えて、前の画面の「変える」をそのまま押す（確かめ・送り方は前のしくみ） */
  const bump = (input: HTMLInputElement, form: HTMLFormElement, by: number, min: number, max: number) => {
    if (input.disabled) return;
    const v = Math.min(max, Math.max(min, Math.round(Number(input.value) || 0) + by));
    if (String(v) === input.value) return;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  };
  panel.deck.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-d]') as HTMLButtonElement | null;
    const row = b?.closest('[data-step]') as HTMLElement | null;
    if (!b || !row) return;
    const key = row.dataset.step!;
    const d = Number(b.dataset.d);
    if (key.startsWith('t')) {
      const i = Number(key.slice(1));
      bump(timeInputs[i], timeForm, d * TIME_STEP[i], TIME_STEP[i], 3600);
    } else {
      const input = ratioInputs.find((x) => x.dataset.r === key.slice(2));
      if (input) bump(input, ratioForm, d, Number(input.min) || 1, Number(input.max) || 99);
    }
  });
  let tab: Tab = 'deck';
  let tabPicked = false;
  const showTab = (t: Tab) => {
    tab = t;
    el.dataset.tab = t;
    for (const [key] of TABS) tabBtn[key].toggleAttribute('aria-current', key === t);
  };
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.tab) return;
    tabPicked = true;
    showTab(b.dataset.tab as Tab);
    body.scrollTop = 0;
  });
  strip.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.rid) {
      const ok = b.dataset.ok === '1';
      if (ok && b.dataset.here === '1' && !confirm(`${b.dataset.name} はいまも別のスマホでつながっている。それでもつなぐか？`)) return;
      actions.command('link', { rid: b.dataset.rid, ok });
    } else if (b.dataset.go) {
      tabPicked = true;
      showTab(b.dataset.go as Tab);
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
  let lastKind = '';

  return {
    el,
    update(input: HostInput) {
      inner.update(input);
      const { game, host, serverNow } = input;
      if (!game || !host) return;
      const timer = game.timer;
      const done = game.stage === 'timer' && timer !== null && isDone(timer, serverNow);
      const running = game.stage === 'timer' && timer?.status === 'running' && !done;
      const paused = game.stage === 'timer' && timer?.status === 'paused' && !done;
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
      steps.forEach((s, i) => {
        if (i >= 1 && i <= PHASES.length) once(`rl:${i}`, String(game.durations[i - 1]), () => (s.lbl.textContent = formatClock(game.durations[i - 1])));
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
      const label =
        game.stage === 'lobby' ? '待合室'
        : game.stage === 'assigned' ? '配役済み'
        : phase ? `${phase.index === 2 ? '残り時間' : PHASES[phase.index].label}${paused ? '（一時停止中）' : ''}`
        : game.stage === 'ended' ? '夜は終わった。全員の画面に出ている'
        : `結果発表（${game.resultAuto === false ? '主催者が決めた' : 'アプリが決めた'}）`;
      text('label', label);
      const big = game.stage === 'lobby' ? `${host.total}人` : game.stage === 'assigned' ? `鬼${game.counts.oni}・逃走者${game.counts.runner}` : st.big;
      once('big', big, () => {
        const b = hq('big');
        const plain = game.stage !== 'lobby' && game.stage !== 'assigned';
        if (plain) b.textContent = big;
        else if (game.stage === 'lobby') b.innerHTML = `<span class="u">${host.total}</span><small>人</small>`;
        else b.innerHTML = `${ONI}<span class="u">${game.counts.oni}</span>${RUN}<span class="u">${game.counts.runner}</span>`;
        b.setAttribute('aria-label', big);
        // 数字と英字だけなら URAJI、日本語が入るなら太いゴシック
        b.classList.toggle('u', plain && /^[0-9A-Z: ]+$/.test(big));
        b.classList.toggle('hq-big-mix', !plain);
        b.dataset.len = big.length > 9 ? 'long' : big.length > 5 ? 'mid' : 'short';
      });
      const next =
        game.stage === 'lobby' ? (host.registry !== undefined ? `名簿 ${host.registry}人` : '')
        : game.stage === 'assigned' ? `役の受け取り ${host.received}/${host.assigned}`
        : game.stage === 'result' || done || game.stage === 'ended' ? st.next
        : game.allCaughtAt != null ? '全員が牢屋に入った' : '';
      text('next', next);
      const showCounts = !!cap && (game.stage === 'timer' || game.stage === 'result');
      once('counts', showCounts ? `${cap!.oni.length}/${cap!.runners.length - jailed}/${jailed}` : '', () => {
        hq('counts').innerHTML = showCounts
          ? `<li>${ONI}<b class="u">${cap!.oni.length}</b>鬼</li><li>${RUN}<b class="u">${cap!.runners.length - jailed}</b>逃走中</li><li>${JAIL}<b class="u">${jailed}</b>牢屋</li>`
          : '';
      });
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
      const pending = (host.photos ?? []).filter((p) => p.status === 'pending');
      if (pending.length) items.push(`<span>写真が届いた：${esc(pending.map((p) => p.name).join('・'))}</span><button type="button" class="hq-wait" data-go="mission">見て決める</button>`);
      const areaPts = game.area?.pts ?? null;
      const onMap = (input.mates?.people ?? []).filter((m) => serverNow - m.at <= MATES_STALE_MS);
      const outside = areaPts && glowPhase(game, serverNow) === 'live' ? onMap.filter((m) => isFarOutside(areaPts, m)) : [];
      if (outside.length) items.push(`<span>範囲の外：${esc(outside.map((m) => m.name).join('・'))}</span><button type="button" data-go="map">地図</button>`);
      if (host.dupNames.length) items.push(`<span>同じ名前：${esc(host.dupNames.map((d) => d.name).join('・'))}</span><button type="button" data-go="people">人</button>`);
      if (!old('[data-k="old"]').hidden) items.push('<span>前の夜のまま。集める前に新しい夜を始める</span><button type="button" data-go="deck">デッキ</button>');
      once('strip', items.length ? `${items.length}|${items[0]}` : '', () => {
        strip.hidden = items.length === 0;
        strip.innerHTML = items.length ? `<b class="hq-badge u" aria-label="要対応 ${items.length}件">${items.length}</b>${items[0]}` : '';
      });
      const badge = (t: Tab, n: number) =>
        once(`b:${t}`, String(n), () => {
          const i = tabBtn[t].querySelector('i') as HTMLElement;
          i.hidden = n === 0;
          i.textContent = String(n);
        });
      badge('mission', pending.length);
      badge('people', (host.reclaims ?? []).length + host.dupNames.length);
      badge('map', outside.length);

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

      // デッキ：＋−の表示
      const total = game.durations.reduce((a, b) => a + b, 0);
      text('total', `1ラウンド ${formatClock(total)}`);
      timeInputs.forEach((inp, i) => {
        once(`tv:${i}`, `${inp.value}|${inp.disabled}`, () => {
          const row = timeCard.querySelector(`[data-step="t${i}"]`) as HTMLElement;
          (row.querySelector('output') as HTMLElement).textContent = formatClock(Math.round(Number(inp.value) || 0) * 1000);
          for (const b of row.querySelectorAll('button')) b.disabled = inp.disabled;
        });
      });
      ratioInputs.forEach((inp) => {
        once(`rv:${inp.dataset.r}`, `${inp.value}|${inp.disabled}`, () => {
          const row = ratioCard.querySelector(`[data-step="r-${inp.dataset.r}"]`) as HTMLElement;
          (row.querySelector('output') as HTMLElement).textContent = inp.value;
          for (const b of row.querySelectorAll('button')) b.disabled = inp.disabled;
        });
      });

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

      // 最初と、段階が大きく変わったときの場所（自分で選んだあとは、試合が始まるときだけ地図へ）
      if (kind !== lastKind) {
        const first = lastKind === '';
        lastKind = kind;
        if (first || !tabPicked || kind === 'timer') {
          showTab(kind === 'timer' ? 'map' : kind === 'assigned' ? 'people' : kind === 'lobby' || kind === 'ended' ? 'deck' : first ? 'people' : tab);
        }
      }
    },
  };
}
