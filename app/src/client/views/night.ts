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
  blockRound,
  blockSecs,
  clockText,
  defaultRound,
  ROUND_PART_MIN,
  ROUND_PARTS,
  roundParts,
  sameAsDeck,
  placeNight,
  spanText,
  type NightKind,
  type NightPlan,
  type NightRound,
  type PlacedBlock,
} from '../../shared/night';
import { presetSummary, type Preset } from '../../shared/preset';
import { PHASES } from '../../shared/rules';
import { hqSelect, numberOptions, pickerRow, type OpenDuration, type PickerOption } from './hq-picker';

/**
 * 夜の予定のパレット（本部）。試合の前から夜全体を組んで、不備をつぶすための場所。
 *
 * - 上：地図（横軸＝時計の時刻）。1段目＝ブロック（幅＝長さの比）、2段目＝プレ・本番の中身（配役・4段・結果発表、実際の比）。
 *   終わっていたい時刻は破線、いまの時刻は月白の線
 * - 不備：終わりが遅い・デッキの時間がブロックに収まらない など（朱）
 * - 下：時刻表（1行＝1ブロック）。行を開くと見出し・種類・並びを編集できる。
 *   プレ・本番は中身を1段ずつ選択（長さは中身の合計）。中身はデッキの時間へそのまま入れられる
 * - まとめて：同じ種類のブロック（本番が2つ など）を一度に変更。開始をずらすと全部がずれる
 * 色は道具なので無彩色。色が付くのは不備（朱）だけ
 */

