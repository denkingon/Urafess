import type { GameView } from '../../shared/protocol';
import { AREA_MAX_PTS, AREA_MIN_PTS, areaSize, checkArea } from '../../shared/area';
import { CHAT_MODE_NAME, type ChatJail, type ChatMode } from '../../shared/chat';
import { LEAD_RULE_KEYS, type LeadRuleKey } from '../../shared/lead';
import { basePreset, cleanPreset, cleanPresets, GAME_MODES, newPresetId, PRESET_NAME_MAX, PRESETS_MAX, presetSummary, type GameMode, type Preset } from '../../shared/preset';
import { RATIO_MAX, type MicMode, type RevealMode, type WishMode } from '../../shared/rules';
import { midOf, scalePts, SHRINK_FINAL_AREAS, SHRINK_MAX_TIMES, type ShrinkTo } from '../../shared/shrink';
import { bumpPart, partRows } from './night';
import { createOverview, RING_BOX, toWorld } from './overview';

/**
 * ルールのプリセット（本部）。デッキ全部の組み合わせに名前を付けて、先に作っておく場所。
 *
 * - 並び：1行＝1プリセット（名前と要約）。押すと中身を開く
 * - 中身：遊び方・時間（配役・4段・結果発表）・鬼と逃走者・配役の決め方・出し方・マイク・司令塔・チャット・遊ぶ範囲・範囲の縮み
 * - 遊ぶ範囲：そのまま（いまの範囲に触らない）／このプリセットの範囲（地図を押して描く）／範囲なし。並びの左に、範囲の形の小さい絵（全部のプリセットで同じ縮尺）
 * - 札ごとに「全部のプリセットへ」：その札だけを、ほかのプリセットにもそろえる（まとめて変える層）
 * - いまのデッキを取り込む／デッキへ入れる／複製／消す
 * - テキストで書き出す・貼って取り込む（ほかの会話で Claude と練った中身をそのまま入れる）
 * 道具なので無彩色。
 */

export interface PresetPalette {
  el: HTMLElement;
  update(list: Preset[] | undefined, game: GameView | null): void;
}

const SEND_AFTER_MS = 350;
const HOLD_LOCAL_MS = 2000;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(text: string, act: string, extra: Record<string, string> = {}, pressed?: boolean, label?: string): HTMLButtonElement {
  const b = mk('button', '', text);
  b.type = 'button';
  b.dataset.act = act;
  for (const [k, v] of Object.entries(extra)) b.dataset[k] = v;
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  if (label) b.setAttribute('aria-label', label);
  return b;
}
const copy = (p: Preset): Preset => JSON.parse(JSON.stringify(p)) as Preset;

/** 札のまとまり（「全部のプリセットへ」でそろえる単位） */
type Section = 'mode' | 'round' | 'ratio' | 'cast' | 'lead' | 'chat' | 'area' | 'shrink';
const SECTION_KEYS: Record<Section, (keyof Preset)[]> = {
  mode: ['mode'],
  round: ['round'],
  ratio: ['ratio'],
  cast: ['wish', 'reveal', 'mic'],
  lead: ['lead'],
  chat: ['chat'],
  area: ['area', 'jail'],
  shrink: ['shrink'],
};
const LEAD_NAME: Record<LeadRuleKey, string> = {
  on: '司令塔のしくみ',
  seen: '司令塔は相手に見える',
  dark: '捕まったら地図が消える',
  expose: '捕まったら鬼に全員が見える',
  restore: '助ければ元に戻る',
};

const NS = 'http://www.w3.org/2000/svg';
const THUMB = 48;
const RING_PTS: [number, number][] = [
  [RING_BOX.north, RING_BOX.west],
  [RING_BOX.north, RING_BOX.east],
  [RING_BOX.south, RING_BOX.east],
  [RING_BOX.south, RING_BOX.west],
];
type Layer = 'area' | 'jail';
const ptsOf = (p: Preset, l: Layer = 'area'): [number, number][] | null => {
  const v = p[l];
  return Array.isArray(v) ? v : null;
};
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * 並びの左の小さい絵：そのプリセットの範囲の形。枠は全部のプリセットで同じ（メビウスリングのまわり＋全部の範囲が入る四角）なので、広さを見くらべられる。
 * そのまま＝点線の枠だけ、範囲なし＝斜めの線
 */
