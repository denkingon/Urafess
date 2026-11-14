import { AREA_OUT_MARGIN_M, AreaWatch, checkArea, isFarOutside, JAIL_ARRIVE_M } from '../../shared/area';
import type { GlowEntry } from '../../shared/protocol';
import { MATES_STALE_MS, RUN_STALE_MS } from '../../shared/rules';
import { bearingDeg, compassName, compassNameEn, distanceM, distanceText, distanceTextEn, type LatLon } from '../../shared/run';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState } from '../core/game-client';
import type { Sensors } from '../sense';
import { UI, esc, say, sent, setHTML, type Pair } from '../ui';
import { createOverview, type OvKind, type OvPoint } from './overview';
import { createRadar, type RadarLight } from './radar';

/**
 * 走ると光る（見た目の層）。参加者の画面の真ん中（時計と長押しの間）に出す。
 *
 * 配役〜追跡開始まで：「走ると光るをオンにする」（動きのセンサーと位置の許可）。押したあとは「オン」の一言だけ
 * ゲームの段階：光の地図と、いちばん近い人の行。自分が光っている間は「光っている」と大きく出す
 * 参加者の画面は日本語と英語（ui.ts の言語に従う）。主催者の画面（createLightsBoard の既定）は日本語だけ
 */

const TRAIL_MS = 8_000;
const NEW_MS = 2_500;
const VIBRATE_EVERY_MS = 4_000;
/** 地図を描き直す間隔の下限（毎フレームは描かない） */
const DRAW_EVERY_MS = 100;
/** 光が消えるまでの長さ。走っていない司令塔の位置は5秒ごとにしか届かないので、全体の地図と同じ長さで見る */
const staleOf = (r: GlowEntry): number => (r.lead ? MATES_STALE_MS : RUN_STALE_MS);
const LEAD_WORD: Pair = ['司令塔', 'COMMANDER'];

export interface BoardInput {
  glow: ClientState['glow'];
  serverNow: number | null;
  me: LatLon | null;
  heading: number | null;
  /** 自分の番号（一覧と地図から外す。自分は真ん中） */
  myNum: number | null;
  meLit: boolean;
  /** 地図の真ん中に重ねる一言（位置が取れない理由など。日本語と英語）。無ければ null */
  message?: Pair | null;
  /** 全体の地図：見えてよい人（同じ役の仲間。主催者は全員） */
  mates?: ClientState['mates'];
  /** 自分の位置の誤差（m） */
  meAcc?: number | null;
  /** 自分の役（全体の地図の自分の印と、仲間の色に使う） */
  myKind?: OvKind;
  /** 遊ぶ範囲（全体の地図に線を引き、外を暗くする）。外にいる人は輪で囲む */
  area?: [number, number][] | null;
  /** 牢屋の場所（全体の地図に「牢屋」を出す） */
  jail?: [number, number][] | null;
  /** 自分が範囲の外にいる（見張りが決めた） */
  meOut?: boolean;
  /** 司令塔：全体の地図を見られない（司令塔だけが見られる札のとき、司令塔でない人）。光の地図だけになる */
  mapOff?: boolean;
}

export interface BoardOptions {
  /** 一覧に出す人数（参加者は1人＝いちばん近い人と「ほか n人」） */
  listMax?: number;
  /** 最初に出す地図：all＝全体の地図、near＝光の地図（自分が真ん中） */
  start?: 'all' | 'near';
  /** 全体の地図で名前を出す最大の人数 */
  labelMax?: number;
  /** 参加者の画面：英語も出す（ui.ts の言語に従う）。主催者の画面は日本語だけ */
  bilingual?: boolean;
}

export interface LightsBoard {
  el: HTMLElement;
  /** 返り値：いま光っている人（自分を除く）・自分がサーバーの一覧に入っているか（全員に届いているか） */
  update(input: BoardInput): { others: number; meListed: boolean; fresh: number[] };
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末
  }
}

/** 短い言葉を1行に並べる（日本語のあとに英語。同じなら1つ） */
function inline([ja, en]: Pair, lang: 'ja' | 'ja+en' | 'en'): string {
  if (lang === 'ja' || !en || ja === en) return `<span class="ja">${esc(lang === 'en' ? en || ja : ja)}</span>`;
  if (lang === 'en') return `<span class="en">${esc(en)}</span>`;
  return `<span class="ja">${esc(ja)}</span> <span class="en">${esc(en)}</span>`;
}

