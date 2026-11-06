import { VIA_NAME } from '../../shared/capture';
import type { GameView, HostOp, HostSummary, Winner } from '../../shared/protocol';
import { DURATION_MAX_MS, DURATION_MIN_MS, PHASES, START_LEAD_MS } from '../../shared/rules';
import { isDone, positionAt } from '../../shared/schedule';
import { hostStatus } from '../../shared/viewmodel';
import { bigFontSize } from './phone';

/** 主催者画面の大きい数字・文字の上限（「逃走者の勝ち」など長いときは枠に収まるまで縮める） */
const HOST_BIG_MAX_PX = 56;
/** 「次に進む」の行き先（いまの段階の番号ごと）。ゲームの段階の名前は「残り時間」なので、ここでは「ゲーム」と書く */
const SKIP_TO = ['追跡開始まで', 'ゲーム', '広場に戻るまで', '結果発表'] as const;
const GAME_PHASE = PHASES.findIndex((p) => p.id === 'game');

/** 主催者の画面（キャンバスの「主催者」）。押せるボタンは今の段階で決まる */

export interface HostInput {
  game: GameView | null;
  host: HostSummary | null;
  serverNow: number;
  online: boolean;
  lastReject: { op: HostOp; reason: string } | null;
}

export interface HostActions {
  command(op: HostOp, extra?: { winner?: Winner; durations?: number[]; pid?: string; by?: string }): void;
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
  'not-found': 'その参加者は見つからない。',
};

export function createHost(actions: HostActions): HostScreen {
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
      <div><b data-k="dups"></b><span>同じ名前</span></div>
    </div>
    <p class="reject" data-k="reject" hidden></p>
    <div class="buttons">
      <button type="button" data-op="assign"></button>
      <button type="button" data-op="start">開始</button>
      <button type="button" data-op="pause">一時停止</button>
      <button type="button" data-op="resume">再開</button>
      <button type="button" data-op="skip" class="wide">次に進む</button>
      <button type="button" data-op="win-oni">鬼の勝ち</button>
      <button type="button" data-op="win-runner">逃走者の勝ち</button>
      <button type="button" data-op="reset" class="wide">リセット（配役済みに戻す）</button>
      <button type="button" data-op="clear" class="wide">部屋を空にする（全員を外す）</button>
    </div>
    <details class="durations">
      <summary>時間の設定</summary>
      <form>
        ${PHASES.map((p, i) => `<label>${p.label}<input type="number" min="1" max="3600" step="1" data-i="${i}" inputmode="numeric">秒</label>`).join('')}
        <button type="submit">時間を変える</button>
      </form>
    </details>
    <section class="cap-host" data-k="cap" hidden>
      <div class="cap-host-head"><b>捕獲</b><span data-k="capCount"></span></div>
      <p class="note">逃走者を押すと、手で「捕まった」にする・取り消す。黒＝捕まった、点線＝本人が選んでいる途中。</p>
      <div class="cap-host-grid" data-k="capRunners"></div>
      <p class="note" data-k="capOni"></p>
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
  btn('clear').addEventListener('click', () => {
    if (confirm('参加者を全員外して、配役前に戻す。スマホは入室画面に戻り、入り直しになる。よいか？')) actions.command('clear');
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

  return {
    el,
    update({ game, host, serverNow, online, lastReject }) {
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
      q('dups').textContent = host.dupNames.length ? `${host.dupNames.length}組` : 'なし';
      q('foot').textContent =
        `時間：${PHASES.map((p, i) => `${p.label} ${fmt(game.durations[i])}`).join(' → ')}` +
        (host.waiting ? `　／　次の配役を待っている人 ${host.waiting}人` : '');

      const reject = q('reject');
      reject.hidden = !lastReject;
      reject.textContent = lastReject ? REASONS[lastReject.reason] ?? lastReject.reason : '';

      const timer = game.timer;
      const done = game.stage === 'timer' && timer !== null && isDone(timer, serverNow);
      const canAssign = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result' || done;
      btn('assign').textContent =
        game.stage === 'assigned' ? '引き直し' : game.stage === 'result' || done ? '次のラウンド（配役）' : '配役';
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
      setEnabled(btn('reset'), game.stage === 'timer', false);
      setEnabled(btn('clear'), (game.stage !== 'timer' || done) && host.total > 0, false);
      const canResult = game.stage === 'result' || done;
      setEnabled(btn('win-oni'), canResult, canResult && !game.result);
      setEnabled(btn('win-runner'), canResult, canResult && !game.result);

      const canEditDurations = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result';
      inputs.forEach((input, i) => {
        input.disabled = !canEditDurations;
        if (!editingDurations) input.value = String(Math.round(game.durations[i] / 1000));
      });
      (form.querySelector('button') as HTMLButtonElement).disabled = !canEditDurations;

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
              b.dataset.label = `${r.name}（${r.num}番）`;
              b.textContent = r.caught
                ? `${r.num} ${r.name} ← ${r.byName ?? '手'}・${r.via ? VIA_NAME[r.via] : ''}`
                : `${r.num} ${r.name}`;
              return b;
            }),
          );
          q('capOni').textContent = cap.oni.length
            ? `鬼の捕まえた数：${cap.oni.map((o) => `${o.name} ${o.catches}`).join('　')}`
            : '';
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
              b.dataset.label = `${d.name}（${p.num}番）`;
              b.textContent = `${p.num}番を外す`;
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