function areaThumb(p: Preset, all: readonly Preset[]): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('class', 'pp-thumb');
  el.setAttribute('viewBox', `0 0 ${THUMB} ${THUMB}`);
  el.setAttribute('aria-hidden', 'true');
  const ws = [...RING_PTS, ...all.flatMap((x) => ptsOf(x) ?? [])].map(([lat, lon]) => toWorld({ lat, lon }));
  const x0 = Math.min(...ws.map((w) => w.x));
  const x1 = Math.max(...ws.map((w) => w.x));
  const y0 = Math.min(...ws.map((w) => w.y));
  const y1 = Math.max(...ws.map((w) => w.y));
  const pad = 5;
  const S = (THUMB - pad * 2) / Math.max(x1 - x0, y1 - y0, 1e-12);
  const ox = (THUMB - (x1 - x0) * S) / 2;
  const oy = (THUMB - (y1 - y0) * S) / 2;
  const at = ([lat, lon]: [number, number]) => {
    const w = toWorld({ lat, lon });
    return `${(ox + (w.x - x0) * S).toFixed(1)},${(oy + (w.y - y0) * S).toFixed(1)}`;
  };
  const poly = (pts: [number, number][], cls: string) => {
    const g = document.createElementNS(NS, 'polygon');
    g.setAttribute('points', pts.map(at).join(' '));
    g.setAttribute('class', cls);
    el.append(g);
  };
  poly(RING_PTS, 'pp-thumb-ring');
  const pts = ptsOf(p);
  if (pts) poly(pts, 'pp-thumb-area');
  else if (p.area === 'none') {
    const l = document.createElementNS(NS, 'line');
    for (const [k, v] of Object.entries({ x1: 8, y1: THUMB - 8, x2: THUMB - 8, y2: 8 })) l.setAttribute(k, String(v));
    l.setAttribute('class', 'pp-thumb-none');
    el.append(l);
  }
  const jail = ptsOf(p, 'jail');
  if (jail) {
    const ws2 = jail.map(([lat, lon]) => toWorld({ lat, lon }));
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', (ox + (ws2.reduce((a, w) => a + w.x, 0) / ws2.length - x0) * S).toFixed(1));
    c.setAttribute('cy', (oy + (ws2.reduce((a, w) => a + w.y, 0) / ws2.length - y0) * S).toFixed(1));
    c.setAttribute('r', '3');
    c.setAttribute('class', 'pp-thumb-jail');
    el.append(c);
  }
  return el;
}

