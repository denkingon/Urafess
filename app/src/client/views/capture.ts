import type { Candidate } from '../../shared/capture';
import type { RosterEntry } from '../../shared/protocol';
import { HOLD_MIN_MS } from '../../shared/rules';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState, GameClient } from '../core/game-client';
import type { SoundEmitter } from '../sound/emitter';
import type { SoundListener } from '../sound/listener';

/**
 * 捕獲の画面（見た目の層）。参加者の画面の下に差し込む。
 *
 * 鬼：「捕まえた」を長押し → マイクで相手の音を聞く → 拾うと「◯◯をロックオン」 → 離して次を追える
 * 逃走者：「捕まった」を長押し → 自分の3桁が鳴る → 「捕まえたのは？」に候補が同じ大きさで並ぶ → どれかを押すと記録
 * どちらも「手動で選ぶ」で一覧から選べる（鬼が選ぶと、その逃走者の候補に出る。記録は逃走者が選んだとき）
 */

export interface CaptureDeps {
  client: GameClient;
  emitter: SoundEmitter;
  listener: SoundListener;
}

export interface CaptureScreen {
  el: HTMLElement;
  update(view: PhoneView, state: ClientState): void;
}

const TAGS = (c: Candidate): string[] => {
  const t: string[] = [];
  if (c.heard) t.push('音');
  if (c.together) t.push('同時');
  if (c.nominated) t.push('鬼が選んだ');
  if (!t.length) t.push('前後');
  return t;
};

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末
  }
}

/** 鬼のマイクのボタンに出す言葉：[大きい字, 小さい字, 押せるか] */
function micPrompt(listener: SoundListener): [string, string, boolean] {
  if (listener.silent) return ['マイクに音が来ていない', '押して開き直す。直らなければアプリを開き直す', true];
  switch (listener.state) {
    case 'starting':
      return ['マイクを準備中…', '許可を聞かれたら「許可」を押す', false];
    case 'ready':
      return ['マイクをもう一度オンにする', 'マイクが止まっている。押すと戻る', true];
    case 'denied':
      return ['マイクが許可されていない', '押してもう一度試す。だめなら設定アプリでマイクを許可する。それまでは長押しの時刻だけで記録の候補に出る', true];
    case 'error':
      return ['マイクをもう一度オンにする', 'マイクを開けなかった。押してもう一度試す', true];
    case 'unsupported':
      return ['このスマホではマイクが使えない', '長押しの時刻だけで記録の候補に出る', false];
    default:
      return ['マイクをオンにする', '捕まえた相手の音を拾うのに使う。オンになるまで、ここに出る', true];
  }
}

