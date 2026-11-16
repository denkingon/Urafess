import type { GameView } from '../../shared/protocol';
import { CHAT_MODE_NAME, type ChatJail, type ChatMode } from '../../shared/chat';
import { LEAD_RULE_KEYS, type LeadRuleKey } from '../../shared/lead';
import { basePreset, cleanPreset, cleanPresets, GAME_MODES, newPresetId, PRESET_NAME_MAX, PRESETS_MAX, presetSummary, type GameMode, type Preset } from '../../shared/preset';
import { RATIO_MAX, type MicMode, type RevealMode, type WishMode } from '../../shared/rules';
import { SHRINK_FINAL_AREAS, SHRINK_MAX_TIMES, type ShrinkTo } from '../../shared/shrink';
import { ROUND_PARTS } from '../../shared/night';
import { partMinimum, partRows, setPart } from './night';
import { hqSelect, numberOptions, pickerRow, type OpenDuration, type PickerOption } from './hq-picker';

/**
 * ルールのプリセット（本部）。デッキ全部の組み合わせに名前を付けて、先に作っておく場所。
 *
 * - 並び：1行＝1プリセット（名前と要約）。押すと中身を開く
 * - 中身：遊び方・時間（配役・4段・結果発表）・鬼と逃走者・配役の決め方・出し方・マイク・司令塔・チャット・範囲の縮み
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
function btn(text: string, act: string, extra: Record<string, string> = {}, pressed?: boolean): HTMLButtonElement {
  const b = mk('button', '', text);
  b.type = 'button';
  b.dataset.act = act;
  for (const [k, v] of Object.entries(extra)) b.dataset[k] = v;
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  return b;
}
const copy = (p: Preset): Preset => JSON.parse(JSON.stringify(p)) as Preset;

/** 札のまとまり（「全部のプリセットへ」でそろえる単位） */
type Section = 'mode' | 'round' | 'ratio' | 'cast' | 'lead' | 'chat' | 'shrink';
const SECTION_KEYS: Record<Section, (keyof Preset)[]> = {
  mode: ['mode'],
  round: ['round'],
  ratio: ['ratio'],
  cast: ['wish', 'reveal', 'mic'],
  lead: ['lead'],
  chat: ['chat'],
  shrink: ['shrink'],
};
const LEAD_NAME: Record<LeadRuleKey, string> = {
  on: '司令塔のしくみ',
  seen: '司令塔は相手に見える',
  dark: '捕まったら地図が消える',
  expose: '捕まったら鬼に全員が見える',
  restore: '助ければ元に戻る',
};