/**
 * 地図（全体の地図／光の地図を切りかえ）＋一覧。主催者の画面でも使う。
 * 全体の地図：北が上の SFC に、見えてよい仲間と光っている人。光の地図：自分が真ん中、光っている人だけ
 */
export function createLightsBoard(opts: BoardOptions = {}): LightsBoard {
  const listMax = opts.listMax ?? 1;
  const labelMax = opts.labelMax ?? 8;
  const bilingual = opts.bilingual ?? false;
  const lang = bilingual ? UI.lang : 'ja';
  let mode: 'all' | 'near' = opts.start ?? 'all';
  const el = document.createElement('div');
  el.className = 'glow-board';
  const tabs = document.createElement('div');
  tabs.className = 'glow-tabs';
  tabs.setAttribute('role', 'tablist');
  const tabAll = document.createElement('button');
  const tabNear = document.createElement('button');
  for (const [b, m, ja, en] of [
    [tabAll, 'all', '全体', 'MAP'],
    [tabNear, 'near', '近く', 'NEAR'],
  ] as const) {
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.mode = m;
    b.innerHTML = `<b>${ja}</b><span>${en}</span>`;
    b.addEventListener('click', () => {
      mode = m;
      lastDraw = 0;
      applyMode();
    });
    tabs.append(b);
  }
  const radar = createRadar({ north: lang === 'ja' ? '北' : lang === 'en' ? 'N' : '北 N' });
  const ov = createOverview();
  const wrap = document.createElement('div');
  wrap.className = 'glow-radar';
  const msg = document.createElement('p');
  msg.className = 'glow-radar-msg';
  msg.hidden = true;
  wrap.append(radar.el, ov.el, msg);
  const list = document.createElement('ul');
  list.className = 'glow-list';
  list.setAttribute('aria-live', 'polite');
  el.append(tabs, wrap, list);
  const applyMode = () => {
    el.dataset.mode = mode;
    tabAll.setAttribute('aria-selected', String(mode === 'all'));
    tabNear.setAttribute('aria-selected', String(mode === 'near'));
  };
  applyMode();

  const trails = new Map<number, { lat: number; lon: number; at: number }[]>();
  const firstSeen = new Map<number, number>();
  let lastSeq = -1;
  let lastDraw = 0;
  let lastListKey = '';
  let lastVibrate = 0;
  let wasMapOff: boolean | null = null;

  return {
    el,
    update({ glow, serverNow, me, heading, myNum, meLit, message, mates, meAcc, myKind, area, jail, meOut, mapOff }) {
      // 司令塔：全体の地図を見られない間は、光の地図だけ（切りかえも出さない）。見られるようになったら、全体の地図を開く
      const off = mapOff === true;
      if (off !== wasMapOff) {
        if (wasMapOff !== null || off) mode = off ? 'near' : 'all';
        wasMapOff = off;
        tabs.hidden = off;
        lastDraw = 0;
        applyMode();
      }
      const now = serverNow ?? Date.now();
      const all: GlowEntry[] = (glow?.runs ?? []).filter((r) => now - r.at <= staleOf(r));
      const meListed = myNum !== null && all.some((r) => r.num === myNum);
      const others = all.filter((r) => r.num !== myNum);

      // 届いたときだけ：道すじを伸ばし、新しく光った人を覚える
      if (glow && glow.seq !== lastSeq) {
        lastSeq = glow.seq;
        const live = new Set(others.map((r) => r.num));
        for (const r of others) {
          if (!firstSeen.has(r.num)) {
            firstSeen.set(r.num, now);
            // 新しく光った人がいる（自分が走っている間は震えない）
            if (!meLit && now - lastVibrate > VIBRATE_EVERY_MS) {
              lastVibrate = now;
              vibrate(30);
            }
          }
          if (r.lat !== null && r.lon !== null) {
            const t = trails.get(r.num) ?? [];
            const last = t[t.length - 1];
            if (!last || last.lat !== r.lat || last.lon !== r.lon) t.push({ lat: r.lat, lon: r.lon, at: r.at });
            trails.set(r.num, t.filter((p) => now - p.at <= TRAIL_MS));
          }
        }
        for (const num of [...firstSeen.keys()]) {
          if (!live.has(num)) {
            firstSeen.delete(num);
            trails.delete(num);
          }
        }
      }

      const fresh = others.map((r) => r.num);
      if (performance.now() - lastDraw < DRAW_EVERY_MS) return { others: others.length, meListed, fresh };
      lastDraw = performance.now();
      // 全体の地図は、自分の位置が無くても仲間は出るので「待っている」は出さない
      const text: Pair | null = message ?? (me || mode === 'all' ? null : ['自分の位置を待っている…', 'Waiting for your location…']);
      if (bilingual) setHTML(msg, text ? sent(text) : '');
      else if (msg.textContent !== (text?.[0] ?? '')) msg.textContent = text?.[0] ?? '';
      if (msg.hidden !== !text) msg.hidden = !text;

      const lights: RadarLight[] = others.map((r) => {
        const pos = r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon } : null;
        const t = (trails.get(r.num) ?? []).filter((p) => now - p.at <= TRAIL_MS);
        return {
          num: r.num,
          name: r.name,
          pos,
          fresh: 1 - (now - r.at) / staleOf(r),
          trail: t.slice(0, -1).map((p) => ({ lat: p.lat, lon: p.lon })),
          isNew: now - (firstSeen.get(r.num) ?? 0) < NEW_MS,
          lead: r.lead,
        };
      });
      if (mode === 'near') radar.update({ me, heading, lights, meLit });
      else {
        // 全体の地図：仲間（届いている位置）と、光っている人（仲間でなければ役は分からない）
        const kindOfMate = (role: 'oni' | 'runner' | undefined): OvKind => role ?? (mates?.scope === 'oni' || mates?.scope === 'runner' ? mates.scope : 'unknown');
        const litNums = new Set(others.map((r) => r.num));
        const points: OvPoint[] = [];
        const seen = new Set<number>();
        for (const m of mates?.people ?? []) {
          if (m.num === myNum) continue;
          const age = now - m.at;
          if (age > MATES_STALE_MS) continue;
          seen.add(m.num);
          // 光っていれば、光の位置（1秒ごと）のほうが新しい
          const run = others.find((r) => r.num === m.num && r.lat !== null && r.lon !== null);
          points.push({
            key: `m${m.num}`,
            name: m.name,
            pos: run ? { lat: run.lat!, lon: run.lon! } : { lat: m.lat, lon: m.lon },
            acc: run?.acc ?? m.acc,
            kind: kindOfMate(m.role),
            fresh: run ? 1 : 1 - age / MATES_STALE_MS,
            lit: litNums.has(m.num),
            lead: !!others.find((r) => r.num === m.num)?.lead,
          });
        }
        for (const r of others) {
          if (seen.has(r.num) || r.lat === null || r.lon === null) continue;
          // 司令塔はどちらの側か分かっている（役の色で出す）
          points.push({ key: `r${r.num}`, name: r.name, pos: { lat: r.lat, lon: r.lon }, acc: r.acc ?? 0, kind: r.lead ?? 'unknown', fresh: 1 - (now - r.at) / staleOf(r), lit: true, lead: !!r.lead });
        }
        // 範囲の外にいる人（届いた位置だけで見る。光っている相手は数えない）
        if (area) for (const p of points) if (p.kind !== 'unknown') p.out = isFarOutside(area, p.pos);
        ov.update({ me: me ? { ...me, acc: meAcc ?? 0 } : null, meKind: myKind ?? 'unknown', meLit, points, labelMax, area: area ?? null, jail: jail ?? null, meOut });
      }

      // 一覧：近い順（自分の位置が分からなければ、光った順）
      const rows = others.map((r) => {
        const pos = r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon } : null;
        const d = me && pos ? distanceM(me, pos) : null;
        const b = me && pos ? bearingDeg(me, pos) : null;
        return { r, d, b };
      });
      rows.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity) || a.r.since - b.r.since);
      const shown = rows.slice(0, listMax);
      const listKey = JSON.stringify([
        shown.map((x) => [x.r.num, x.r.name, x.r.lead ?? '', x.d === null ? null : Math.round(x.d / 10), x.b === null ? null : Math.round((x.b - (heading ?? 0)) / 15)]),
        rows.length,
        heading === null,
      ]);
      if (listKey !== lastListKey) {
        lastListKey = listKey;
        const items = shown.map(({ r, d, b }) => {
          const li = document.createElement('li');
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          arrow.setAttribute('viewBox', '-6 -6 12 12');
          arrow.setAttribute('class', 'glow-dir');
          arrow.setAttribute('aria-hidden', 'true');
          if (b !== null) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M0,-5 L3.6,3.8 L0,1.6 L-3.6,3.8 Z');
            path.setAttribute('transform', `rotate(${Math.round(b - (heading ?? 0))})`);
            arrow.append(path);
          }
          // 番号は出さない（人は名前で見分ける）
          const name = document.createElement('b');
          name.textContent = r.name;
          // 司令塔：地図と同じ四角い印を名前の前に（鬼は朱、逃走者は月白）。字は入れない（行が狭い）
          let tag: HTMLElement | null = null;
          if (r.lead) {
            tag = document.createElement('i');
            tag.className = `glow-lead is-${r.lead}`;
            tag.setAttribute('role', 'img');
            tag.setAttribute('aria-label', LEAD_WORD[0]);
          }
          const where = document.createElement('em');
          // 方角（北が上の地図のときだけ）と距離。英語は日本語のすぐ後ろ、数字は1回だけ（北東 NE 60m）
          where.innerHTML =
            d === null || b === null
              ? inline(['場所は出ていない', 'NO LOCATION'], lang)
              : [heading === null ? inline([compassName(b), compassNameEn(b)], lang) : '', inline([distanceText(d), distanceTextEn(d)], lang)]
                  .filter(Boolean)
                  .join(' ');
          li.append(arrow, ...(tag ? [tag] : []), name, where);
          return li;
        });
        if (rows.length > listMax) {
          if (listMax === 1 && items[0]) {
            // 1人だけ出すときは、同じ行に「ほか n人」
            const more = document.createElement('span');
            more.className = 'glow-others';
            more.innerHTML = inline([`ほか${rows.length - 1}人`, `+${rows.length - 1}`], lang);
            items[0].append(more);
            items[0].classList.add('has-more');
          } else {
            const more = document.createElement('li');
            more.className = 'glow-more';
            more.innerHTML = inline([`ほか ${rows.length - listMax}人`, `+${rows.length - listMax}`], lang);
            items.push(more);
          }
        }
        if (rows.length === 0) {
          const none = document.createElement('li');
          none.className = 'glow-none';
          if (bilingual) none.innerHTML = sent(['いま光っている人はいない', 'No one is glowing']);
          else none.textContent = 'いま光っている人はいない。';
          items.push(none);
        }
        list.replaceChildren(...items);
      }
      return { others: others.length, meListed, fresh };
    },
  };
}