export function createPresetPalette(send: (list: Preset[]) => void, apply: (id: string) => void): PresetPalette {
  const el = mk('section', 'np pp');
  el.setAttribute('aria-label', 'プリセット');
  const head = mk('header', 'np-head');
  const sum = mk('span', 'np-sum');
  const toggle = btn('組む', 'toggle');
  toggle.classList.add('np-toggle');
  head.append(mk('h2', '', 'プリセット'), sum, toggle);
  const list = mk('ol', 'np-table pp-list');
  const foot = mk('div', 'np-ops pp-foot');
  const io = mk('div', 'pp-io');
  io.hidden = true;
  el.append(head, list, foot, io);

  let presets: Preset[] = [];
  let game: GameView | null = null;
  let selected: string | null = null;
  let open: boolean | null = null;
  let localAt = 0;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let ioMode: 'out' | 'in' | null = null;
  let ioMsg = '';

  const canDeck = () => !game || game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result';

  // 遊ぶ範囲を描く地図（1枚を使い回す。開いているプリセットの中に差しこむ）。描いている途中の角は「決める」まで送らない
  let layer: Layer = 'area';
  let drawing: { id: string; layer: Layer; pts: [number, number][] } | null = null;
  const draftOf = (id: string) => (drawing?.id === id && drawing.layer === layer ? drawing.pts : null);
  /** そのプリセットをデッキへ入れたあとの牢屋（プリセットが持っていればそれ、そのままなら部屋のいまの牢屋） */
  const jailOf = (p: Preset) => ptsOf(p, 'jail') ?? (p.jail === 'none' ? null : (game?.jail?.pts ?? null));
  const mapBox = mk('div', 'pp-map');
  const areaMap = createOverview({
    onTap: (pos) => {
      const p = presets.find((x) => x.id === selected);
      if (!p || p[layer] === 'none' || (!ptsOf(p, layer) && !draftOf(p.id))) return;
      const d = draftOf(p.id) ?? [];
      if (d.length >= AREA_MAX_PTS) return;
      drawing = { id: p.id, layer, pts: [...d, [round6(pos.lat), round6(pos.lon)]] };
      render();
    },
  });
  mapBox.append(areaMap.el);
  const drawMap = (p: Preset) => {
    const pts = ptsOf(p);
    const d = draftOf(p.id);
    const center = pts && !d?.length && layer === 'area' && p.shrink.times > 0 && p.shrink.to === 'mid' ? midOf(pts) : null;
    areaMap.update({
      me: null,
      meKind: 'unknown',
      meLit: false,
      points: [],
      labelMax: 0,
      area: pts,
      jail: jailOf(p),
      draft: d?.length ? d : null,
      draftLayer: layer,
      frameBase: d && layer === 'area' ? 'campus' : 'area',
      zone: center && pts ? { center, preview: scalePts(pts, center, Math.sqrt(p.shrink.finalArea)) } : null,
    });
  };

  const change = (next: Preset[]) => {
    presets = next;
    localAt = Date.now();
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      send(presets);
    }, SEND_AFTER_MS);
    render();
  };

  // ---------- 描く ----------
  const seg = <T extends string>(label: string, act: string, id: string, now: T, items: [T, string, boolean?][]) => {
    const row = mk('div', 'np-seg-btns');
    row.append(mk('span', 'np-seg-l', label));
    for (const [v, name, off] of items) {
      const b = btn(name, act, { id, v }, v === now);
      if (off) b.disabled = true;
      row.append(b);
    }
    return row;
  };
  const stepper = (label: string, act: string, id: string, value: string, extra: Record<string, string>, downOff: boolean, upOff: boolean) => {
    const row = mk('div', 'np-part');
    const dn = btn('−', act, { id, ...extra, d: '-1' }, undefined, `${label}を減らす`);
    dn.disabled = downOff;
    const up = btn('＋', act, { id, ...extra, d: '1' }, undefined, `${label}を増やす`);
    up.disabled = upOff;
    row.append(mk('span', 'np-part-l', label), dn, mk('output', 'u', value), up);
    row.dataset.step = '';
    return row;
  };
  const section = (title: string, key: Section, id: string, ...kids: HTMLElement[]) => {
    const box = mk('div', 'pp-sec');
    const h = mk('div', 'pp-sec-h');
    h.append(mk('h3', '', title));
    if (presets.length > 1) h.append(btn('全部のプリセットへ', 'all', { id, sec: key }));
    box.append(h, ...kids);
    return box;
  };

  const LAYER_TEXT: Record<Layer, { own: string; none: string; keep: (now: string) => string; gone: string; nowNone: string }> = {
    area: {
      own: 'このプリセットの範囲',
      none: '範囲なし',
      keep: (now) => `デッキへ入れても、いまの遊ぶ範囲に触らない（いま：${now}）`,
      gone: 'デッキへ入れると、遊ぶ範囲が消える（どこまで行っても「戻れ」は出ない）',
      nowNone: '範囲なし',
    },
    jail: {
      own: 'このプリセットの牢屋',
      none: '牢屋の場所なし',
      keep: (now) => `デッキへ入れても、いまの牢屋の場所に触らない（いま：${now}）`,
      gone: 'デッキへ入れると、牢屋の場所が消える（捕まった人に牢屋への向きが出なくなる）',
      nowNone: 'まだ決めていない',
    },
  };
  const areaSection = (p: Preset) => {
    const T = LAYER_TEXT[layer];
    const pts = ptsOf(p, layer);
    const d = draftOf(p.id);
    const kind = d || pts ? 'own' : p[layer] === 'none' ? 'none' : 'keep';
    const state = (l: Layer) => (ptsOf(p, l) ? '決めた' : p[l] === 'none' ? 'なし' : 'そのまま');
    const tabs = mk('div', 'np-seg-btns pp-layers');
    for (const [l, name] of [['area', '遊ぶ範囲'], ['jail', '牢屋']] as [Layer, string][]) {
      tabs.append(btn(`${name}：${state(l)}`, 'area-layer', { id: p.id, v: l }, l === layer));
    }
    const kids: HTMLElement[] = [tabs, seg<string>('', 'area-kind', p.id, kind, [['keep', 'そのまま'], ['own', T.own], ['none', T.none]])];
    const now = game?.[layer]?.pts ?? null;
    if (kind === 'keep') {
      kids.push(mk('p', 'np-hint', T.keep(now ? areaSize(now) : T.nowNone)));
    } else if (kind === 'none') {
      kids.push(mk('p', 'np-hint', T.gone));
    } else {
      const text = d
        ? d.length < AREA_MIN_PTS
          ? `地図を押して角を足す（いま ${d.length}。3つ以上で決められる）`
          : `描いている途中（角 ${d.length}・${areaSize(d)}）。「決める」でこのプリセットに入る`
        : `角 ${pts!.length}・${areaSize(pts!)}。地図を押すと描き直せる`;
      kids.push(mk('p', 'np-hint pp-area-now', text), mapBox);
      const ops = mk('div', 'np-ops');
      if (d) {
        const undo = btn('1つ戻す', 'area-undo', { id: p.id });
        undo.disabled = d.length === 0;
        const save = btn('決める', 'area-save', { id: p.id });
        save.classList.add('pp-go');
        save.disabled = d.length < AREA_MIN_PTS;
        ops.append(undo, btn('やめる', 'area-cancel', { id: p.id }), save);
      }
      if (layer === 'area') ops.append(btn('メビウスリングの四角', 'area-ring', { id: p.id }));
      const take = btn(layer === 'area' ? 'いまの範囲を取り込む' : 'いまの牢屋を取り込む', 'area-take', { id: p.id });
      take.disabled = !now;
      ops.append(take);
      kids.push(ops);
      if (layer === 'area' && pts && !d && p.shrink.times > 0) kids.push(mk('p', 'np-hint', p.shrink.to === 'mid' ? '点線＝時間で縮みきったときの形' : '縮む先は毎回どこか（始めるときに決まる）'));
    }
    // デッキへ入れたあとの牢屋が、入れたあとの範囲の外にあれば知らせる（描いている途中の形も見る）
    const dOk = d && d.length >= AREA_MIN_PTS ? d : null;
    const areaAfter = (layer === 'area' ? dOk : null) ?? ptsOf(p, 'area') ?? (p.area === 'none' ? null : (game?.area?.pts ?? null));
    const jailAfter = (layer === 'jail' ? dOk : null) ?? jailOf(p);
    if (areaAfter && jailAfter && (ptsOf(p, 'area') || ptsOf(p, 'jail') || dOk)) {
      const mid = midOf(jailAfter);
      if (!checkArea(areaAfter, { lat: mid[0], lon: mid[1] }).inside) {
        const warn = mk('ul', 'np-issues');
        warn.append(mk('li', '', '牢屋の場所が遊ぶ範囲の外にある（捕まった人が牢屋へ歩くと「戻れ」が出る）'));
        kids.push(warn);
      }
    }
    return section('遊ぶ範囲・牢屋', 'area', p.id, ...kids);
  };

  const editor = (p: Preset) => {
    const ed = mk('div', 'np-editor pp-editor');
    const name = mk('input', 'np-name');
    name.type = 'text';
    name.maxLength = PRESET_NAME_MAX;
    name.value = p.name;
    name.dataset.id = p.id;
    name.setAttribute('aria-label', 'プリセットの名前');
    ed.append(name);
    ed.append(
      section('遊び方', 'mode', p.id, seg<GameMode>('', 'mode', p.id, p.mode, GAME_MODES.map((m) => [m.mode, m.ready ? m.name : `${m.name}（まだ）`, !m.ready]))),
    );
    if (GAME_MODES.some((m) => !m.ready)) ed.lastElementChild!.append(mk('p', 'np-hint', '氷鬼の決まりはまだアプリに無い（選んでもドロケイで動く）。増やし鬼は、捕まった人が牢屋に入らず鬼になる'));
    ed.append(section('時間', 'round', p.id, partRows(p.round, { id: p.id })));
    ed.append(
      section(
        '鬼と逃走者',
        'ratio',
        p.id,
        stepper('鬼', 'ratio', p.id, String(p.ratio.oni), { r: 'oni' }, p.ratio.oni <= 1, p.ratio.oni >= RATIO_MAX),
        stepper('逃走者', 'ratio', p.id, String(p.ratio.runner), { r: 'runner' }, p.ratio.runner <= 1, p.ratio.runner >= RATIO_MAX),
      ),
    );
    ed.append(
      section(
        '配役',
        'cast',
        p.id,
        seg<WishMode>('決め方', 'wish', p.id, p.wish, [['wish', '希望を聞く'], ['lot', 'くじだけ']]),
        seg<RevealMode>('出し方', 'reveal', p.id, p.reveal, [['sync', '全員同時'], ['tap', 'タップ'], ['now', 'すぐ出す']]),
        seg<MicMode>('鬼のマイク', 'mic', p.id, p.mic, [['always', 'ずっと'], ['hold', '押す間']]),
      ),
    );
    const lead = mk('div', 'pp-switches');
    for (const k of LEAD_RULE_KEYS) {
      if (k !== 'on' && !p.lead.on) continue;
      const b = btn(LEAD_NAME[k], 'lead', { id: p.id, k }, p.lead[k]);
      b.classList.add('hq-switch');
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(p.lead[k]));
      lead.append(b);
    }
    ed.append(section('司令塔', 'lead', p.id, lead));
    ed.append(
      section(
        'チャット',
        'chat',
        p.id,
        seg<ChatMode>('送れるもの', 'chat-mode', p.id, p.chat.mode, (['card', 'emoji', 'digit', 'off'] as ChatMode[]).map((m) => [m, CHAT_MODE_NAME[m]])),
        seg<ChatJail>('牢屋の人', 'chat-jail', p.id, p.chat.jail, [['emoji', '絵文字だけ'], ['same', '同じ']]),
      ),
    );
    ed.append(areaSection(p));
    ed.append(
      section(
        '範囲の縮み',
        'shrink',
        p.id,
        stepper('時間で縮む回数', 'shrink-times', p.id, `${p.shrink.times}回`, {}, p.shrink.times <= 0, p.shrink.times >= SHRINK_MAX_TIMES),
        seg<string>('最後の広さ', 'shrink-area', p.id, String(p.shrink.finalArea), SHRINK_FINAL_AREAS.map((a) => [String(a), `${Math.round(a * 100)}%`])),
        seg<ShrinkTo>('縮む先', 'shrink-to', p.id, p.shrink.to, [['mid', '真ん中'], ['random', '毎回どこか']]),
        seg<string>('ミッション成功で縮む', 'shrink-mission', p.id, String(p.shrink.mission), [['true', '入'], ['false', '切']]),
      ),
    );
    const ops = mk('div', 'np-ops');
    const put = btn('デッキへ入れる', 'apply', { id: p.id });
    put.disabled = !canDeck() || !game;
    ops.append(put, btn('いまのデッキを取り込む', 'from-game', { id: p.id }), btn('複製', 'dup', { id: p.id }));
    const del = btn('消す', 'del', { id: p.id });
    del.classList.add('np-del');
    del.disabled = presets.length <= 1;
    ops.append(del);
    ed.append(ops);
    if (!canDeck()) ed.append(mk('p', 'np-hint', 'デッキへ入れられるのは、待合室・配役のあと・結果発表の間だけ'));
    return ed;
  };

  const render = () => {
    sum.textContent = `${presets.length}個`;
    el.dataset.open = open ? 'on' : 'off';
    toggle.textContent = open ? '閉じる' : '組む';
    toggle.setAttribute('aria-expanded', String(!!open));
    list.replaceChildren();
    for (const p of presets) {
      const li = mk('li', 'np-row pp-row');
      const pick = mk('button', 'np-pick pp-pick');
      pick.type = 'button';
      pick.dataset.act = 'pick';
      pick.dataset.id = p.id;
      pick.setAttribute('aria-expanded', String(p.id === selected));
      const text = mk('span', 'pp-pick-t');
      text.append(mk('span', 'np-title', p.name), mk('span', 'pp-sum', presetSummary(p)));
      pick.append(areaThumb(p, presets), text);
      li.append(pick);
      if (p.id === selected && open) li.append(editor(p));
      list.append(li);
    }
    const cur = open ? presets.find((x) => x.id === selected) : undefined;
    if (cur && mapBox.isConnected) drawMap(cur);
    foot.replaceChildren();
    const add = btn('＋ 新しいプリセット', 'new');
    add.disabled = presets.length >= PRESETS_MAX;
    foot.append(add, btn('テキストで書き出す', 'io-out', {}, ioMode === 'out'), btn('テキストを貼って取り込む', 'io-in', {}, ioMode === 'in'));
    io.hidden = !ioMode;
    if (ioMode) {
      io.replaceChildren();
      const ta = mk('textarea', 'pp-text');
      ta.rows = 8;
      ta.spellcheck = false;
      if (ioMode === 'out') {
        ta.value = JSON.stringify(presets, null, 1);
        ta.readOnly = true;
        io.append(mk('p', 'np-hint', 'Claude との会話に貼れば、中身を一緒に練れる。直したものは「貼って取り込む」で戻す'), ta, btn('写す', 'io-copy'));
      } else {
        ta.placeholder = '[{"name":"雨の夜ドロケイ", …}]';
        io.append(mk('p', 'np-hint', '1つでも並びでもいい。同じ印のプリセットは置きかえ、新しいものは足す'), ta, btn('取り込む', 'io-load'));
      }
      if (ioMsg) io.append(mk('p', 'np-hint pp-msg', ioMsg));
    }
  };

  // ---------- 押したとき ----------
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const act = b.dataset.act!;
    const id = b.dataset.id;
    const d = Number(b.dataset.d ?? 0);
    const v = b.dataset.v ?? '';
    const next = presets.map(copy);
    const p = next.find((x) => x.id === id);
    switch (act) {
      case 'toggle':
        open = !open;
        return render();
      case 'pick':
        selected = selected === id ? null : (id ?? null);
        open = true;
        drawing = null;
        return render();
      case 'area-undo':
        if (drawing) drawing = { ...drawing, pts: drawing.pts.slice(0, -1) };
        return render();
      case 'area-cancel':
        drawing = null;
        return render();
      case 'area-layer':
        layer = v as Layer;
        drawing = null;
        return render();
      case 'area-kind':
        if (v === 'own') {
          // 形がまだ無ければ、描き始める（「決める」まではプリセットは変わらない）
          if (p && !ptsOf(p, layer)) drawing = { id: p.id, layer, pts: [] };
          if (p && p[layer] === 'none') break;
          return render();
        }
        drawing = null;
        break;
      case 'io-out':
      case 'io-in':
        ioMode = ioMode === (act === 'io-out' ? 'out' : 'in') ? null : act === 'io-out' ? 'out' : 'in';
        ioMsg = '';
        return render();
      case 'io-copy': {
        const ta = io.querySelector('textarea');
        if (ta) void navigator.clipboard?.writeText(ta.value).then(() => {
          ioMsg = '写した';
          render();
        }, () => ta.select());
        return;
      }
      case 'io-load': {
        const ta = io.querySelector('textarea');
        let raw: unknown;
        try {
          raw = JSON.parse(ta?.value ?? '');
        } catch {
          ioMsg = '読めなかった（JSON の形になっていない）';
          return render();
        }
        const items = Array.isArray(raw) ? raw : [raw];
        let n = 0;
        for (const item of items) {
          const it = { ...(item as Record<string, unknown>) };
          // 印が無いもの・重なるものには新しい印を振る（同じ印なら置きかえ）
          if (typeof it.id !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(it.id)) it.id = newPresetId(next);
          const x = cleanPreset(it);
          if (!x) continue;
          const at = next.findIndex((y) => y.id === x.id);
          if (at >= 0) next[at] = x;
          else if (next.length < PRESETS_MAX) next.push(x);
          else continue;
          n++;
        }
        ioMsg = n ? `${n}個 取り込んだ` : '取り込めるプリセットが無かった（形がちがう）';
        if (!n) return render();
        ioMode = null;
        return change(cleanPresets(next) ?? presets);
      }
      case 'new': {
        const x = basePreset(newPresetId(next), `プリセット${next.length + 1}`);
        next.push(x);
        selected = x.id;
        open = true;
        break;
      }
      default:
        if (!p) return;
    }
    if (p)
      switch (act) {
        case 'mode':
          p.mode = v as GameMode;
          break;
        case 'part':
          bumpPart(p.round, Number(b.dataset.i), d);
          break;
        case 'ratio': {
          const k = b.dataset.r as 'oni' | 'runner';
          p.ratio[k] = Math.min(RATIO_MAX, Math.max(1, p.ratio[k] + d));
          break;
        }
        case 'wish':
          p.wish = v as WishMode;
          break;
        case 'reveal':
          p.reveal = v as RevealMode;
          break;
        case 'mic':
          p.mic = v as MicMode;
          break;
        case 'lead': {
          const k = b.dataset.k as LeadRuleKey;
          p.lead[k] = !p.lead[k];
          break;
        }
        case 'chat-mode':
          p.chat.mode = v as ChatMode;
          break;
        case 'chat-jail':
          p.chat.jail = v as ChatJail;
          break;
        case 'area-kind':
          p[layer] = v === 'none' ? 'none' : v === 'keep' ? null : ptsOf(p, layer);
          break;
        case 'area-save':
          if (!drawing || drawing.id !== p.id || drawing.pts.length < AREA_MIN_PTS) return;
          p[drawing.layer] = drawing.pts;
          drawing = null;
          break;
        case 'area-ring':
          p.area = RING_PTS.map(([a, b]) => [a, b] as [number, number]);
          drawing = null;
          break;
        case 'area-take':
          if (!game?.[layer]) return;
          p[layer] = game[layer]!.pts.map(([a, b]) => [a, b] as [number, number]);
          drawing = null;
          break;
        case 'shrink-times':
          p.shrink.times = Math.min(SHRINK_MAX_TIMES, Math.max(0, p.shrink.times + d));
          break;
        case 'shrink-area':
          p.shrink.finalArea = Number(v);
          break;
        case 'shrink-to':
          p.shrink.to = v as ShrinkTo;
          break;
        case 'shrink-mission':
          p.shrink.mission = v === 'true';
          break;
        case 'all': {
          const keys = SECTION_KEYS[b.dataset.sec as Section];
          if (b.dataset.sec === 'area' && drawing) return;
          for (const x of next) {
            if (x === p) continue;
            for (const k of keys) (x as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(p[k]));
          }
          break;
        }
        case 'apply':
          if (sendTimer) {
            clearTimeout(sendTimer);
            sendTimer = null;
            send(presets);
          }
          apply(p.id);
          return;
        case 'from-game': {
          if (!game) return;
          p.round = { ...p.round, phases: game.durations.map((x) => Math.max(1, Math.round(x / 1000))) };
          if (game.ratio) p.ratio = { ...game.ratio };
          if (game.micMode) p.mic = game.micMode;
          if (game.wishMode) p.wish = game.wishMode;
          if (game.revealMode) p.reveal = game.revealMode;
          if (game.lead) p.lead = { ...game.lead };
          if (game.chat) p.chat = { mode: game.chat.mode, jail: game.chat.jail };
          if (game.shrinkPlan) p.shrink = { ...game.shrinkPlan, to: game.shrinkPlan.to === 'pick' ? 'mid' : game.shrinkPlan.to, pick: null };
          break;
        }
        case 'dup': {
          if (next.length >= PRESETS_MAX) return;
          const x = copy(p);
          x.id = newPresetId(next);
          x.name = `${p.name}のコピー`.slice(0, PRESET_NAME_MAX);
          next.splice(next.indexOf(p) + 1, 0, x);
          selected = x.id;
          break;
        }
        case 'del':
          if (next.length <= 1) return;
          next.splice(next.indexOf(p), 1);
          selected = null;
          break;
        default:
          return;
      }
    change(next);
  });
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('np-name')) return;
    const next = presets.map(copy);
    const p = next.find((x) => x.id === t.dataset.id);
    const name = t.value.trim().slice(0, PRESET_NAME_MAX);
    if (!p || !name) return render();
    p.name = name;
    change(next);
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t.classList.contains('np-name')) (t as HTMLInputElement).blur();
  });

  render();
  return {
    el,
    update(next, g) {
      let dirty = false;
      if (g?.stage !== game?.stage || g?.durations.join() !== game?.durations.join()) dirty = true;
      if (JSON.stringify([g?.area?.pts, g?.jail?.pts]) !== JSON.stringify([game?.area?.pts, game?.jail?.pts])) dirty = true;
      game = g;
      if (open === null) {
        open = false;
        dirty = true;
      }
      if (next && !sendTimer && Date.now() - localAt > HOLD_LOCAL_MS && JSON.stringify(next) !== JSON.stringify(presets)) {
        presets = next.map(copy);
        if (selected && !presets.some((p) => p.id === selected)) selected = null;
        dirty = true;
      }
      const typing = (document.activeElement as HTMLElement | null)?.closest?.('.pp input, .pp textarea');
      if (dirty && !typing) render();
    },
  };
}
