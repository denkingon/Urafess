import type { GlowEntry } from '../../shared/protocol';
import { RUN_STALE_MS } from '../../shared/rules';
import { bearingDeg, compassName, distanceM, distanceText, type LatLon } from '../../shared/run';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState } from '../core/game-client';
import type { Sensors } from '../sense';
import { sent, say, type Pair } from '../ui';
import { createRadar, type RadarLight } from './radar';

/**
 * 走ると光る（見た目の層）。参加者の画面の真ん中（時計と長押しの間）に出す。
 *
 * 配役〜追跡開始まで：「走ると光るをオンにする」（動きのセンサーと位置の許可）。押したあとは一言の説明だけ
 * ゲームの段階：光の地図と、光っている人の一覧（近い順）。自分が光っている間は「光っている」と大きく出す
 */

const TRAIL_MS = 8_000;
const NEW_MS = 2_500;
const VIBRATE_EVERY_MS = 4_000;
/** 地図を描き直す間隔の下限（毎フレームは描かない） */
const DRAW_EVERY_MS = 100;

export interface BoardInput {
  glow: ClientState['glow'];
  serverNow: number | null;
  me: LatLon | null;
  heading: number | null;
  /** 自分の番号（一覧と地図から外す。自分は真ん中） */
  myNum: number | null;
  meLit: boolean;
  /** 地図の真ん中に重ねる一言（位置が取れない理由など）。無ければ null */
  message?: Pair | null;
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

/** 光の地図＋一覧。主催者の画面でも使う。listMax＝一覧に出す人数（参加者は1人＝いちばん近い人と「ほか n人」） */
export function createLightsBoard(listMax = 1): LightsBoard {
  const el = document.createElement('div');
  el.className = 'glow-board';
  const radar = createRadar();
  const wrap = document.createElement('div');
  wrap.className = 'glow-radar';
  const msg = document.createElement('p');
  msg.className = 'glow-radar-msg';
  msg.hidden = true;
  wrap.append(radar.el, msg);
  const list = document.createElement('ul');
  list.className = 'glow-list';
  list.setAttribute('aria-live', 'polite');
  el.append(wrap, list);

  const trails = new Map<number, { lat: number; lon: number; at: number }[]>();
  const firstSeen = new Map<number, number>();
  let lastSeq = -1;
  let lastDraw = 0;
  let lastListKey = '';
  let lastVibrate = 0;

  return {
    el,
    update({ glow, serverNow, me, heading, myNum, meLit, message }) {
      const now = serverNow ?? Date.now();
      const all: GlowEntry[] = (glow?.runs ?? []).filter((r) => now - r.at <= RUN_STALE_MS);
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
      const pair: Pair | null = message ?? (me ? null : ['自分の位置を待っている…', 'Waiting for your location…']);
      const html = pair ? sent(pair) : '';
      if (msg.dataset.html !== html) {
        msg.dataset.html = html;
        msg.innerHTML = html;
      }
      if (msg.hidden !== !pair) msg.hidden = !pair;

      const lights: RadarLight[] = others.map((r) => {
        const pos = r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon } : null;
        const t = (trails.get(r.num) ?? []).filter((p) => now - p.at <= TRAIL_MS);
        return {
          num: r.num,
          name: r.name,
          pos,
          fresh: 1 - (now - r.at) / RUN_STALE_MS,
          trail: t.slice(0, -1).map((p) => ({ lat: p.lat, lon: p.lon })),
          isNew: now - (firstSeen.get(r.num) ?? 0) < NEW_MS,
        };
      });
      radar.update({ me, heading, lights, meLit });

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
        shown.map((x) => [x.r.num, x.r.name, x.d === null ? null : Math.round(x.d / 10), x.b === null ? null : Math.round((x.b - (heading ?? 0)) / 15)]),
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
          const where = document.createElement('em');
          where.textContent =
            d === null || b === null ? '場所なし · no location' : heading === null ? `${compassName(b)} ${COMPASS_EN[compassName(b)]} · ${distanceText(d)}` : distanceText(d);
          li.append(arrow, name, where);
          return li;
        });
        if (rows.length > listMax) {
          if (listMax === 1 && items[0]) {
            // 1人だけ出すときは、同じ行に「ほか n人」
            const more = document.createElement('span');
            more.textContent = `ほか${rows.length - 1}人 · +${rows.length - 1}`;
            items[0].append(more);
            items[0].classList.add('has-more');
          } else {
            const more = document.createElement('li');
            more.className = 'glow-more';
            more.textContent = `ほか ${rows.length - listMax}人 · ${rows.length - listMax} more`;
            items.push(more);
          }
        }
        if (rows.length === 0) {
          const none = document.createElement('li');
          none.className = 'glow-none';
          none.innerHTML = sent(['いま光っている人はいない', 'Nobody is glowing now']);
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
  /** 参加者の画面の外枠。光っている間 is-lit を付ける（役の札の横に「光っている」が出る） */
  root?: HTMLElement;
}

export interface GlowScreen {
  el: HTMLElement;
  update(view: PhoneView, state: ClientState, serverNow: number | null): void;
}

/** 許可・センサーの状態の一言（困っているときだけ。困っていなければ null） */
/** 方角の英語（8方位） */
const COMPASS_EN: Record<ReturnType<typeof compassName>, string> = { 北: 'N', 北東: 'NE', 東: 'E', 南東: 'SE', 南: 'S', 南西: 'SW', 西: 'W', 北西: 'NW' };

function senseProblem(s: Sensors): Pair | null {
  if (s.motion === 'denied' && s.geo === 'denied') return ['動きのセンサーも位置も許可されていない。このままでは走っても光らない。アプリを開き直して、もう一度「オンにする」を押す', 'Motion and location are both blocked, so running will not glow. Reopen the app and tap “turn on” again'];
  if (s.motion === 'denied') return ['動きのセンサーが許可されていない。走りは位置の速さで決める（遅れて光る）。アプリを開き直すと、もう一度聞ける', 'Motion is blocked. Running is judged from location speed (glows late). Reopen the app to be asked again'];
  if (s.geo === 'denied') return ['位置が許可されていない。光っても場所は出ず、地図の真ん中も決まらない。設定アプリで位置を許可する', 'Location is blocked: no place on the map. Allow location in Settings'];
  if (s.motion === 'unsupported' && s.geo !== 'ok') return ['このスマホは動きのセンサーが使えない。位置が取れるまで、走っても光らない', 'No motion sensor on this phone. Running glows only once location works'];
  if (s.geo === 'error') return ['位置が取れていない（建物の中・電波）。外に出ると取れる', 'No location yet (indoors or weak signal). Step outside'];
  if (s.geo === 'unsupported') return ['このスマホでは位置が使えない', 'Location is not available on this phone'];
  return null;
}

export function createGlow({ sensors, root }: GlowDeps): GlowScreen {
  const el = document.createElement('section');
  el.className = 'glow';
  el.innerHTML = `
    <button type="button" class="glow-ask" data-act="sense" hidden>
      <b>${say(['走ると光るをオンにする', 'TURN ON RUN-GLOW'])}</b>
      <span data-k="askSub"></span>
    </button>
    <p class="glow-note" data-k="note" hidden></p>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const ask = el.querySelector('.glow-ask') as HTMLButtonElement;
  const note = q('note');
  const litChip = root?.querySelector('[data-k="lit"]') as HTMLElement | null;
  const board = createLightsBoard();
  el.append(board.el);

  ask.addEventListener('click', () => {
    // このタップの中で許可を聞く（iPhone はタップの直後でないと聞けない）
    sensors.request();
  });
  // 毎フレーム呼ばれるので、変わったときだけ書き換える
  const setHtml = (e: HTMLElement, html: string) => {
    if (e.dataset.html !== html) {
      e.dataset.html = html;
      e.innerHTML = html;
    }
  };
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
      setHtml(
        q('askSub'),
        sent(
          watcher
            ? ['位置を使う。光った人の方角と距離が出る', "Uses location. Shows where glowing players are"]
            : ['動きと位置を使う。ゲームの間、走ると全員の画面に光る', 'Uses motion and location. Run during the game and you glow on every screen'],
        ),
      );
      const problem = senseProblem(sensors);
      if (view.glow === 'prep') {
        setHidden(note, !ask.hidden && !problem);
        const pair: Pair | null = problem ?? (ask.hidden ? ['ゲームが始まると、走っている人が全員の画面に光る。止まると消える', 'Once the game starts, anyone running glows on every screen. Stop and it fades'] : null);
        setHtml(note, pair ? sent(pair) : '');
      } else {
        // ゲームの段階は地図に高さを譲る：困りごとは地図の真ん中に重ねる（位置が取れないときだけ）
        setHidden(note, true);
      }

      setHidden(board.el, view.glow !== 'live');
      const lit = view.lightable && sensors.lit;
      const pos = sensors.position(now);
      const res = board.update({
        glow: state.glow,
        serverNow,
        me: pos ? { lat: pos.lat, lon: pos.lon } : null,
        heading: sensors.heading(now),
        myNum: state.me?.num ?? null,
        meLit: lit,
        message: pos ? null : sensors.geo === 'ok' || sensors.geo === 'asking' ? null : (problem ?? null),
      });
      // 光っている間は、役の札の横に「光っている」（全員の一覧に自分が入ったら「…」が取れる）
      const shown = view.glow === 'live' && lit;
      if (root && root.classList.contains('is-lit') !== shown) root.classList.toggle('is-lit', shown);
      if (litChip && shown) {
        const confirmed = !view.offline && res.meListed;
        setHtml(litChip, say(confirmed ? ['光っている', 'GLOWING'] : ['光っている…', 'GLOWING…']));
        litChip.title = confirmed ? (sensors.sendPos(now) ? '全員の画面に、名前と場所が出ている' : '全員の画面に、名前が出ている（場所は取れていない）') : '全員に届けている';
      }
    },
  };
}