export interface GlowDeps {
  sensors: Sensors;
  /** 参加者の画面の外枠。光っている間 is-lit を付ける（ひとことの場所に「光っている」が出る） */
  root?: HTMLElement;
}

export interface GlowScreen {
  el: HTMLElement;
  update(view: PhoneView, state: ClientState, serverNow: number | null): void;
}

/** 許可・センサーの状態の一言（困っているときだけ。困っていなければ null） */
function senseProblem(s: Sensors): Pair | null {
  if (s.motion === 'denied' && s.geo === 'denied')
    return ['動きのセンサーも位置も許可されていない。このままでは走っても光らない。アプリを開き直して、もう一度「オンにする」を押す', 'Motion and location are blocked, so running will not make you glow. Reopen the app and turn it on again'];
  if (s.motion === 'denied')
    return ['動きのセンサーが許可されていない。走りは位置の速さで決める（遅れて光る）。アプリを開き直すと、もう一度聞ける', 'Motion is blocked, so running is judged by GPS speed (slower). Reopen the app to be asked again'];
  if (s.geo === 'denied')
    return ['位置が許可されていない。光っても場所は出ず、地図の真ん中も決まらない。設定アプリで位置を許可する', 'Location is blocked: your spot will not show and the map has no center. Allow location in Settings'];
  if (s.motion === 'unsupported' && s.geo !== 'ok')
    return ['このスマホは動きのセンサーが使えない。位置が取れるまで、走っても光らない', 'This phone has no motion sensor. Running will not glow until location works'];
  if (s.geo === 'error') return ['位置が取れていない（建物の中・電波）。外に出ると取れる', 'No location yet (indoors or weak signal). Go outside'];
  if (s.geo === 'unsupported') return ['このスマホでは位置が使えない', 'Location is not available on this phone'];
  return null;
}

