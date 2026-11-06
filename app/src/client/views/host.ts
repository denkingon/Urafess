import { VIA_NAME } from '../../shared/capture';
import type { GameView, HostOp, HostSummary, Winner } from '../../shared/protocol';
import { allocateCounts } from '../../shared/allocate';
import {
  DEFAULT_RATIO,
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  isValidRatio,
  PHASES,
  RATIO_MAX,
  RATIO_MIN,
  ROLES,
  RUN_STALE_MS,
  START_LEAD_MS,
} from '../../shared/rules';
import { isDone, positionAt } from '../../shared/schedule';
import { glowPhase, hostStatus } from '../../shared/viewmodel';
import type { ClientState } from '../core/game-client';
import type { Sensors } from '../sense';
import { createLightsBoard } from './glow';
import { bigFontSize } from './phone';

/** 主催者画面の大きい数字・文字の上限（「逃走者の勝ち」など長いときは枠に収まるまで縮める） */
const HOST_BIG_MAX_PX = 56;
/** 「次に進む」の行き先（いまの段階の番号ごと）。ゲームの段階の名前は「残り時間」なので、ここでは「ゲーム」と書く */
const SKIP_TO = ['追跡開始まで', 'ゲーム', '広場に戻るまで', '結果発表'] as const;
const GAME_PHASE = PHASES.findIndex((p) => p.id === 'game');
/** 待合室でこれより前に始めた夜のままなら、「新しい夜を始める」を促す */
const OLD_NIGHT_MS = 12 * 3_600_000;

/** 主催者の画面（キャンバスの「主催者」）。押せるボタンは今の段階で決まる */

export interface HostInput {
  game: GameView | null;
  host: HostSummary | null;
  serverNow: number;
  online: boolean;
  lastReject: { op: HostOp; reason: string } | null;
  /** 走ると光る：いま光っている全員 */
  glow?: ClientState['glow'];
}

export interface HostActions {
  command(
    op: HostOp,
    extra?: { winner?: Winner; durations?: number[]; ratio?: { oni: number; runner: number }; pid?: string; by?: string; rid?: string; ok?: boolean },
  ): void;
  /** 1イベント＝1行の記録を CSV で保存する */
  downloadLog(): Promise<void>;
}

export interface HostScreen {
  el: HTMLElement;
  update(input: HostInput): void;
}

const REASONS: Record<string, string> = {
  stale: '別の主催者画面が先に操作した。今の状態に更新したので、もう一度確かめて押す。',
  'not-allowed': '今の段階ではできない操作。',
  'no-participants': 'まだ誰も入室していない。',
  'bad-input': '入力が正しくない。',
  'not-found': 'その人は見つからない（もう待っていない・つながっていない）。',
};

