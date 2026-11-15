import {
  defaultNightPlan,
  hhmm,
  kindInfo,
  newBlockId,
  NIGHT_KINDS,
  NIGHT_MAX_BLOCKS,
  NIGHT_MINS_MAX,
  NIGHT_MINS_MIN,
  NIGHT_TITLE_MAX,
  nightIssues,
  parseHhmm,
  blockSecs,
  clockText,
  defaultRound,
  ROUND_PART_MAX,
  ROUND_PART_MIN,
  ROUND_PARTS,
  ROUND_STEP,
  roundParts,
  sameAsDeck,
  placeNight,
  spanText,
  type NightKind,
  type NightPlan,
} from '../../shared/night';
import { PHASES } from '../../shared/rules';

/**
 * 夜の予定のパレット（本部）。試合の前から夜全体を組んで、不備をつぶすための場所。
 *
 * - 上：地図（横軸＝時計の時刻）。1段目＝ブロック（幅＝長さの比）、2段目＝プレ・本番の中身（配役・4段・結果発表、実際の比）。
 *   終わっていたい時刻は破線、いまの時刻は月白の線
 * - 不備：終わりが遅い・デッキの時間がブロックに収まらない など（朱）
 * - 下：時刻表（1行＝1ブロック）。行で ＋−、押すと見出し・種類・並び・消すを開く。
 *   プレ・本番は中身を1段ずつ ＋−（長さは中身の合計）。中身はデッキの時間へそのまま入れられる
 * - まとめて：同じ種類のブロック（本番が2つ など）を一度に ＋−。開始をずらすと全部がずれる
 * 色は道具なので無彩色。色が付くのは不備（朱）だけ
 */

export interface NightPalette {
  el: HTMLElement;
  update(plan: NightPlan | null | undefined, durations: number[], stage: string | undefined): void;
}

const SEND_AFTER_MS = 350;
/** 自分でいじってから、サーバーの予定で上書きしないでおく間 */
const HOLD_LOCAL_MS = 2000;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(text: string, act: string, extra: Record<string, string> = {}, label?: string): HTMLButtonElement {
  const b = mk('button', '', text);
  b.type = 'button';
  b.dataset.act = act;
  for (const [k, v] of Object.entries(extra)) b.dataset[k] = v;
  if (label) b.setAttribute('aria-label', label);
  return b;
}
const clone = (p: NightPlan): NightPlan => ({
  ...p,
  blocks: p.blocks.map((b) => ({ ...b, ...(b.round ? { round: { ...b.round, phases: [...b.round.phases] } } : {}) })),
});
const clampMins = (n: number) => Math.min(NIGHT_MINS_MAX, Math.max(NIGHT_MINS_MIN, n));
const clampPart = (n: number, min: number) => Math.min(ROUND_PART_MAX, Math.max(min, n));
const DAY = 24 * 60;