export interface NightPalette {
  el: HTMLElement;
  update(plan: NightPlan | null | undefined, durations: number[], stage: string | undefined, presets: Preset[]): void;
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
const DAY = 24 * 60;

/** 配役・4段・結果発表の現在値。変更できる段だけ時間ピッカーを開ける。 */
export function partRows(r: NightRound, edit?: (button: HTMLButtonElement, index: number, seconds: number) => void): HTMLElement {
  const box = mk('div', 'np-parts');
  let t = 0;
  roundParts(r).forEach((sec, i) => {
    const row = mk('div', 'np-part');
    row.dataset.ro = '';
    const at = mk('span', 'np-part-at u', `+${clockText(t)}`);
    t += sec;
    const value = edit ? btn(clockText(sec), 'part-time', {}, `${ROUND_PARTS[i]} ${clockText(sec)} を選ぶ`) : mk('output', 'u', clockText(sec));
    if (value instanceof HTMLButtonElement) {
      value.classList.add('hq-value');
      value.addEventListener('click', () => edit?.(value, i, sec));
    }
    row.append(mk('span', 'np-part-l', ROUND_PARTS[i]), at, value);
    box.append(row);
  });
  const total = mk('div', 'np-part np-part-total');
  total.append(mk('span', 'np-part-l', '合計'), mk('output', 'u', clockText(t)));
  box.append(total);
  return box;
}

export function setPart(r: NightRound, index: number, seconds: number): void {
  if (index === 0) r.cast = seconds;
  else if (index === PHASES.length + 1) r.result = seconds;
  else r.phases[index - 1] = seconds;
}

export function partMinimum(index: number): number {
  return index > 0 && index <= PHASES.length ? 1 : ROUND_PART_MIN;
}

export interface NightDeck {
  /** プリセットをデッキ全部に入れる（durationsMs があればその時間で） */
  apply(presetId: string, durationsMs?: number[]): void;
  /** デッキの時間だけを変える */
  durations(ms: number[]): void;
}

export function createNightPalette(send: (plan: NightPlan) => void, deck: NightDeck, openDuration: OpenDuration): NightPalette {
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
  let open = false;
  let stage: string | undefined;
  let presets: Preset[] = [];
  /** プレ・本番の長さを分に丸めて持っておく（詳細なしに戻したときの長さ。長さは中身の合計） */
  const syncMins = (p: NightPlan) => {
    for (const b of p.blocks) if (blockRound(b, presets)) b.mins = Math.min(NIGHT_MINS_MAX, Math.max(NIGHT_MINS_MIN, Math.round(blockSecs(b, presets) / 60)));
    return p;
  };
  const canDeck = () => stage === undefined || stage === 'lobby' || stage === 'assigned' || stage === 'result';
  /** プレ・本番を足すときのプリセット：名前に「プレ」が入っているもの／入っていないもの */
  const presetFor = (kind: NightKind) =>
    (kind === 'pre' ? presets.find((x) => x.name.includes('プレ')) : presets.find((x) => !x.name.includes('プレ')))?.id ?? presets[0]?.id ?? null;

  const choose = (label: string, items: readonly PickerOption[], value: string, act: string, attrs: Record<string, string> = {}) => {
    const select = hqSelect(label, items, value);
    Object.assign(select.dataset, attrs, { act });
    return select;
  };
  const kindOptions = NIGHT_KINDS.map((k) => [k.kind, k.name] as const);

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
    const { blocks, end } = placeNight(plan, presets);
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
    const bad = new Set(nightIssues(plan, presets).map((i) => i.id));
    for (const b of blocks) {
      const box = mk('span', 'np-blk');
      box.dataset.kind = b.kind;
      box.toggleAttribute('data-selected', b.id === selected);
      if (bad.has(b.id)) box.dataset.bad = '';
      box.style.left = x(b.from);
      box.style.width = w(b.to - b.from);
      box.title = `${hhmm(b.from)}から ${b.title || kindInfo(b.kind).name}`;
      const lab = mk('span', 'np-blk-l', b.title || kindInfo(b.kind).name);
      box.append(lab);
      lane.append(box);
      const r = blockRound(b, presets);
      if (r) {
        // 中身：配役・4段・結果発表を、ブロックの頭から実際の比で
        let t = b.from;
        roundParts(r).forEach((sec, i) => {
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

  /** プレ・本番：プリセットを選ぶ／このブロックだけ時間を変える／詳細なし。デッキへ入れる・同じ種類へまとめて */
  const roundEditor = (b: PlacedBlock) => {
    const box = mk('div', 'np-round');
    box.append(pickerRow('プリセット', choose('プリセット', [['', 'なし'], ...presets.map((x) => [x.id, x.name] as const)], b.preset ?? '', 'preset', { id: b.id })));
    const pre = b.preset ? (presets.find((x) => x.id === b.preset) ?? null) : null;
    if (pre) box.append(mk('p', 'np-hint', presetSummary(pre)));
    const own = mk('div', 'np-ops');
    if (pre) own.append(btn(b.round ? 'プリセットの時間に戻す' : 'このブロックだけ時間を変える', b.round ? 'own-off' : 'own-on', { id: b.id }));
    else own.append(btn(b.round ? '詳細なし（分だけ）にする' : '時間を細かく決める', b.round ? 'own-off' : 'own-on', { id: b.id }));
    box.append(own);
    if (b.round) {
      if (pre) box.append(mk('p', 'np-hint', 'このブロックだけの時間（ほかの札はプリセットのまま）'));
      box.append(partRows(b.round, (button, index, seconds) => {
        openDuration(button, ROUND_PARTS[index], seconds, partMinimum(index), (value) => {
          const next = clone(plan);
          const round = next.blocks.find((block) => block.id === b.id)?.round;
          if (!round) return;
          setPart(round, index, value);
          change(next);
        });
      }));
    } else if (pre) box.append(partRows(pre.round));
    const r = blockRound(b, presets);
    const ops = mk('div', 'np-ops');
    if (pre || r) {
      const label = pre ? 'このプリセットをデッキへ入れる' : 'この時間をデッキへ入れる';
      const put = btn(label, 'apply', { id: b.id });
      put.disabled = !canDeck() || (!pre && sameAsDeck(r ?? undefined, durations));
      ops.append(put);
      if (b.round) ops.append(btn('デッキの時間を取り込む', 'from-deck', { id: b.id }));
    }
    const n = plan.blocks.filter((x) => x.kind === b.kind).length;
    if (n > 1) ops.append(btn(`同じ中身を${kindInfo(b.kind).name}すべてに`, 'round-all', { id: b.id }));
    if (ops.childElementCount) box.append(ops);
    if (!canDeck() && (pre || r)) box.append(mk('p', 'np-hint', 'デッキへ入れられるのは、待合室・配役のあと・結果発表の間だけ'));
    return box;
  };

  const renderTable = () => {
    const { blocks, end } = placeNight(plan, presets);
    const issueIds = new Set(nightIssues(plan, presets).map((i) => i.id));
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
      const pre = b.preset ? presets.find((x) => x.id === b.preset) : undefined;
      pick.append(mk('span', 'u np-at', hhmm(b.from)), mk('span', 'np-title', b.title || kindInfo(b.kind).name), mk('span', 'np-kind', pre ? pre.name : kindInfo(b.kind).name));
      const mins = mk('span', 'np-mins');
      const r = blockRound(b, presets);
      if (r) {
        // プレ・本番：長さは中身の合計。行では長さだけ見せる（いじるのは中身）
        if (sameAsDeck(r, durations)) mins.append(mk('span', 'np-deck', 'デッキ'));
        mins.append(mk('output', 'u np-len', clockText(blockSecs(b, presets))));
      } else {
        mins.append(choose(`${b.title || kindInfo(b.kind).name}の長さ`, numberOptions(NIGHT_MINS_MIN, NIGHT_MINS_MAX, '分'), String(b.mins), 'mins', { id: b.id }));
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
        const kindRow = pickerRow('種類', choose('予定の種類', kindOptions, b.kind, 'kind', { id: b.id }));
        const move = pickerRow('並び順', choose('予定の並び順', blocks.map((_, index) => [String(index), `${index + 1}番目`]), String(i), 'move', { id: b.id }));
        const ops = mk('div', 'np-ops');
        const del = btn('消す', 'del', { id: b.id });
        del.classList.add('np-del');
        ops.append(del);
        ed.append(name, kindRow, move);
        if (kindInfo(b.kind).round) ed.append(roundEditor(b));
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
      const label = `${k.name}${n > 1 ? `（${n}件）` : ''}`;
      if (k.round) {
        const current = presets.find((x) => plan.blocks.every((b) => b.kind !== k.kind || (b.preset === x.id && !b.round)));
        const select = choose(`${k.name}の共通プリセット`, [['', 'プリセットを選ぶ', true], ...presets.map((x) => [x.id, x.name] as const)], current?.id ?? '', 'kind-preset', { kind: k.kind });
        select.disabled = presets.length === 0;
        kinds.append(pickerRow(label, select));
      } else if (n > 1) {
        kinds.append(pickerRow(label, choose(`${k.name}の長さをまとめて調整`, [['', '長さを調整', true], ['-5', '各5分短く'], ['-1', '各1分短く'], ['1', '各1分長く'], ['5', '各5分長く']], '', 'kind-mins', { kind: k.kind })));
      }
    }
  };

  const renderTimes = () => {
    const { end } = placeNight(plan, presets);
    times.replaceChildren();
    const timeInput = (label: string, act: string, value: number | null) => {
      const input = mk('input', 'hq-select np-clock');
      input.type = 'time';
      input.value = value === null ? '' : hhmm(value);
      input.dataset.act = act;
      input.setAttribute('aria-label', label);
      return pickerRow(label, input);
    };
    const out = mk('p', 'np-note', `終わり（自動） ${hhmm(end)}`);
    times.append(timeInput('開始の時刻', 'start', plan.start), timeInput('終わっていたい時刻', 'endby', plan.endBy));
    if (plan.endBy !== null) times.append(btn('終了目標を外す', 'endby-clear'));
    times.append(out);
  };

  const renderAdd = () => {
    const select = choose('予定を追加', [['', '種類を選ぶ', true], ...kindOptions], '', 'add');
    select.disabled = plan.blocks.length >= NIGHT_MAX_BLOCKS;
    add.replaceChildren(pickerRow('予定を追加', select));
  };

  const render = () => {
    const { end } = placeNight(plan, presets);
    sum.textContent = `${hhmm(plan.start)} → ${hhmm(end)}・${spanText(end - plan.start)}`;
    renderChart();
    const list = nightIssues(plan, presets);
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
  const actOn = (b: HTMLButtonElement | HTMLSelectElement) => {
    if (b.disabled) return;
    const act = b.dataset.act;
    const value = b.value;
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
        p.blocks[i].mins = clampMins(Number(value));
        break;
      case 'kind-mins':
        for (const x of p.blocks) if (x.kind === b.dataset.kind && !x.round) x.mins = clampMins(x.mins + Number(value));
        break;
      case 'kind-preset':
        for (const x of p.blocks) {
          if (x.kind !== b.dataset.kind) continue;
          x.preset = value || null;
          delete x.round;
        }
        break;
      case 'preset': {
        if (i < 0) return;
        p.blocks[i].preset = value || null;
        // プリセットを替えたら、このブロックだけの時間は外す（新しいプリセットの時間になる）
        if (value) delete p.blocks[i].round;
        break;
      }
      case 'own-on': {
        if (i < 0) return;
        const r = blockRound(p.blocks[i], presets) ?? defaultRound(p.blocks[i].kind);
        p.blocks[i].round = { ...r, phases: [...r.phases] };
        break;
      }
      case 'own-off':
        if (i < 0) return;
        if (!p.blocks[i].preset) p.blocks[i].mins = clampMins(Math.round(blockSecs(p.blocks[i], presets) / 60));
        delete p.blocks[i].round;
        break;
      case 'apply': {
        const x = p.blocks[i];
        if (!x) return;
        const r = blockRound(x, presets);
        if (x.preset && presets.some((y) => y.id === x.preset)) deck.apply(x.preset, x.round ? x.round.phases.map((v) => v * 1000) : undefined);
        else if (r) deck.durations(r.phases.map((v) => v * 1000));
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
        if (!src) return;
        for (const x of p.blocks) {
          if (x.kind !== src.kind || x === src) continue;
          x.preset = src.preset ?? null;
          if (src.round) x.round = { ...src.round, phases: [...src.round.phases] };
          else delete x.round;
          x.mins = src.mins;
        }
        break;
      }
      case 'kind': {
        if (i < 0) return;
        const k = value as NightKind;
        const wasDefaultTitle = !p.blocks[i].title || p.blocks[i].title === kindInfo(p.blocks[i].kind).name;
        p.blocks[i].kind = k;
        // プレ・本番へ変えたらプリセットを入れる。ほかへ変えたら中身を外し、長さはそのまま分で持つ
        if (kindInfo(k).round && !p.blocks[i].preset && !p.blocks[i].round) p.blocks[i].preset = presetFor(k);
        if (!kindInfo(k).round) {
          p.blocks[i].mins = clampMins(Math.round(blockSecs(p.blocks[i], presets) / 60));
          delete p.blocks[i].round;
          delete p.blocks[i].preset;
        }
        if (wasDefaultTitle) p.blocks[i].title = kindInfo(k).name;
        break;
      }
      case 'move': {
        const j = Number(value);
        if (i < 0 || j < 0 || j >= p.blocks.length || j === i) return;
        const [block] = p.blocks.splice(i, 1);
        p.blocks.splice(j, 0, block);
        break;
      }
      case 'del':
        if (i < 0) return;
        p.blocks.splice(i, 1);
        selected = null;
        break;
      case 'add': {
        if (p.blocks.length >= NIGHT_MAX_BLOCKS) return;
        const k = kindInfo(value as NightKind);
        const nb: NightPlan['blocks'][number] = { id: newBlockId(p), kind: k.kind, title: k.name, mins: k.mins };
        if (k.round) nb.preset = presetFor(k.kind);
        // 「終わり」が最後にあれば、その前に入れる（終わり自体を足すときは最後）
        const endIdx = p.blocks.findIndex((x) => x.kind === 'end');
        if (k.kind !== 'end' && endIdx === p.blocks.length - 1) p.blocks.splice(endIdx, 0, nb);
        else p.blocks.push(nb);
        selected = nb.id;
        break;
      }
      case 'endby-clear':
        p.endBy = null;
        break;
      default:
        return;
    }
    change(p);
  };
  el.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (button) actOn(button);
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement) return actOn(t);
    if (!(t instanceof HTMLInputElement)) return;
    const p = clone(plan);
    if (t.dataset.act === 'start') {
      const v = parseHhmm(t.value);
      if (v === null) return render();
      p.start = v;
    } else if (t.dataset.act === 'endby') {
      const v = parseHhmm(t.value);
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
    update(next, durs, st, list) {
      let dirty = false;
      if (JSON.stringify(list) !== JSON.stringify(presets)) {
        presets = list;
        dirty = true;
      }
      if (st !== stage) {
        stage = st;
        dirty = true;
      }
      if (durs.join() !== durations.join()) {
        durations = [...durs];
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
      const typing = (document.activeElement as HTMLElement | null)?.closest?.('.np input, .np select');
      if (dirty && !typing) render();
    },
  };
}