export function createPresetPalette(send: (list: Preset[]) => void, apply: (id: string) => void, openDuration: OpenDuration): PresetPalette {
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
  const choice = (label: string, act: string, id: string, value: string, items: readonly PickerOption[], extra: Record<string, string> = {}) => {
    const select = hqSelect(label, items, value);
    Object.assign(select.dataset, extra, { act, id });
    return pickerRow(label, select);
  };
  const seg = <T extends string>(label: string, act: string, id: string, value: T, items: [T, string, boolean?][]) =>
    choice(label, act, id, value, items);
  const section = (title: string, key: Section, id: string, ...kids: HTMLElement[]) => {
    const box = mk('div', 'pp-sec');
    const h = mk('div', 'pp-sec-h');
    h.append(mk('h3', '', title));
    if (presets.length > 1) h.append(btn('全部のプリセットへ', 'all', { id, sec: key }));
    box.append(h, ...kids);
    return box;
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
      section('遊び方', 'mode', p.id, seg<GameMode>('モード', 'mode', p.id, p.mode, GAME_MODES.map((m) => [m.mode, m.ready ? m.name : `${m.name}（まだ）`, !m.ready]))),
    );
    if (GAME_MODES.some((m) => !m.ready)) ed.lastElementChild!.append(mk('p', 'np-hint', '増やし鬼・氷鬼の決まりはまだアプリに無い（いまはドロケイで動く）'));
    ed.append(section('時間', 'round', p.id, partRows(p.round, (button, index, seconds) => {
      openDuration(button, ROUND_PARTS[index], seconds, partMinimum(index), (value) => {
        const next = presets.map(copy);
        const preset = next.find((item) => item.id === p.id);
        if (!preset) return;
        setPart(preset.round, index, value);
        change(next);
      });
    })));
    ed.append(
      section(
        '鬼と逃走者',
        'ratio',
        p.id,
        choice('鬼の割合', 'ratio', p.id, String(p.ratio.oni), numberOptions(1, RATIO_MAX), { r: 'oni' }),
        choice('逃走者の割合', 'ratio', p.id, String(p.ratio.runner), numberOptions(1, RATIO_MAX), { r: 'runner' }),
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
    ed.append(
      section(
        '範囲の縮み',
        'shrink',
        p.id,
        choice('時間で縮む回数', 'shrink-times', p.id, String(p.shrink.times), numberOptions(0, SHRINK_MAX_TIMES, '回')),
        seg<string>('最後の広さ', 'shrink-area', p.id, String(p.shrink.finalArea), SHRINK_FINAL_AREAS.map((a) => [String(a), `${Math.round(a * 100)}%`])),
        seg<ShrinkTo>('縮む先', 'shrink-to', p.id, p.shrink.to, [['mid', '真ん中'], ['random', '毎回どこか']]),
        seg<string>('ミッション成功で縮む', 'shrink-mission', p.id, String(p.shrink.mission), [['true', '入'], ['false', '切']]),
      ),
    );
    const ops = mk('div', 'np-ops');
    const put = btn('デッキへ入れる', 'apply', { id: p.id });
    put.disabled = !canDeck() || !game;
    const action = hqSelect('選択中のプリセットの操作', [
      ['', 'その他の操作', true], ['from-game', 'いまのデッキを取り込む', !game],
      ['dup', '複製', presets.length >= PRESETS_MAX], ['del', '削除', presets.length <= 1],
    ], '');
    action.dataset.act = 'preset-action';
    action.dataset.id = p.id;
    ops.append(put, action);
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
    if (open) {
      const li = mk('li', 'np-row pp-row');
      const select = hqSelect('編集するプリセット', [['', '選ぶ', true], ...presets.map((p) => [p.id, p.name] as const)], selected ?? '');
      select.dataset.act = 'pick';
      select.disabled = presets.length === 0;
      li.append(pickerRow('編集するプリセット', select));
      const current = presets.find((p) => p.id === selected);
      if (current) li.append(mk('p', 'np-note', presetSummary(current)), editor(current));
      list.append(li);
    }
    foot.replaceChildren();
    const action = hqSelect('プリセットの操作', [
      ['', '操作を選ぶ', true], ['new', '新しいプリセット', presets.length >= PRESETS_MAX],
      ['io-out', 'テキストで書き出す'], ['io-in', 'テキストから取り込む'],
    ], '');
    action.dataset.act = 'list-action';
    foot.append(action);
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
  const actOn = (b: HTMLButtonElement | HTMLSelectElement) => {
    if (b.disabled) return;
    const act = ['list-action', 'preset-action'].includes(b.dataset.act ?? '') ? b.value : b.dataset.act;
    const id = b.dataset.id;
    const v = b.value;
    const next = presets.map(copy);
    const p = next.find((x) => x.id === id);
    switch (act) {
      case 'toggle':
        open = !open;
        return render();
      case 'pick':
        selected = b.value || null;
        open = true;
        return render();
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
        case 'ratio': {
          const k = b.dataset.r as 'oni' | 'runner';
          p.ratio[k] = Number(v);
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
        case 'shrink-times':
          p.shrink.times = Number(v);
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
  };
  el.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (button) actOn(button);
  });
  el.addEventListener('change', (event) => {
    const t = event.target;
    if (t instanceof HTMLSelectElement) return actOn(t);
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('np-name')) return;
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
      const typing = (document.activeElement as HTMLElement | null)?.closest?.('.pp input, .pp select, .pp textarea');
      if (dirty && !typing) render();
    },
  };
}