/**
 * 司令塔の一言。tone：mine＝自分が司令塔、crew＝司令塔がいる、down＝自分の側の司令塔が落ちた（逃走者）、
 * up＝相手の司令塔を落とした（鬼）
 */
export function leadStrip(state: ClientState): { tone: 'mine' | 'crew' | 'down' | 'up'; head: Pair; body: Pair } | null {
  const l = state.me?.lead;
  const rules = state.game?.lead;
  const role = state.me?.role;
  if (!l || !rules?.on || !role) return null;
  const name = l.name ?? '';
  if (role === 'runner' && l.down) {
    const ja = [l.mine ? (l.map ? '牢屋から指示を出せ' : '地図は消えた') : '', rules.expose ? '鬼に全員の場所が見えている' : '', rules.restore ? (l.mine ? '助けを待て' : `${name} を牢屋から出せば戻る`) : ''].filter(Boolean);
    const en = [l.mine ? (l.map ? 'Call it from jail' : 'Your map is gone') : '', rules.expose ? 'Chasers see everyone' : '', rules.restore ? (l.mine ? 'Wait for a rescue' : `Free ${name} to undo it`) : ''].filter(Boolean);
    return { tone: 'down', head: l.mine ? [l.map ? '司令塔が落ちた' : '司令塔が落ちた。地図は消えた', l.map ? 'COMMANDER DOWN' : 'COMMANDER DOWN. MAP GONE'] : ['司令塔が捕まった', 'COMMANDER DOWN'], body: [ja.join('。'), en.join('. ')] };
  }
  if (role === 'oni' && l.down) {
    return {
      tone: 'up',
      head: ['司令塔を落とした', 'COMMANDER DOWN'],
      body: l.foes ? ['逃走者の全員が地図に出ている', 'Every runner is on your map'] : ['逃走者の司令塔は牢屋にいる', 'Their commander is in jail'],
    };
  }
  if (l.mine) {
    return {
      tone: 'mine',
      head: ['お前が司令塔', 'YOU ARE THE COMMANDER'],
      body: rules.seen ? ['仲間の地図はお前だけ。お前の場所は全員に見えている', 'Only you have the team map. Everyone can see you'] : ['仲間の地図はお前だけ', 'Only you have the team map'],
    };
  }
  if (!name) return null;
  return { tone: 'crew', head: [`司令塔 ${name}`, `COMMANDER ${name}`], body: ['地図は司令塔だけが見られる', 'Only the commander has the map'] };
}

