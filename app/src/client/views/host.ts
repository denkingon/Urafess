import type { GameView, HostOp, HostSummary, Winner } from '../../shared/protocol';
import { DURATION_MAX_MS, DURATION_MIN_MS, PHASES } from '../../shared/rules';
import { isDone } from '../../shared/schedule';
import { hostStatus } from '../../shared/viewmodel';

/** 主催者の画面（キャンバスの「主催者」）。押せるボタンは今の段階で決まる */

export interface HostInput {
  game: GameView | null;
  host: HostSummary | null;
  serverNow: number;
  online: boolean;
  lastReject: { op: HostOp; reason: string } | null;
}

export interface HostActions {
  command(op: HostOp, extra?: { winner?: Winner; durations?: number[]; pid?: string }): void;
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
      <button type="button" data-op="win-oni">鬼の勝ち</button>
      <button type="button" data-op="win-runner">逃走者の勝ち</button>
      <button type="button" data-op="reset" class="wide">リセット（配役済みに戻す）</button>
    </div>
    <details class="durations">
      <summary>時間の設定</summary>
      <form>
        ${PHASES.map((p, i) => `<label>${p.label}<input type="number" min="1" max="3600" step="1" data-i="${i}" inputmode="numeric">秒</label>`).join('')}
        <button type="submit">時間を変える</button>
      </form>
    </details>
    <div class="dups" data-k="duplist"></div>
    <div class="spacer"></div>
    <p class="note" data-k="foot"></p>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const btn = (op: string) => el.querySelector(`[data-op="${op}"]`) as HTMLButtonElement;
  const inputs = [...el.querySelectorAll('.durations input')] as HTMLInputElement[];
  const form = el.querySelector('.durations form') as HTMLFormElement;
  let editingDurations = false;

  btn('assign').addEventListener('click', () => actions.command('assign'));
  btn('start').addEventListener('click', () => actions.command('start'));
  btn('pause').addEventListener('click', () => actions.command('pause'));
  btn('resume').addEventListener('click', () => actions.command('resume'));
  btn('win-oni').addEventListener('click', () => actions.command('result', { winner: 'oni' }));
  btn('win-runner').addEventListener('click', () => actions.command('result', { winner: 'runner' }));
  btn('reset').addEventListener('click', () => {
    if (confirm('タイマーを止めて、配役済みに戻す。役はそのまま。よいか？')) actions.command('reset');
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

  return {
    el,
    update({ game, host, serverNow, online, lastReject }) {
      if (!game || !host) return;
      const s = hostStatus(game, serverNow);
      q('round').textContent = `ラウンド ${Math.max(game.round, 1)}${online ? '' : '・切断中'}`;
      q('title').textContent = s.title;
      q('big').textContent = s.big;
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
      setEnabled(btn('reset'), game.stage === 'timer', false);
      const canResult = game.stage === 'result' || done;
      setEnabled(btn('win-oni'), canResult, canResult && !game.result);
      setEnabled(btn('win-runner'), canResult, canResult && !game.result);

      const canEditDurations = game.stage === 'lobby' || game.stage === 'assigned' || game.stage === 'result';
      inputs.forEach((input, i) => {
        input.disabled = !canEditDurations;
        if (!editingDurations) input.value = String(Math.round(game.durations[i] / 1000));
      });
      (form.querySelector('button') as HTMLButtonElement).disabled = !canEditDurations;

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