export function createHost(actions: HostActions, sensors?: Sensors): HostScreen {
  const el = document.createElement('main');
  el.className = 'phone host';
  el.innerHTML = `
    <div class="host-head"><span class="host-title">主催者</span><span data-k="round"></span></div>
    <section class="status">
      <span data-k="title"></span>
      <span class="status-big" data-k="big"></span>
      <span data-k="next"></span>
    </section>
    <div class="stats">
      <div><b data-k="total"></b><span>参加</span></div>
      <div><b data-k="oni"></b><span>鬼</span></div>
      <div><b data-k="runner"></b><span>逃走者</span></div>
      <div><b data-k="received"></b><span>役の受け取り</span></div>
      <div><b data-k="synced"></b><span>時計が合っている</span></div>
      <div><b data-k="asks"></b><span>戻りたい人</span></div>
    </div>
    <p class="reject" data-k="reject" hidden></p>
    <p class="note" data-k="old" hidden></p>
    <section class="asks" data-k="asklist" hidden></section>
    <div class="buttons">
      <button type="button" data-op="assign"></button>
      <button type="button" data-op="start">開始</button>
      <button type="button" data-op="pause">一時停止</button>
      <button type="button" data-op="resume">再開</button>
      <button type="button" data-op="skip" class="wide">次に進む</button>
      <button type="button" data-op="win-oni">鬼の勝ち</button>
      <button type="button" data-op="win-runner">逃走者の勝ち</button>
      <button type="button" data-op="reset" class="wide">リセット（配役済みに戻す）</button>
      <button type="button" data-op="end" class="wide">夜を終える（全員の画面を SEE YOU AGAIN に）</button>
      <button type="button" data-op="clear" class="wide">新しい夜を始める（名簿は残す）</button>
    </div>
    <details class="durations">
      <summary>時間の設定</summary>
      <form>
        ${PHASES.map((p, i) => `<label>${p.label}<input type="number" min="1" max="3600" step="1" data-i="${i}" inputmode="numeric">秒</label>`).join('')}
        <button type="submit">時間を変える</button>
      </form>
    </details>
    <details class="ratio">
      <summary>鬼と逃走者の割合</summary>
      <form>
        <label>鬼<input type="number" min="${RATIO_MIN}" max="${RATIO_MAX}" step="1" data-r="oni" inputmode="numeric"></label>
        <label>逃走者<input type="number" min="${RATIO_MIN}" max="${RATIO_MAX}" step="1" data-r="runner" inputmode="numeric"></label>
        <p class="note" data-k="ratioPreview"></p>
        <button type="submit">割合を変える</button>
      </form>
    </details>
    <section class="cap-host" data-k="cap" hidden>
      <div class="cap-host-head"><b>捕獲</b><span data-k="capCount"></span></div>
      <p class="note">逃走者を押すと、手で「捕まった」にする・取り消す。黒＝捕まった、点線＝本人が選んでいる途中。</p>
      <div class="cap-host-grid" data-k="capRunners"></div>
      <p class="note" data-k="capOni"></p>
    </section>
    <section class="cap-host glow-host" data-k="glow" hidden>
      <div class="cap-host-head"><b>走ると光る</b><span data-k="glowCount"></span></div>
      <p class="note" data-k="glowReady"></p>
      <button type="button" class="ghost" data-act="glow-map" hidden>地図の真ん中をこの画面の場所にする（位置を使う）</button>
      <div data-k="glowBoard"></div>
    </section>
    <div class="dups" data-k="duplist"></div>
    <div class="spacer"></div>
    <button type="button" class="wide" data-op="csv">記録をCSVで保存（誰が・誰を・何分に）</button>
    <p class="note" data-k="foot"></p>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const btn = (op: string) => el.querySelector(`[data-op="${op}"]`) as HTMLButtonElement;
  const inputs = [...el.querySelectorAll('.durations input')] as HTMLInputElement[];
  const form = el.querySelector('.durations form') as HTMLFormElement;
  let editingDurations = false;
  const ratioInputs = [...el.querySelectorAll('.ratio input')] as HTMLInputElement[];
  const ratioForm = el.querySelector('.ratio form') as HTMLFormElement;
  let editingRatio = false;
  let totalNow = 0;
  const readRatio = () => ({
    oni: Number(ratioInputs.find((i) => i.dataset.r === 'oni')!.value),
    runner: Number(ratioInputs.find((i) => i.dataset.r === 'runner')!.value),
  });
  // いまの入室人数でこの割合だと、何人ずつになるか
  const showPreview = () => {
    const r = readRatio();
    q('ratioPreview').textContent = isValidRatio(r)
      ? totalNow > 0
        ? `いま${totalNow}人なら 鬼 ${allocateCounts(totalNow, ROLES.map((x) => ({ ...x, weight: r[x.id] })))[0]}人・逃走者 ${allocateCounts(totalNow, ROLES.map((x) => ({ ...x, weight: r[x.id] })))[1]}人。次の配役（引き直しも）から効く`
        : '次の配役（引き直しも）から効く'
      : `${RATIO_MIN}〜${RATIO_MAX}の整数で入れる`;
  };
  ratioInputs.forEach((i) => {
    i.addEventListener('focus', () => (editingRatio = true));
    i.addEventListener('input', showPreview);
  });
  ratioForm.addEventListener('submit', (e) => {
    e.preventDefault();
    editingRatio = false;
    const ratio = readRatio();
    if (isValidRatio(ratio)) actions.command('ratio', { ratio });
  });

  btn('csv').addEventListener('click', () => {
    const b = btn('csv');
    b.disabled = true;
    void actions
      .downloadLog()
      .catch(() => alert('記録を取り出せなかった。通信を確かめてもう一度押す。'))
      .finally(() => (b.disabled = false));
  });
  q('capRunners').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t?.dataset.pid) return;
    const label = t.dataset.label ?? '';
    if (t.dataset.state === 'caught') {
      if (confirm(`${label} の捕獲を取り消す。よいか？`)) actions.command('release', { pid: t.dataset.pid });
    } else if (confirm(`${label} を、手で「捕まった」にする（鬼は空欄）。よいか？`)) {
      actions.command('capture', { pid: t.dataset.pid });
    }
  });
  btn('assign').addEventListener('click', () => actions.command('assign'));
  btn('start').addEventListener('click', () => actions.command('start'));
  btn('pause').addEventListener('click', () => actions.command('pause'));
  btn('resume').addEventListener('click', () => actions.command('resume'));
  // 次に進む：ゲームの段階を縮めるときだけ確かめる（ほかの段階は待ち時間なので、そのまま進める）
  let skipConfirm: string | null = null;
  btn('skip').addEventListener('click', () => {
    if (skipConfirm && !confirm(skipConfirm)) return;
    actions.command('skip');
  });
  btn('win-oni').addEventListener('click', () => actions.command('result', { winner: 'oni' }));
  btn('win-runner').addEventListener('click', () => actions.command('result', { winner: 'runner' }));
  btn('reset').addEventListener('click', () => {
    if (confirm('タイマーを止めて、配役済みに戻す。役はそのまま。よいか？')) actions.command('reset');
  });
  btn('end').addEventListener('click', () => {
    if (confirm('夜を終える。全員の画面が SEE YOU AGAIN になる。配役で再開もできる。よいか？')) actions.command('end');
  });
  btn('clear').addEventListener('click', () => {
    if (confirm('今夜の参加者を全員外して、新しい夜にする（配役前に戻る）。名簿は残るので、スマホには名前のボタンが出て、押せば入れる。よいか？')) {
      actions.command('clear');
    }
  });
  q('asklist').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.rid) return;
    const ok = b.dataset.ok === '1';
    if (ok && b.dataset.here === '1' && !confirm(`${b.dataset.name} はいまも別のスマホでつながっている。それでもつなぐか？`)) return;
    actions.command('link', { rid: b.dataset.rid, ok });
  });
  inputs.forEach((i) => i.addEventListener('focus', () => (editingDurations = true)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    editingDurations = false;
    const durations = inputs.map((i) => Math.round(Number(i.value) * 1000));
    if (durations.every((d) => Number.isInteger(d) && d >= DURATION_MIN_MS && d <= DURATION_MAX_MS)) {
      actions.command('durations', { durations });
    }
  });
  q('duplist').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const pid = target.dataset.pid;
    if (pid && confirm(`${target.dataset.label} を参加者から外す。よいか？`)) actions.command('remove', { pid });
  });

  let lastDupKey = '';
  let lastCapKey = '';
  let lastAskKey = '';
  // 走ると光る：主催者の画面にも光の地図（真ん中はこの画面の場所。たいてい広場）
  const board = createLightsBoard(6);
  q('glowBoard').append(board.el);
  const glowMap = el.querySelector('[data-act="glow-map"]') as HTMLButtonElement;
  glowMap.addEventListener('click', () => sensors?.request());

  return {
    el,
    update(input) {
      const { game, host, serverNow, online, lastReject } = input;
      if (!game || !host) return;
      const s = hostStatus(game, serverNow);
      q('round').textContent = `ラウンド ${Math.max(game.round, 1)}${online ? '' : '・切断中'}`;
      q('title').textContent = s.title;
      const big = q('big');
      big.textContent = s.big;
      big.style.fontSize = `${Math.min(HOST_BIG_MAX_PX, bigFontSize(s.big, big.clientWidth || 290))}px`;
      q('next').textContent = s.next;
      q('total').textContent = String(host.total);
      const assigned = game.stage !== 'lobby';
      q('oni').textContent = assigned ? String(game.counts.oni) : '—';
      q('runner').textContent = assigned ? String(game.counts.runner) : '—';
      q('received').textContent = assigned ? `${host.received}/${host.assigned}` : '—';
      q('synced').textContent = `${host.synced}/${host.connected}`;
      const asks = host.reclaims ?? [];
      q('asks').textContent = asks.length ? `${asks.length}人` : 'なし';
      q('foot').textContent =
        `時間：${PHASES.map((p, i) => `${p.label} ${fmt(game.durations[i])}`).join(' → ')}` +
        `　／　割合 鬼${(game.ratio ?? DEFAULT_RATIO).oni}：逃走者${(game.ratio ?? DEFAULT_RATIO).runner}` +
        (host.waiting ? `　／　次の配役を待っている人 ${host.waiting}人` : '') +
        (host.registry !== undefined ? `　／　名簿 ${host.registry}人` : '');
      // 前の夜のまま集め始めないように：待合室で、夜を始めてから半日以上たっていたら知らせる
      const old = q('old');
      const age = game.nightAt !== undefined ? serverNow - game.nightAt : 0;
      old.hidden = !(game.stage === 'lobby' && age > OLD_NIGHT_MS);
      old.textContent = old.hidden ? '' : `この夜は${fmtAge(age)}前に始めたまま。今夜集めるなら、先に「新しい夜を始める」を押す。`;

      const askKey = JSON.stringify(asks);
      if (askKey !== lastAskKey) {
        lastAskKey = askKey;
        const list = q('asklist');
        list.hidden = asks.length === 0;
        list.replaceChildren(
          ...asks.map((a) => {
            const row = document.createElement('div');
            row.className = 'ask-row';
            const label = document.createElement('span');
            label.textContent = a.here ? `「${a.name}」に戻りたい人（${a.name}はいまも別のスマホでつながっている）` : `「${a.name}」に戻りたい人`;
            const yes = document.createElement('button');
            yes.type = 'button';
            yes.className = 'primary';
            yes.textContent = 'つなぐ';
            const no = document.createElement('button');
            no.type = 'button';
            no.textContent = '断る';
            for (const [b, ok] of [[yes, '1'], [no, '0']] as const) {
              b.dataset.rid = a.rid;
              b.dataset.ok = ok;
              b.dataset.name = a.name;
              b.dataset.here = a.here ? '1' : '0';
            }
            row.append(label, yes, no);
            return row;
          }),
        );
      }

      const reject = q('reject');
      reject.hidden = !lastReject;
      reject.textContent = lastReject ? REASONS[lastReject.reason] ?? lastReject.reason : '';

      const timer = game.timer;
      const done = game.stage === 'timer' && timer !== null && isDone(timer, serverNow);
      const canAssign = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result' || game.stage === 'ended' || done;
      btn('assign').textContent =
        game.stage === 'assigned'
          ? '引き直し'
          : game.stage === 'ended'
            ? '再開（次のラウンドの配役）'
            : game.stage === 'result' || done
              ? '次のラウンド（配役）'
              : '配役';
      setEnabled(btn('assign'), canAssign && host.total > 0, game.stage === 'lobby' || game.stage === 'result' || done);
      setEnabled(btn('start'), game.stage === 'assigned', game.stage === 'assigned');
      const running = game.stage === 'timer' && timer?.status === 'running' && !done;
      setEnabled(btn('pause'), running, running);
      const paused = game.stage === 'timer' && timer?.status === 'paused';
      setEnabled(btn('resume'), paused, paused);
      // 次に進む：いまの段階を2秒後に終わらせる。行き先をボタンに書く。あと2秒ほどで終わるときは押せない
      const pos = running && timer ? positionAt(timer, serverNow) : null;
      const phaseNow = pos && pos.kind === 'phase' ? pos : null;
      const goTo = phaseNow ? (SKIP_TO[phaseNow.index] ?? '結果発表') : null;
      btn('skip').textContent = goTo ? `次に進む → ${goTo}` : '次に進む';
      skipConfirm = phaseNow && phaseNow.index === GAME_PHASE ? `ゲームを終えて「${goTo}」へ進む。よいか？` : null;
      setEnabled(btn('skip'), !!phaseNow && phaseNow.remainingMs > START_LEAD_MS + 500, false);
      setEnabled(btn('end'), game.stage !== 'ended' && (game.stage !== 'timer' || done), game.stage === 'result');
      setEnabled(btn('reset'), game.stage === 'timer', false);
      // 新しい夜は、誰もいなくても始められる（前の夜のままなら目立たせる）
      setEnabled(btn('clear'), game.stage !== 'timer' || done, !old.hidden);
      const canResult = game.stage === 'result' || done;
      setEnabled(btn('win-oni'), canResult, canResult && !game.result);
      setEnabled(btn('win-runner'), canResult, canResult && !game.result);

      const canEditDurations = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result';
      inputs.forEach((input, i) => {
        input.disabled = !canEditDurations;
        if (!editingDurations) input.value = String(Math.round(game.durations[i] / 1000));
      });
      (form.querySelector('button') as HTMLButtonElement).disabled = !canEditDurations;

      const canEditRatio = canEditDurations;
      const ratio = game.ratio ?? DEFAULT_RATIO;
      totalNow = host.total;
      ratioInputs.forEach((input) => {
        input.disabled = !canEditRatio;
        if (!editingRatio) input.value = String(ratio[input.dataset.r as 'oni' | 'runner']);
      });
      (ratioForm.querySelector('button') as HTMLButtonElement).disabled = !canEditRatio;
      if (!editingRatio) showPreview();

      const cap = host.capture;
      q('cap').hidden = !cap || !(game.stage === 'timer' || game.stage === 'result');
      if (cap) {
        const caught = cap.runners.filter((r) => r.caught).length;
        q('capCount').textContent = `捕まった ${caught}/${cap.runners.length}人`;
        const capKey = JSON.stringify(cap);
        if (capKey !== lastCapKey) {
          lastCapKey = capKey;
          q('capRunners').replaceChildren(
            ...cap.runners.map((r) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.dataset.pid = r.pid;
              b.dataset.state = r.caught ? 'caught' : r.open ? 'open' : 'free';
              b.dataset.label = r.name;
              b.textContent = r.caught ? `${r.name} ← ${r.byName ?? '手'}・${r.via ? VIA_NAME[r.via] : ''}` : r.name;
              return b;
            }),
          );
          q('capOni').textContent = cap.oni.length
            ? `鬼の捕まえた数：${cap.oni.map((o) => `${o.name} ${o.catches}`).join('　')}`
            : '';
        }
      }

      // 走ると光る：配役〜ゲームの終わりは、センサーの使える人の数。ゲームの段階は光っている人と地図
      const gp = glowPhase(game, serverNow);
      sensors?.setActive(gp !== 'none');
      q('glow').hidden = gp === 'none';
      if (gp !== 'none') {
        const g = host.glow;
        // 光っている人の数は、届いている光の一覧から（集計は 0.5 秒ごとなので遅れる）
        const litNow = (input.glow?.runs ?? []).filter((r) => serverNow - r.at <= RUN_STALE_MS).length;
        q('glowCount').textContent = gp === 'live' ? `光っている ${litNow}人` : 'ゲームの段階で光る';
        q('glowReady').textContent = g
          ? `いまつながっている配役の人 ${g.total}人のうち、動きのセンサーが使える ${g.motion}人・位置が使える ${g.geo}人。` +
            (g.total > 0 && (g.motion < g.total || g.geo < g.total) ? '足りない人は、画面の「走ると光るをオンにする」を押す。' : '')
          : '';
        glowMap.hidden = !sensors || !sensors.needsTap;
        board.el.hidden = gp !== 'live';
        if (gp === 'live') {
          const now = Date.now();
          const pos = sensors?.position(now) ?? null;
          board.update({
            glow: input.glow ?? null,
            serverNow,
            me: pos ? { lat: pos.lat, lon: pos.lon } : null,
            heading: sensors?.heading(now) ?? null,
            myNum: null,
            meLit: false,
          });
        }
      }

      const dupKey = JSON.stringify(host.dupNames);
      if (dupKey !== lastDupKey) {
        lastDupKey = dupKey;
        const list = q('duplist');
        list.replaceChildren(
          ...host.dupNames.map((d) => {
            const row = document.createElement('div');
            row.className = 'dup-row';
            const label = document.createElement('span');
            label.textContent = `同じ名前「${d.name}」`;
            row.append(label);
            for (const p of d.people) {
              const b = document.createElement('button');
              b.type = 'button';
              b.dataset.pid = p.pid;
              const at = clock(p.joinedAt);
              b.dataset.label = `${d.name}（${at}に入った人）`;
              b.textContent = `${at}に入った人を外す`;
              row.append(b);
            }
            return row;
          }),
        );
      }
    },
  };
}

function setEnabled(button: HTMLButtonElement, enabled: boolean, primary: boolean): void {
  button.disabled = !enabled;
  button.classList.toggle('primary', enabled && primary);
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 && s >= 60 ? `${s / 60}分` : `${s}秒`;
}

/** 夜を始めてからの長さ（「半日」「3日」など、ざっくり） */
function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 24) return `${Math.round(h)}時間`;
  return `${Math.round(h / 24)}日`;
}

/** 入った時刻（同じ名前の人を見分けるため） */
function clock(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