/** toDeck：プレ・本番の中身（デッキの4段、秒）をデッキの時間へ入れる */
export function createNightPalette(send: (plan: NightPlan) => void, toDeck: (phasesSec: number[]) => void): NightPalette {
  const el = mk('section', 'np');
  el.setAttribute('aria-label', '夜の予定');
  const head = mk('header', 'np-head');
  const h2 = mk('h2', '', '夜の予定');
  const sum = mk('span', 'np-sum');
  const toggle = btn('組む', 'toggle');
  toggle.classList.add('np-toggle');
  head.append(h2, sum, toggle);

  const chart = mk('div', 'np-chart');
  chart.setAttribute('role', 'img');
  const issues = mk('ul', 'np-issues');
  const body = mk('div', 'np-body');
  const times = mk('div', 'np-times');
  const table = mk('ol', 'np-table');
  const kinds = mk('div', 'np-kinds');
  const add = mk('div', 'np-add');
  const note = mk('p', 'np-note');
  body.append(times, table, kinds, add, note);
  el.append(head, chart, issues, body);

  let plan: NightPlan = defaultNightPlan();
  let saved = false;
  let durations: number[] = PHASES.map(() => 0);
  let selected: string | null = null;
  let localAt = 0;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let open: boolean | null = null;
  let stage: string | undefined;
  /** プレ・本番の長さを分に丸めて持っておく（サーバーの確かめのため。長さは中身の合計） */
  const syncMins = (p: NightPlan) => {
    for (const b of p.blocks) if (b.round) b.mins = Math.min(NIGHT_MINS_MAX, Math.max(NIGHT_MINS_MIN, Math.round(blockSecs(b) / 60)));
    return p;
  };

  const change = (next: NightPlan) => {
    plan = syncMins(next);
    saved = true;
    localAt = Date.now();
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      send(plan);
    }, SEND_AFTER_MS);
    render();
  };

  // ---------- 描く ----------
  const nowMinute = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  };

  const renderChart = () => {
    const { blocks, end } = placeNight(plan);
    const endBy = plan.endBy === null ? null : plan.endBy <= plan.start ? plan.endBy + DAY : plan.endBy;
    const from = plan.start;
    const to = Math.max(end, endBy ?? end, from + 30);
    const span = to - from;
    const x = (m: number) => `${(((m - from) / span) * 100).toFixed(3)}%`;
    const w = (m: number) => `${((m / span) * 100).toFixed(3)}%`;
    chart.replaceChildren();
    // 目盛り：10分ごとの線、30分ごとに時刻
    const ticks = mk('div', 'np-ticks');
    const first = Math.ceil(from / 10) * 10;
    for (let m = first; m <= to; m += 10) {
      const t = mk('i');
      t.style.left = x(m);
      const nearEnd = (m - from) / span < 0.08 || (to - m) / span < 0.12;
      if (m % 30 === 0) {
        t.dataset.major = '';
        if (!nearEnd) t.append(mk('span', 'np-tick-l', hhmm(m)));
      }
      ticks.append(t);
    }
    const lane = mk('div', 'np-lane');
    const inner = mk('div', 'np-lane np-inner');
    const bad = new Set(nightIssues(plan).map((i) => i.id));
    for (const b of blocks) {
      const box = mk('button', 'np-blk');
      box.type = 'button';
      box.dataset.act = 'pick';
      box.dataset.id = b.id;
      box.dataset.kind = b.kind;
      if (b.id === selected) box.setAttribute('aria-pressed', 'true');
      if (bad.has(b.id)) box.dataset.bad = '';
      box.style.left = x(b.from);
      box.style.width = w(b.to - b.from);
      box.setAttribute('aria-label', `${hhmm(b.from)}から${clockText(blockSecs(b))} ${b.title || kindInfo(b.kind).name}`);
      const lab = mk('span', 'np-blk-l', b.title || kindInfo(b.kind).name);
      box.append(lab);
      lane.append(box);
      if (b.round) {
        // 中身：配役・4段・結果発表を、ブロックの頭から実際の比で
        let t = b.from;
        roundParts(b.round).forEach((sec, i) => {
          if (!sec) return;
          const seg = mk('i', 'np-seg');
          seg.dataset.i = String(i);
          seg.style.left = x(t);
          seg.style.width = w(sec / 60);
          inner.append(seg);
          t += sec / 60;
        });
      }
    }
    const marks = mk('div', 'np-marks');
    const endMark = mk('i', 'np-end');
    endMark.style.left = x(end);
    marks.append(endMark);
    if (endBy !== null) {
      const lim = mk('i', 'np-limit');
      lim.style.left = x(endBy);
      if (end > endBy) lim.dataset.bad = '';
      marks.append(lim);
    }
    // いまの時刻（予定の中にいるときだけ）
    let now = nowMinute();
    if (now < from - 12 * 60) now += DAY;
    if (now >= from && now <= to) {
      const n = mk('i', 'np-now');
      n.style.left = x(now);
      marks.append(n);
    }
    const ends = mk('div', 'np-ends');
    ends.append(mk('span', 'u', hhmm(plan.start)), mk('span', 'u np-ends-r', hhmm(end)));
    chart.append(ends, ticks, lane, inner, marks);
    chart.setAttribute('aria-label', `夜の予定 ${hhmm(plan.start)}から${hhmm(end)}まで`);
    // 字が入りきらないブロックは字を隠す（字は16pxより小さくしない）
    requestAnimationFrame(() => {
      for (const box of lane.querySelectorAll<HTMLElement>('.np-blk')) {
        const lab = box.firstElementChild as HTMLElement;
        lab.hidden = false;
        if (lab.scrollWidth > box.clientWidth - 8) lab.hidden = true;
      }
    });
  };

  /** プレ・本番の中身：1段ずつ ＋−。デッキとのやりとり、同じ種類へまとめて */
  const roundEditor = (id: string, r: NonNullable<NightPlan['blocks'][number]['round']>, kind: NightKind) => {
    const box = mk('div', 'np-round');
    const parts = roundParts(r);
    let t = 0;
    parts.forEach((sec, i) => {
      const row = mk('div', 'np-part');
      row.dataset.i = String(i);
      const at = mk('span', 'np-part-at u', `+${clockText(t)}`);
      t += sec;
      const min = i >= 1 && i <= PHASES.length ? 1 : ROUND_PART_MIN;
      const dn = btn('−', 'part', { id, i: String(i), d: String(-ROUND_STEP[i]) }, `${ROUND_PARTS[i]}を${ROUND_STEP[i]}秒短く`);
      dn.disabled = sec <= min;
      const up = btn('＋', 'part', { id, i: String(i), d: String(ROUND_STEP[i]) }, `${ROUND_PARTS[i]}を${ROUND_STEP[i]}秒長く`);
      up.disabled = sec >= ROUND_PART_MAX;
      row.append(mk('span', 'np-part-l', ROUND_PARTS[i]), at, dn, mk('output', 'u', clockText(sec)), up);
      box.append(row);
    });
    const total = mk('div', 'np-part np-part-total');
    total.append(mk('span', 'np-part-l', '合計'), mk('output', 'u', clockText(t)));
    box.append(total);
    const deck = mk('div', 'np-ops');
    const same = sameAsDeck(r, durations);
    const put = btn(same ? 'デッキと同じ' : 'この4段をデッキへ入れる', 'to-deck', { id });
    const canDeck = stage === undefined || stage === 'lobby' || stage === 'assigned' || stage === 'result';
    put.disabled = same || !canDeck;
    deck.append(put, btn('デッキから取り込む', 'from-deck', { id }));
    const n = plan.blocks.filter((x) => x.kind === kind).length;
    if (n > 1) deck.append(btn(`同じ中身を${kindInfo(kind).name}すべてに`, 'round-all', { id }));
    box.append(deck);
    if (!canDeck && !same) box.append(mk('p', 'np-hint', 'デッキの時間は、待合室・配役のあと・結果発表の間だけ変えられる'));
    return box;
  };

  const renderTable = () => {
    const { blocks, end } = placeNight(plan);
    const issueIds = new Set(nightIssues(plan).map((i) => i.id));
    let now = nowMinute();
    if (now < plan.start - 12 * 60) now += DAY;
    table.replaceChildren();
    for (const [i, b] of blocks.entries()) {
      const li = mk('li', 'np-row');
      li.dataset.kind = b.kind;
      if (issueIds.has(b.id)) li.dataset.bad = '';
      if (now >= b.from && now < b.to) li.dataset.now = '';
      const pick = mk('button', 'np-pick');
      pick.type = 'button';
      pick.dataset.act = 'pick';
      pick.dataset.id = b.id;
      pick.setAttribute('aria-expanded', String(b.id === selected));
      pick.append(mk('span', 'u np-at', hhmm(b.from)), mk('span', 'np-title', b.title || kindInfo(b.kind).name), mk('span', 'np-kind', kindInfo(b.kind).name));
      const mins = mk('span', 'np-mins');
      if (b.round) {
        // プレ・本番：長さは中身の合計。行では長さだけ見せる（いじるのは中身）
        if (sameAsDeck(b.round, durations)) mins.append(mk('span', 'np-deck', 'デッキ'));
        mins.append(mk('output', 'u np-len', clockText(blockSecs(b))));
      } else {
        mins.append(btn('−', 'mins', { id: b.id, d: '-1' }, `${b.title}を1分短く`), mk('output', 'u', `${b.mins}分`), btn('＋', 'mins', { id: b.id, d: '1' }, `${b.title}を1分長く`));
      }
      li.append(pick, mins);
      if (b.id === selected) {
        const ed = mk('div', 'np-editor');
        const name = mk('input');
        name.type = 'text';
        name.maxLength = NIGHT_TITLE_MAX;
        name.value = b.title;
        name.placeholder = kindInfo(b.kind).name;
        name.dataset.id = b.id;
        name.className = 'np-name';
        name.setAttribute('aria-label', '見出し');
        const kindRow = mk('div', 'np-seg-btns');
        for (const k of NIGHT_KINDS) {
          const kb = btn(k.name, 'kind', { id: b.id, kind: k.kind });
          if (k.kind === b.kind) kb.setAttribute('aria-pressed', 'true');
          kindRow.append(kb);
        }
        const ops = mk('div', 'np-ops');
        const up = btn('前へ', 'move', { id: b.id, d: '-1' });
        up.disabled = i === 0;
        const down = btn('後ろへ', 'move', { id: b.id, d: '1' });
        down.disabled = i === blocks.length - 1;
        const del = btn('消す', 'del', { id: b.id });
        del.classList.add('np-del');
        if (b.round) ops.append(up, down, del);
        else ops.append(up, down, btn('−5分', 'mins', { id: b.id, d: '-5' }), btn('＋5分', 'mins', { id: b.id, d: '5' }), del);
        ed.append(name, kindRow);
        if (b.round) ed.append(roundEditor(b.id, b.round, b.kind));
        ed.append(ops);
        li.append(ed);
      }
      table.append(li);
    }
    const last = mk('li', 'np-row np-row-end');
    last.append(mk('span', 'u np-at', hhmm(end)), mk('span', 'np-title', 'おしまい'));
    table.append(last);
  };

  const renderKinds = () => {
    kinds.replaceChildren(mk('h3', '', 'まとめて'));
    const counts = new Map<NightKind, number>();
    for (const b of plan.blocks) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
    for (const k of NIGHT_KINDS) {
      const n = counts.get(k.kind);
      if (!n) continue;
      const row = mk('div', 'np-kind-row');
      if (k.round) {
        // プレ・本番：まとめて動かすのはゲームの長さ（30秒ずつ）
        row.append(
          mk('span', '', `${k.name}${n > 1 ? ` ×${n}` : ''}のゲーム`),
          btn('−', 'kind-game', { kind: k.kind, d: '-30' }, `${k.name}のゲームを全部30秒短く`),
          btn('＋', 'kind-game', { kind: k.kind, d: '30' }, `${k.name}のゲームを全部30秒長く`),
        );
      } else {
        row.append(
          mk('span', '', `${k.name}${n > 1 ? ` ×${n}` : ''}`),
          btn('−', 'kind-mins', { kind: k.kind, d: '-1' }, `${k.name}を全部1分短く`),
          btn('＋', 'kind-mins', { kind: k.kind, d: '1' }, `${k.name}を全部1分長く`),
        );
      }
      kinds.append(row);
    }
  };

  const renderTimes = () => {
    const { end } = placeNight(plan);
    times.replaceChildren();
    const start = mk('div', 'np-time');
    // ブラウザの時刻の欄は言葉の設定で「09:20 PM」になるので、ふつうの欄に「21:20」と打つ
    const timeInput = () => {
      const i = mk('input', 'np-clock u');
      i.type = 'text';
      i.inputMode = 'numeric';
      i.maxLength = 5;
      i.placeholder = '22:30';
      i.autocomplete = 'off';
      return i;
    };
    const sIn = timeInput();
    sIn.value = hhmm(plan.start);
    sIn.dataset.act = 'start';
    sIn.setAttribute('aria-label', '開始の時刻');
    start.append(mk('span', 'np-time-l', '開始'), btn('−5', 'start-step', { d: '-5' }, '開始を5分早く'), sIn, btn('＋5', 'start-step', { d: '5' }, '開始を5分遅く'));
    const lim = mk('div', 'np-time');
    const lIn = timeInput();
    lIn.value = plan.endBy === null ? '' : hhmm(plan.endBy);
    lIn.dataset.act = 'endby';
    lIn.setAttribute('aria-label', '終わっていたい時刻');
    lim.append(mk('span', 'np-time-l', '終わっていたい'), btn('−5', 'endby-step', { d: '-5' }, '終わっていたい時刻を5分早く'), lIn, btn('＋5', 'endby-step', { d: '5' }, '終わっていたい時刻を5分遅く'));
    if (plan.endBy !== null) lim.append(btn('なし', 'endby-clear'));
    const out = mk('div', 'np-time np-time-out');
    out.append(mk('span', 'np-time-l', '終わり（自動）'), mk('output', 'u', hhmm(end)));
    times.append(start, lim, out);
  };

  const renderAdd = () => {
    add.replaceChildren(mk('h3', '', '足す'));
    for (const k of NIGHT_KINDS) {
      const b = btn(`＋ ${k.name}`, 'add', { kind: k.kind });
      b.disabled = plan.blocks.length >= NIGHT_MAX_BLOCKS;
      add.append(b);
    }
  };

  const render = () => {
    const { end } = placeNight(plan);
    sum.textContent = `${hhmm(plan.start)} → ${hhmm(end)}・${spanText(end - plan.start)}`;
    renderChart();
    const list = nightIssues(plan);
    issues.replaceChildren(...list.map((i) => mk('li', '', i.text)));
    issues.hidden = !list.length;
    renderTimes();
    renderTable();
    renderKinds();
    renderAdd();
    note.textContent = saved ? 'いじるとすぐ保存される（どの本部の画面でも同じ予定が見える）' : 'まだ例の予定。いじると保存される';
    el.dataset.open = open ? 'on' : 'off';
    toggle.textContent = open ? '閉じる' : '組む';
    toggle.setAttribute('aria-expanded', String(!!open));
  };

  // ---------- 押したとき ----------
  const blockIndex = (id: string | undefined) => plan.blocks.findIndex((b) => b.id === id);
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    const d = Number(b.dataset.d ?? 0);
    const id = b.dataset.id;
    const p = clone(plan);
    const i = blockIndex(id);
    switch (act) {
      case 'toggle':
        open = !open;
        render();
        return;
      case 'pick':
        selected = selected === id ? null : (id ?? null);
        if (selected && !open) open = true;
        render();
        return;
      case 'mins':
        if (i < 0) return;
        p.blocks[i].mins = clampMins(p.blocks[i].mins + d);
        break;
      case 'kind-mins':
        for (const x of p.blocks) if (x.kind === b.dataset.kind && !x.round) x.mins = clampMins(x.mins + d);
        break;
      case 'kind-game':
        for (const x of p.blocks) if (x.kind === b.dataset.kind && x.round) x.round.phases[2] = clampPart(x.round.phases[2] + d, 1);
        break;
      case 'part': {
        const r = p.blocks[i]?.round;
        if (!r) return;
        const k = Number(b.dataset.i);
        if (k === 0) r.cast = clampPart(r.cast + d, ROUND_PART_MIN);
        else if (k === PHASES.length + 1) r.result = clampPart(r.result + d, ROUND_PART_MIN);
        else r.phases[k - 1] = clampPart(r.phases[k - 1] + d, 1);
        break;
      }
      case 'to-deck': {
        const r = p.blocks[i]?.round;
        if (r) toDeck([...r.phases]);
        return;
      }
      case 'from-deck': {
        const r = p.blocks[i]?.round;
        if (!r || !durations.every((x) => x > 0)) return;
        r.phases = durations.map((x) => Math.round(x / 1000));
        break;
      }
      case 'round-all': {
        const src = p.blocks[i];
        if (!src?.round) return;
        for (const x of p.blocks) if (x.kind === src.kind && x !== src) x.round = { ...src.round, phases: [...src.round.phases] };
        break;
      }
      case 'kind': {
        if (i < 0) return;
        const k = b.dataset.kind as NightKind;
        const wasDefaultTitle = !p.blocks[i].title || p.blocks[i].title === kindInfo(p.blocks[i].kind).name;
        p.blocks[i].kind = k;
        // プレ・本番へ変えたら中身を入れる。ほかへ変えたら中身を外し、長さはそのまま分で持つ
        if (kindInfo(k).round && !p.blocks[i].round) p.blocks[i].round = defaultRound(k);
        if (!kindInfo(k).round && p.blocks[i].round) {
          p.blocks[i].mins = clampMins(Math.round(blockSecs(p.blocks[i]) / 60));
          delete p.blocks[i].round;
        }
        if (wasDefaultTitle) p.blocks[i].title = kindInfo(k).name;
        break;
      }
      case 'move': {
        const j = i + d;
        if (i < 0 || j < 0 || j >= p.blocks.length) return;
        [p.blocks[i], p.blocks[j]] = [p.blocks[j], p.blocks[i]];
        break;
      }
      case 'del':
        if (i < 0) return;
        p.blocks.splice(i, 1);
        selected = null;
        break;
      case 'add': {
        if (p.blocks.length >= NIGHT_MAX_BLOCKS) return;
        const k = kindInfo(b.dataset.kind as NightKind);
        const nb: NightPlan['blocks'][number] = { id: newBlockId(p), kind: k.kind, title: k.name, mins: k.mins };
        if (k.round) nb.round = defaultRound(k.kind);
        // 「終わり」が最後にあれば、その前に入れる（終わり自体を足すときは最後）
        const endIdx = p.blocks.findIndex((x) => x.kind === 'end');
        if (k.kind !== 'end' && endIdx === p.blocks.length - 1) p.blocks.splice(endIdx, 0, nb);
        else p.blocks.push(nb);
        selected = nb.id;
        break;
      }
      case 'start-step':
        p.start = (((p.start + d) % DAY) + DAY) % DAY;
        break;
      case 'endby-step':
        p.endBy = ((((p.endBy ?? placeNight(p).end) + d) % DAY) + DAY) % DAY;
        break;
      case 'endby-clear':
        p.endBy = null;
        break;
      default:
        return;
    }
    change(p);
  });
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const p = clone(plan);
    if (t.dataset.act === 'start') {
      const v = parseHhmm(t.value.replace(/[：.]/g, ':').replace(/^(\d{1,2})(\d{2})$/, '$1:$2'));
      if (v === null) return render();
      p.start = v;
    } else if (t.dataset.act === 'endby') {
      const v = parseHhmm(t.value.replace(/[：.]/g, ':').replace(/^(\d{1,2})(\d{2})$/, '$1:$2'));
      if (t.value.trim() && v === null) return render();
      p.endBy = v;
    } else if (t.classList.contains('np-name')) {
      const i = blockIndex(t.dataset.id);
      if (i < 0) return;
      p.blocks[i].title = t.value.trim().slice(0, NIGHT_TITLE_MAX);
    } else return;
    change(p);
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && (t.classList.contains('np-name') || t.classList.contains('np-clock'))) (t as HTMLInputElement).blur();
  });

  // いまの線を1分ごとに動かす（画面に出ている間だけ）
  setInterval(() => {
    if (el.isConnected && !document.hidden) {
      renderChart();
    }
  }, 60_000);

  render();
  return {
    el,
    update(next, durs, st) {
      let dirty = false;
      if (st !== stage) {
        stage = st;
        dirty = true;
      }
      if (durs.join() !== durations.join()) {
        durations = [...durs];
        dirty = true;
      }
      if (open === null) {
        open = st === 'lobby' || st === undefined;
        dirty = true;
      }
      // サーバーの予定：自分がいじっている最中でなければ合わせる（別の本部の画面での変更もここで入る）
      if (next && !sendTimer && Date.now() - localAt > HOLD_LOCAL_MS && JSON.stringify(next) !== JSON.stringify(plan)) {
        plan = clone(next);
        saved = true;
        if (selected && !plan.blocks.some((b) => b.id === selected)) selected = null;
        dirty = true;
      }
      if (next && !saved) {
        saved = true;
        dirty = true;
      }
      // 見出しを打っている最中は描き直さない（打った字が消える）
      const typing = (document.activeElement as HTMLElement | null)?.closest?.('.np input');
      if (dirty && !typing) render();
    },
  };
}