export function createGlow({ sensors, root }: GlowDeps): GlowScreen {
  const el = document.createElement('section');
  el.className = 'glow';
  el.innerHTML = `
    <button type="button" class="glow-ask" data-act="sense" hidden>
      <b class="u-ask">${say(['走ると光るをオンにする', 'TURN ON RUN TO GLOW'])}</b>
      <span data-k="askSub"></span>
    </button>
    <p class="glow-note" data-k="note" hidden></p>
    <p class="lead-strip" data-k="lead" role="status" hidden></p>
    <div class="area-out" data-k="out" role="alert" hidden>
      <svg class="area-out-arrow" viewBox="-20 -20 40 40" aria-hidden="true"><path d="M0,-15 L11,6 L3,3 L3,15 L-3,15 L-3,3 L-11,6 Z"/></svg>
      <div class="area-out-text"><b data-k="outWord"></b><span data-k="outWhere"></span></div>
    </div>
    <div class="area-out jail-go" data-k="jailGo" role="status" hidden>
      <svg class="area-out-arrow" viewBox="-20 -20 40 40" aria-hidden="true"><path d="M0,-15 L11,6 L3,3 L3,15 L-3,15 L-3,3 L-11,6 Z"/></svg>
      <div class="area-out-text"><b data-k="jailWord"></b><span data-k="jailWhere"></span></div>
    </div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const ask = el.querySelector('.glow-ask') as HTMLButtonElement;
  const note = q('note');
  const litChip = root?.querySelector('[data-k="lit"]') as HTMLElement | null;
  const board = createLightsBoard({ listMax: 1, start: 'all', labelMax: 8, bilingual: true });
  el.append(board.el);
  const outBox = q('out');
  const outArrow = el.querySelector('.area-out-arrow') as SVGElement;
  const watch = new AreaWatch();
  const jailBox = q('jailGo');
  const jailArrow = jailBox.querySelector('.area-out-arrow') as SVGElement;
  let lastOutBuzz = 0;
  const leadBox = q('lead');
  let lastTone = '';

  ask.addEventListener('click', () => {
    // このタップの中で許可を聞く（iPhone はタップの直後でないと聞けない）
    sensors.request();
  });
  // 毎フレーム呼ばれるので、変わったときだけ書き換える（字は setHTML が同じ中身なら書き換えない）
  const setHidden = (e: HTMLElement, hidden: boolean) => {
    if (e.hidden !== hidden) e.hidden = hidden;
  };

  return {
    el,
    update(view, state, serverNow) {
      if (el.dataset.glow !== view.glow) el.dataset.glow = view.glow;
      setHidden(el, view.glow === 'none');
      if (view.glow === 'none') {
        root?.classList.remove('is-lit');
        return;
      }
      const now = Date.now();

      // 光らない人（見学・捕まった）にも地図は出るので、位置だけは使ってほしい
      const watcher = view.role === 'なし' || view.caught;
      setHidden(ask, !sensors.needsTap);
      setHTML(
        q('askSub'),
        sent(
          watcher
            ? ['位置を使う（光った人の方角と距離）', 'Uses location']
            : ['動きと位置を使う（ゲームの間、仲間の地図に自分が出る）', 'Uses motion and location (teammates see you on the map)'],
        ),
      );
      const problem = senseProblem(sensors);
      if (view.glow === 'prep') {
        // 押したあとは「オン」の一言だけ（言葉の量は少なく）。困っているときだけ理由を出す
        setHidden(note, !ask.hidden && !problem);
        note.classList.toggle('is-problem', !!problem);
        setHTML(note, problem ? sent(problem) : ask.hidden ? say(['走ると光る：オン', 'RUN TO GLOW: ON']) : '');
      } else {
        // ゲームの段階は地図に高さを譲る：困りごとは地図の真ん中に重ねる（位置が取れないときだけ）
        setHidden(note, true);
      }

      setHidden(board.el, view.glow !== 'live');
      const lit = view.lightable && sensors.lit;
      const pos = sensors.position(now);

      // 遊ぶ範囲の見張り：逃げ始めてからゲームの終わりまで（止めている間・見学は見ない）。外なら戻る向きと距離
      const area = state.game?.area?.pts ?? null;
      const bounded = view.role !== 'なし' && (view.step === 3 || view.step === 4) && !view.paused;
      // 牢屋の場所：捕まった人には、範囲の外の「戻れ」の代わりに牢屋への向きと距離（着いたら「牢屋に着いた」）
      const jail = state.game?.jail?.pts ?? null;
      const toJail = view.caught && !!jail && view.role !== 'なし';
      setHidden(jailBox, !toJail);
      if (toJail) {
        const c = pos ? checkArea(jail, { lat: pos.lat, lon: pos.lon }) : null;
        const arrived = !!c && (c.inside || c.edgeM <= JAIL_ARRIVE_M);
        jailBox.classList.toggle('is-arrived', arrived);
        jailArrow.style.display = !c || arrived ? 'none' : '';
        if (!c || !pos) {
          setHTML(q('jailWord'), say(['牢屋へ行く', 'GO TO JAIL']));
          setHTML(q('jailWhere'), say(['地図の「牢屋」へ。位置を待っている…', 'Follow the map. Waiting for your location…']));
        } else if (arrived) {
          setHTML(q('jailWord'), say(['牢屋に着いた', 'YOU ARE IN JAIL']));
          setHTML(q('jailWhere'), say(['ここで仲間の助けを待つ', 'Wait here for a teammate']));
        } else {
          const deg = bearingDeg(pos, c.nearest);
          const head = sensors.heading(now);
          jailArrow.style.transform = `rotate(${(head === null ? deg : deg - head).toFixed(0)}deg)`;
          setHTML(q('jailWord'), say(['牢屋へ行く', 'GO TO JAIL']));
          setHTML(q('jailWhere'), say([`${compassName(deg)} ${distanceText(c.edgeM)}`, `${compassNameEn(deg)} ${distanceTextEn(c.edgeM)}`]));
        }
      }
      const out = bounded && !toJail && watch.feed(area, pos ? { lat: pos.lat, lon: pos.lon } : null, now);
      if (!bounded || toJail) watch.reset();
      setHidden(outBox, !out);
      if (root && root.classList.contains('is-out') !== out) root.classList.toggle('is-out', out);
      if (out && pos && watch.last) {
        const to = watch.last.nearest;
        const deg = bearingDeg(pos, to);
        const head = sensors.heading(now);
        outArrow.style.transform = `rotate(${(head === null ? deg : deg - head).toFixed(0)}deg)`;
        const m = Math.max(watch.last.edgeM, AREA_OUT_MARGIN_M);
        setHTML(q('outWord'), say(['範囲の外。戻れ', 'OUT OF BOUNDS. GO BACK']));
        setHTML(q('outWhere'), say([`${compassName(deg)} ${distanceText(m)}`, `${compassNameEn(deg)} ${distanceTextEn(m)}`]));
        if (now - lastOutBuzz > VIBRATE_EVERY_MS) {
          lastOutBuzz = now;
          vibrate([300, 120, 300]);
        }
      }
      const res = board.update({
        glow: state.glow,
        serverNow,
        me: pos ? { lat: pos.lat, lon: pos.lon } : null,
        heading: sensors.heading(now),
        myNum: state.me?.num ?? null,
        meLit: lit,
        message: pos ? null : sensors.geo === 'ok' || sensors.geo === 'asking' ? null : problem,
        mates: state.mates,
        meAcc: pos?.acc ?? null,
        myKind: view.role === '鬼' ? 'oni' : view.role === '逃走者' ? 'runner' : 'unknown',
        area,
        jail,
        meOut: out,
        mapOff: !!state.me?.lead && !state.me.lead.map,
      });
      // 司令塔：自分の側のいま（誰が司令塔か・落ちたか）。配役が出てからゲームの終わりまで
      const strip = leadStrip(state);
      setHidden(leadBox, !strip);
      if (strip) {
        if (leadBox.dataset.tone !== strip.tone) leadBox.dataset.tone = strip.tone;
        // ゲームの段階は地図に高さを譲る：ふだんは1行だけ。落ちた・落としたときだけ中身も出す
        // 牢屋にいる司令塔の画面は牢屋の案内で埋まっているので、見出しだけ
        const compact = (view.glow === 'live' && (strip.tone === 'mine' || strip.tone === 'crew')) || (strip.tone === 'down' && view.caught);
        setHTML(leadBox, `<b>${inline(strip.head, UI.lang)}</b>${compact ? '' : `<span>${sent(strip.body)}</span>`}`);
        if (strip.tone !== lastTone) {
          // 落ちた・戻ったは震えて知らせる（最初に出たときは震えない）
          if (lastTone !== '') vibrate(strip.tone === 'down' ? [200, 80, 200, 80, 400] : 120);
          lastTone = strip.tone;
        }
      } else lastTone = '';
      // 光っている間は、ひとことの場所に「光っている」（全員の一覧に自分が入ったら「…」が取れる）
      const shown = view.glow === 'live' && lit;
      if (root && root.classList.contains('is-lit') !== shown) root.classList.toggle('is-lit', shown);
      if (litChip && shown) {
        const confirmed = !view.offline && res.meListed;
        setHTML(litChip, say(confirmed ? ['光っている', 'GLOWING'] : ['光っている…', 'GLOWING…']));
        litChip.title = confirmed ? (sensors.sendPos(now) ? '全員の画面に、名前と場所が出ている' : '全員の画面に、名前が出ている（場所は取れていない）') : '全員に届けている';
      }
    },
  };
}