export function createCapture({ client, emitter, listener }: CaptureDeps): CaptureScreen {
  const el = document.createElement('section');
  el.className = 'capture';
  el.innerHTML = `
    <button type="button" class="cap-mic" data-act="mic" data-k="mic" hidden>
      <b data-k="micLabel"></b><span data-k="micSub"></span>
    </button>
    <div class="cap-cands" data-k="cands" hidden>
      <p class="cap-title">捕まえたのは？<span>押した人が記録される</span></p>
      <div class="cap-grid" data-k="grid"></div>
      <p class="cap-wait" data-k="wait">鬼が近くで長押しすると、ここに出る。</p>
      <div class="cap-row">
        <button type="button" class="ghost" data-act="manual">手動で選ぶ</button>
        <button type="button" class="ghost" data-act="cancel">やめる（押し間違い）</button>
      </div>
    </div>
    <div class="cap-lock" data-k="lock" hidden><b data-k="lockName"></b><span>離してOK。相手が選ぶと記録される。</span></div>
    <div class="cap-prep" data-k="prep" hidden><span data-k="prepText"></span><button type="button" class="ghost" data-act="prep" data-k="prepBtn"></button></div>
    <button type="button" class="hold" data-k="hold" hidden>
      <span class="hold-fill"></span>
      <b data-k="holdLabel"></b><span data-k="holdSub"></span>
    </button>
    <div class="cap-row cap-foot" data-k="foot" hidden>
      <button type="button" class="ghost" data-act="manual" data-k="footManual">手動で選ぶ</button>
      <span class="cap-status" data-k="status"></span>
    </div>
    <div class="sheet" data-k="sheet" hidden>
      <div class="sheet-body">
        <p class="cap-title" data-k="sheetTitle"></p>
        <div class="cap-grid" data-k="sheetGrid"></div>
        <p class="cap-wait" data-k="sheetWait"></p>
        <button type="button" data-act="close">閉じる</button>
      </div>
    </div>
    <div class="toast" data-k="toast" hidden></div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const hold = q('hold') as HTMLButtonElement;
  const grid = q('grid');
  const sheet = q('sheet');
  const sheetGrid = q('sheetGrid');
  const toast = q('toast');
  const lock = q('lock');

  let mode: PhoneView['touch'] = 'none';
  let role: PhoneView['role'] = 'なし';
  let code: string | null = null;
  let pressing: { id: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let holding = false;
  let lastNotice = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let lockTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetOpenSeq = -1;
  let lastCandsKey = '';
  let lastSheetSeq = -1;
  const sentCodes = new Map<string, number>();
  /** 押した候補と、押した時刻（効いたか分からないまま6秒たったら、押せる見た目に戻す） */
  const sentCands = new Map<string, number>();

  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 3_500);
  };

  // ---------- 長押し ----------

  const startEffects = () => {
    if (mode === 'runner' && code) emitter.start(code);
    if (mode === 'oni') {
      listener.listen((heard) => {
        // 同じ3桁は3秒に1回だけ送る（相手は繰り返し鳴らしている）
        const last = sentCodes.get(heard) ?? 0;
        if (Date.now() - last < 3_000) return;
        sentCodes.set(heard, Date.now());
        client.heard(heard);
      });
    }
  };
  const stopEffects = () => {
    emitter.stop();
    listener.pause();
  };

  const endPress = () => {
    if (!pressing) return;
    clearTimeout(pressing.timer);
    pressing = null;
    stopEffects();
    if (holding) {
      holding = false;
      client.holdEnd(Date.now());
    }
    el.classList.remove('is-pressing', 'is-holding');
  };

  hold.addEventListener('pointerdown', (e) => {
    if (mode === 'none' || pressing) return;
    e.preventDefault();
    try {
      hold.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動く
    }
    const at = Date.now();
    pressing = {
      id: e.pointerId,
      at,
      timer: setTimeout(() => {
        if (!pressing) return;
        holding = true;
        el.classList.add('is-holding');
        client.holdStart(pressing.at);
        vibrate(20);
      }, HOLD_MIN_MS),
    };
    el.classList.add('is-pressing');
    startEffects();
  });
  const release = (e: PointerEvent) => {
    if (pressing && e.pointerId === pressing.id) endPress();
  };
  hold.addEventListener('pointerup', release);
  hold.addEventListener('pointercancel', release);
  hold.addEventListener('lostpointercapture', release);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- 押すボタン ----------

  const choose = (t: HTMLElement) => {
    const pid = t.dataset.pid!;
    if (t.closest('[data-k="sheet"]')) {
      if (role === '鬼') {
        client.nominate(pid);
      } else {
        client.answer(pid, true);
      }
      sheet.hidden = true;
    } else {
      client.answer(pid);
      t.classList.add('is-sent');
      sentCands.set(pid, Date.now());
    }
  };

  // 候補は、指を離した瞬間（pointerup）に選ぶ。「捕まった」を長押ししたまま別の指で押すと、ブラウザは click を出さないため
  const downOn = new Map<number, HTMLElement>();
  let chosenAt = 0;
  el.addEventListener(
    'pointerdown',
    (e) => {
      const t = (e.target as HTMLElement).closest('[data-pid]') as HTMLElement | null;
      if (t) downOn.set(e.pointerId, t);
    },
    true,
  );
  el.addEventListener(
    'pointerup',
    (e) => {
      const t = downOn.get(e.pointerId);
      downOn.delete(e.pointerId);
      if (!t || (e.target as HTMLElement).closest('[data-pid]') !== t) return;
      chosenAt = Date.now();
      choose(t);
    },
    true,
  );
  el.addEventListener('pointercancel', (e) => downOn.delete(e.pointerId), true);

  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-act], [data-pid]') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.pid) {
      // pointerup で選んだ直後の click は同じ操作（キーボードなど pointerup の無い操作だけ、ここで選ぶ）
      if (Date.now() - chosenAt > 800) choose(t);
      return;
    }
    switch (t.dataset.act) {
      case 'cancel':
        client.cancelClaim();
        return;
      case 'manual':
        sheetOpenSeq = client.state.roster?.seq ?? 0;
        (q('sheetTitle') as HTMLElement).textContent = role === '鬼' ? '手動で選ぶ：捕まえたのは？' : '手動で選ぶ：捕まえたのは？（鬼）';
        sheetGrid.replaceChildren();
        q('sheetWait').textContent = '読み込んでいる…';
        sheet.hidden = false;
        client.requestRoster();
        return;
      case 'close':
        sheet.hidden = true;
        return;
      case 'mic':
        // このタップの中で開く（音の処理を動かすのも、許可を聞くのもタップの直後でないとできない端末がある）
        listener.unlock();
        void listener.open();
        return;
      case 'prep':
        if (role === '鬼') {
          void listener.open();
        } else if (code) {
          // 試しに1回鳴らす（このタップで音を出せるようになる）
          emitter.start(code);
          setTimeout(() => emitter.stop(), 1_600);
        }
        return;
    }
  });

  const renderGrid = (target: HTMLElement, people: { pid: string; num: number; name: string; tags?: string[] }[]) => {
    target.replaceChildren(
      ...people.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cap-cand';
        b.dataset.pid = p.pid;
        const name = document.createElement('b');
        name.textContent = p.name;
        b.append(name);
        if (p.tags?.length) {
          const tag = document.createElement('i');
          tag.textContent = p.tags.join('・');
          b.append(tag);
        }
        return b;
      }),
    );
  };

  // ---------- 知らせ ----------

  const onNotice = (state: ClientState) => {
    const n = state.notice;
    if (!n || n.seq === lastNotice) return;
    lastNotice = n.seq;
    const who = n.other ? n.other.name : '';
    switch (n.kind) {
      case 'heard':
        (q('lockName') as HTMLElement).textContent = `${who}をロックオン`;
        lock.hidden = false;
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = setTimeout(() => (lock.hidden = true), 8_000);
        listener.beep();
        vibrate([30, 40, 30]);
        return;
      case 'captured':
        lock.hidden = true;
        showToast(`${who}を捕まえた`);
        vibrate([80, 60, 80]);
        return;
      case 'caught':
        showToast(n.other ? `${who}に捕まった` : '捕まった（主催者の記録）');
        vibrate(200);
        return;
      case 'nominated':
        showToast(`${who}に選んでもらう`);
        return;
      case 'released':
        showToast('主催者が捕獲を取り消した');
        return;
      case 'closed':
        showToast('今は記録できない（ゲーム中だけ）');
        return;
      case 'already':
        showToast(n.other ? `${who}はもう捕まっている` : 'もう捕まっている');
        return;
    }
  };

  return {
    el,
    update(view, state) {
      const prevMode = mode;
      mode = view.touch;
      role = view.role;
      code = state.me?.code ?? null;
      if (prevMode !== mode && mode === 'none') endPress();
      // ゲームの段階が終わったら（広場に戻る・結果発表・配役前）、または鬼でなくなったらマイクを閉じる。ゲームの前に開けた分は残す
      const afterGame = view.step === 0 || view.step >= 5;
      if (listener.state === 'ready' && ((mode === 'none' && afterGame) || view.role !== '鬼')) listener.close();

      onNotice(state);

      // 逃走者の候補（「捕まった」を押してから選ぶまで）
      const claim = state.me?.role === 'runner' && !state.me.caught ? state.me.claim : null;
      const cands = q('cands');
      cands.hidden = !claim;
      if (claim) {
        // 押したのに6秒たっても記録されない（電波が切れていた等）候補は、押せる見た目に戻す
        for (const [pid, at] of sentCands) {
          if (Date.now() - at > 6_000) {
            sentCands.delete(pid);
            lastCandsKey = '';
          }
        }
        const key = JSON.stringify(claim.cands);
        if (key !== lastCandsKey) {
          lastCandsKey = key;
          renderGrid(grid, claim.cands.map((c) => ({ ...c, tags: TAGS(c) })));
          for (const b of grid.querySelectorAll<HTMLElement>('[data-pid]')) b.classList.toggle('is-sent', sentCands.has(b.dataset.pid!));
        }
        q('wait').hidden = claim.cands.length > 0;
      } else {
        lastCandsKey = '';
        sentCands.clear();
      }

      // 手動の一覧
      const roster = state.roster;
      if (!sheet.hidden && roster && roster.seq > sheetOpenSeq && roster.seq !== lastSheetSeq) {
        lastSheetSeq = roster.seq;
        const people: RosterEntry[] = roster.people;
        renderGrid(sheetGrid, people);
        q('sheetWait').textContent = people.length ? '' : '選べる人がいない。';
      }

      // 長押しボタン
      hold.hidden = mode === 'none';
      q('foot').hidden = mode === 'none';
      // 手動の一覧：鬼はゲームの間いつでも。逃走者は「捕まった」を長押ししたあと（候補の枠の中）だけ
      q('footManual').hidden = mode !== 'oni';
      if (mode === 'oni') {
        q('holdLabel').textContent = holding ? '聞いている…' : '捕まえた';
        q('holdSub').textContent = holding ? '相手のスマホに近づける' : '長押し';
      } else if (mode === 'runner') {
        q('holdLabel').textContent = holding ? '鳴らしている…' : '捕まった';
        q('holdSub').textContent = holding ? '鬼のスマホに近づける' : '長押し';
      }
      el.dataset.mode = mode;

      // 状態の一言
      const status = q('status');
      if (mode === 'oni') {
        const mic: Record<string, string> = {
          off: 'マイク：押すと使う',
          starting: 'マイク：準備中',
          ready: listener.silent ? 'マイク：音が来ていない（上のボタンで開き直す）' : !listener.live ? 'マイク：止まっている（上のボタンで戻す）' : holding ? `マイク：${'▮'.repeat(1 + Math.round(listener.level * 5))}` : 'マイク：準備OK',
          denied: 'マイクが使えない（長押しの時刻で候補に出る）',
          unsupported: 'マイクが使えない（長押しの時刻で候補に出る）',
          error: 'マイクが使えない（長押しの時刻で候補に出る）',
        };
        status.textContent = mic[listener.state];
      } else if (mode === 'runner') {
        status.textContent = emitter.playing ? '音：鳴らしている' : emitter.unlocked ? '音：準備OK' : '音：一度「音を試す」を押す';
      } else {
        status.textContent = '';
      }

      // 鬼のマイク：配役からゲームの終わりまで、マイクが本当に音を拾えるようになるまで大きく出し続ける。
      // 一度オンにしても、止まったら（iPhone で画面を離れた・ほかの音のアプリ・電話など）また出す
      const inRound = view.role !== 'なし' && !view.caught;
      const beforeOrDuring = view.step >= 1 && view.step <= 4;
      const mic = q('mic') as HTMLButtonElement;
      const needMic = inRound && beforeOrDuring && role === '鬼' && !listener.live;
      mic.hidden = !needMic;
      if (needMic) {
        const [label, sub, usable] = micPrompt(listener);
        q('micLabel').textContent = label;
        q('micSub').textContent = sub;
        mic.disabled = !usable;
      }

      // 準備（ゲームの前に一度：逃走者は音を試す）
      const prep = q('prep');
      if (inRound && beforeOrDuring && role === '逃走者' && !emitter.unlocked) {
        prep.hidden = false;
        q('prepText').textContent = '捕まったら長押しすると音が鳴る。';
        q('prepBtn').textContent = '音を試す';
        (q('prepBtn') as HTMLButtonElement).hidden = !code;
      } else {
        prep.hidden = true;
      }
    },
  };
}
