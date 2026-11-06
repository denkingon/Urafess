import type { Candidate } from '../../shared/capture';
import type { RosterEntry } from '../../shared/protocol';
import { HOLD_LATCH_MS, HOLD_MIN_MS } from '../../shared/rules';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState, GameClient } from '../core/game-client';
import type { SoundEmitter } from '../sound/emitter';
import type { SoundListener } from '../sound/listener';
import { glyph, sent, say, setHTML, type Pair } from '../ui';

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
const TAG_EN: Record<string, string> = { 音: 'SOUND', 同時: 'SAME TIME', 鬼が選んだ: 'PICKED', 前後: 'WITHIN 20 S' };

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末
  }
}

/** 鬼のマイクのボタンに出す言葉：[大きい字, 小さい字, 押せるか] */
function micPrompt(listener: SoundListener): [Pair, Pair, boolean] {
  if (listener.silent) return [['マイクに音が来ていない', 'NO SOUND ON MIC'], ['押して開き直す。直らなければアプリを開き直す', 'Tap to reopen. If that fails, reopen the app'], true];
  switch (listener.state) {
    case 'starting':
      return [['マイクを準備中…', 'STARTING MIC'], ['許可を聞かれたら「許可」を押す', 'Tap "Allow" when asked'], false];
    case 'ready':
      return [['マイクをもう一度オンにする', 'MIC ON AGAIN'], ['マイクが止まっている。押すと戻る', 'The mic stopped. Tap to restart'], true];
    case 'denied':
      return [['マイクが許可されていない', 'MIC NOT ALLOWED'], ['押してもう一度試す。だめなら設定アプリでマイクを許可する。それまでは長押しの時刻だけで記録の候補に出る', 'Tap to retry, or allow the mic in Settings. Until then, only the hold time is used'], true];
    case 'error':
      return [['マイクをもう一度オンにする', 'MIC ON AGAIN'], ['マイクを開けなかった。押してもう一度試す', 'Could not open the mic. Tap to retry'], true];
    case 'unsupported':
      return [['このスマホではマイクが使えない', 'NO MIC ON THIS PHONE'], ['長押しの時刻だけで記録の候補に出る', 'Only the hold time is used'], false];
    default:
      return [['マイクをオン', 'MIC ON'], ['捕まえた相手の音を拾うのに使う。オンになるまで、ここに出る', 'Used to hear who you caught. Stays here until it is on'], true];
  }
}

export function createCapture({ client, emitter, listener }: CaptureDeps): CaptureScreen {
  const el = document.createElement('section');
  el.className = 'capture';
  el.innerHTML = `
    <button type="button" class="cap-mic" data-act="mic" data-k="mic" hidden>
      ${glyph.mic}<span class="cap-lab"><b data-k="micLabel"></b><span data-k="micSub"></span></span>
    </button>
    <div class="cap-cands" data-k="cands" hidden>
      <p class="cap-title">${glyph.oni}<span>${say(['捕まえたのは？', 'WHO CAUGHT YOU?'])}</span></p>
      <div class="cap-grid" data-k="grid" data-kind="oni"></div>
      <div class="cap-wait" data-k="wait" aria-label="鬼が近くで長押しすると、ここに出る"><i></i><i></i><i></i></div>
      <div class="cap-row">
        <button type="button" class="rb" data-act="manual" aria-label="手動で選ぶ"><i>${glyph.list}</i>${say(['手動', 'LIST'])}</button>
        <button type="button" class="rb" data-act="cancel" aria-label="やめる（押し間違い）"><i>${glyph.cross}</i>${say(['やめる', 'CANCEL'])}</button>
      </div>
    </div>
    <div class="cap-lock" data-k="lock" hidden>${glyph.beacon}<b data-k="lockName"></b><span>${sent(['離していい。相手が選ぶと記録される', 'You can let go. It is recorded when they pick you'])}</span></div>
    <div class="cap-prep" data-k="prep" hidden><span data-k="prepText"></span><button type="button" class="ghost" data-act="prep" data-k="prepBtn"></button></div>
    <button type="button" class="hold" data-k="hold" hidden>
      <span class="hold-fill"></span>
      <span class="hold-icon" data-k="holdIcon"></span>
      <span class="cap-lab"><b data-k="holdLabel"></b><span data-k="holdSub"></span></span>
      ${glyph.waves}
    </button>
    <div class="cap-row cap-foot" data-k="foot" hidden>
      <button type="button" class="rb" data-act="manual" data-k="footManual" aria-label="手動で選ぶ"><i>${glyph.list}</i>${say(['手動', 'LIST'])}</button>
      <span class="cap-status" data-k="status"></span>
    </div>
    <div class="sheet" data-k="sheet" hidden>
      <div class="sheet-body">
        <p class="cap-title" data-k="sheetTitle"></p>
        <div class="cap-grid" data-k="sheetGrid"></div>
        <p class="cap-wait" data-k="sheetWait"></p>
        <button type="button" data-act="close">${say(['閉じる', 'CLOSE'])}</button>
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
  /** 長押しになった（0.5秒押した）押し始め。離してもここから HOLD_LATCH_MS までは続く */
  let holdAt = 0;
  /** 離したあとも続けている間の、終わりのタイマー */
  let latch: ReturnType<typeof setTimeout> | null = null;
  /** 鬼のスマホが、長押しと関係なく聞いている（ゲームの段階の間ずっと） */
  let passive = false;
  /** 離した直後のこの時刻までは、逃走者に候補を出さない（鬼が1人に決まれば、サーバーがそのまま記録するので） */
  let quietUntil = 0;
  let lastNotice = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let lockTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetOpenSeq = -1;
  let lastCandsKey = '';
  let lastSheetSeq = -1;
  const sentCodes = new Map<string, number>();
  /** 押した候補と、押した時刻（効いたか分からないまま6秒たったら、押せる見た目に戻す） */
  const sentCands = new Map<string, number>();

  const showToast = (text: Pair) => {
    toast.innerHTML = sent(text);
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 3_500);
  };

  // ---------- 長押し ----------

  const onHeardCode = (heard: string) => {
    // 同じ3桁は3秒に1回だけ送る（相手は繰り返し鳴らしている）
    const last = sentCodes.get(heard) ?? 0;
    if (Date.now() - last < 3_000) return;
    sentCodes.set(heard, Date.now());
    client.heard(heard);
  };
  const startEffects = () => {
    if (mode === 'runner' && code) emitter.start(code);
    if (mode === 'oni') listener.listen(onHeardCode);
  };
  const stopEffects = () => {
    emitter.stop();
    // ずっと聞いている鬼は、長押しが終わっても聞き続ける
    if (!passive) listener.pause();
  };

  /** 長押しを本当に終える（離したあと続けていた分も含めて） */
  const finishHold = () => {
    if (latch) clearTimeout(latch);
    latch = null;
    stopEffects();
    if (holding) {
      holding = false;
      quietUntil = Date.now() + 1_500;
      client.holdEnd(Date.now());
    }
    el.classList.remove('is-pressing', 'is-holding', 'is-latched');
  };

  /**
   * 指を離した。0.5秒押していれば離していい：押し始めから HOLD_LATCH_MS までは、音を出し続ける（鬼は聞き続ける）。
   * 押しっぱなしで近づけなくても、鳴っている間にスマホを相手に寄せればいい
   */
  const endPress = (force = false) => {
    if (!pressing) {
      if (force) finishHold();
      return;
    }
    clearTimeout(pressing.timer);
    pressing = null;
    el.classList.remove('is-pressing');
    const left = holdAt + HOLD_LATCH_MS - Date.now();
    if (holding && !force && left > 0) {
      el.classList.add('is-latched');
      latch = setTimeout(finishHold, left);
      return;
    }
    finishHold();
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
    if (latch) {
      // 離したあと鳴っている間に、また押した：同じ長押しのまま続ける（離すまで）
      clearTimeout(latch);
      latch = null;
      el.classList.remove('is-latched');
      pressing = { id: e.pointerId, at: holdAt, timer: setTimeout(() => undefined, 0) };
      el.classList.add('is-pressing');
      return;
    }
    pressing = {
      id: e.pointerId,
      at,
      timer: setTimeout(() => {
        if (!pressing) return;
        holding = true;
        holdAt = pressing.at;
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
        setHTML(q('sheetTitle'), `${role === '鬼' ? glyph.runner : glyph.oni}<span>${say(role === '鬼' ? ['手動で選ぶ：捕まえたのは？', 'PICK WHO YOU CAUGHT'] : ['手動で選ぶ：捕まえたのは？（鬼）', 'PICK THE CHASER'])}</span>`);
        sheetGrid.dataset.kind = role === '鬼' ? 'runner' : 'oni';
        sheetGrid.replaceChildren();
        setHTML(q('sheetWait'), sent(['読み込んでいる…', 'Loading…']));
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
        // 一覧に出るのが鬼なら角の頭、逃走者なら点
        const icon = document.createElement('span');
        icon.innerHTML = target.dataset.kind === 'runner' ? glyph.runner : glyph.oni;
        const nm = document.createElement('span');
        nm.className = 'nm';
        const name = document.createElement('b');
        name.textContent = p.name;
        // 番号は出さない（名前は名簿で1人1つ）
        const tags = p.tags ?? [];
        if (tags.length) {
          const small = document.createElement('small');
          small.innerHTML = sent([tags.join('・'), tags.map((t) => TAG_EN[t] ?? t).join(' · ')]);
          nm.append(name, small);
        } else {
          nm.append(name);
        }
        b.append(icon.firstElementChild ?? icon, nm);
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
        (q('lockName') as HTMLElement).textContent = who;
        lock.hidden = false;
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = setTimeout(() => (lock.hidden = true), 8_000);
        listener.beep();
        vibrate([30, 40, 30]);
        return;
      case 'captured':
        lock.hidden = true;
        showToast([`${who}を捕まえた`, `Caught ${who}`]);
        vibrate([80, 60, 80]);
        return;
      case 'caught':
        showToast(n.other ? [`${who}に捕まった`, `Caught by ${who}`] : ['捕まった（主催者の記録）', 'Caught (recorded by the host)']);
        vibrate(200);
        return;
      case 'nominated':
        showToast([`${who}に選んでもらう`, `Waiting for ${who} to pick you`]);
        return;
      case 'released':
        showToast(['主催者が捕獲を取り消した', 'The host undid the catch']);
        return;
      case 'closed':
        showToast(['今は記録できない（ゲーム中だけ）', 'You can only record during the game']);
        return;
      case 'already':
        showToast(n.other ? [`${who}はもう捕まっている`, `${who} is already caught`] : ['もう捕まっている', 'Already caught']);
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
      if (prevMode !== mode && mode === 'none') endPress(true);
      // 鬼はゲームの段階の間ずっと聞く（マイクがもう開いているときだけ。開くのはマイクの板を押したとき）。
      // 足すのは読み取りの計算だけ：マイクは配役のあとから開けたまま
      const wantPassive = mode === 'oni' && listener.state === 'ready';
      if (wantPassive && !passive) {
        passive = true;
        listener.listen(onHeardCode);
      } else if (!wantPassive && passive) {
        passive = false;
        if (!holding) listener.pause();
      }
      // ゲームの段階が終わったら（広場に戻る・結果発表・配役前）、または鬼でなくなったらマイクを閉じる。ゲームの前に開けた分は残す
      const afterGame = view.step === 0 || view.step >= 5;
      if (listener.state === 'ready' && ((mode === 'none' && afterGame) || view.role !== '鬼')) listener.close();

      onNotice(state);

      // 逃走者の候補（「捕まった」を押してから選ぶまで）
      const claim = state.me?.role === 'runner' && !state.me.caught ? state.me.claim : null;
      const cands = q('cands');
      // 押している間と、離した直後は出さない：鬼が1人に決まるなら選ばずに記録されるので、聞く必要がない
      const settling = mode === 'runner' && (holding || latch !== null || Date.now() < quietUntil);
      cands.hidden = !claim || settling;
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
        setHTML(q('sheetWait'), people.length ? '' : sent(['選べる人がいない', 'Nobody to pick']));
      }

      // 鬼のマイク：配役からゲームの終わりまで、マイクが本当に音を拾えるようになるまで大きく出し続ける。
      // 一度オンにしても、止まったら（iPhone で画面を離れた・ほかの音のアプリ・電話など）また出す
      const inRound = view.role !== 'なし' && !view.caught;
      const beforeOrDuring = view.step >= 1 && view.step <= 4;
      const needMic = inRound && beforeOrDuring && role === '鬼' && !listener.live;
      // まだ一度も試していないうちは、長押しの板の場所にマイクの板を出す。試したあと（止まった・断られた）は、小さくして長押しの板も出す
      const micFirst = needMic && listener.state === 'off' && !listener.silent;

      // 長押しボタン
      hold.hidden = mode === 'none' || (mode === 'oni' && micFirst);
      q('foot').hidden = mode === 'none';
      // 手動の一覧：鬼はゲームの間いつでも。逃走者は「捕まった」を長押ししたあと（候補の枠の中）だけ
      q('footManual').hidden = mode !== 'oni';
      if (mode === 'oni') {
        setHTML(q('holdIcon'), glyph.oni);
        setHTML(q('holdLabel'), say(holding ? ['聞いている', 'LISTENING'] : ['捕まえた', 'GOT YOU']));
        setHTML(q('holdSub'), sent(holding ? ['相手のスマホに近づける', 'Bring your phone close'] : ['長押し', 'Press and hold']));
      } else if (mode === 'runner') {
        setHTML(q('holdIcon'), glyph.handsUp);
        setHTML(q('holdLabel'), say(holding ? ['鳴らしている', 'SOUNDING'] : ['捕まった', "I'M CAUGHT"]));
        setHTML(q('holdSub'), sent(holding ? ['鬼のスマホに近づける', "Bring it to the chaser's phone"] : ['長押し', 'Press and hold']));
      }
      el.dataset.mode = mode;

      // 状態の一言：困ったときと、長押し中のマイクの強さだけ出す（うまく動いているときは出さない）
      const status = q('status');
      if (mode === 'oni') {
        const mic: Record<string, Pair | null> = {
          off: null,
          starting: ['マイク：準備中', 'Mic: starting'],
          ready: listener.silent
            ? ['マイク：音が来ていない（上のボタンで開き直す）', 'Mic: no sound (tap above to reopen)']
            : !listener.live
              ? ['マイク：止まっている（上のボタンで戻す）', 'Mic: stopped (tap above to restart)']
              : holding
                ? [`マイク：${'▮'.repeat(1 + Math.round(listener.level * 5))}`, '']
                : null,
          denied: ['マイクが使えない（長押しの時刻で候補に出る）', 'No mic (only the hold time is used)'],
          unsupported: ['マイクが使えない（長押しの時刻で候補に出る）', 'No mic (only the hold time is used)'],
          error: ['マイクが使えない（長押しの時刻で候補に出る）', 'No mic (only the hold time is used)'],
        };
        const m = mic[listener.state];
        setHTML(status, m ? sent(m) : '');
      } else if (mode === 'runner') {
        setHTML(status, emitter.playing || emitter.unlocked ? '' : sent(['音：一度「音を試す」を押す', 'Sound: tap "Test sound" once']));
      } else {
        setHTML(status, '');
      }

      const mic = q('mic') as HTMLButtonElement;
      mic.hidden = !needMic;
      mic.classList.toggle('compact', needMic && !micFirst && !hold.hidden);
      mic.dataset.state = listener.silent ? 'silent' : listener.state;
      if (needMic) {
        const [label, sub, usable] = micPrompt(listener);
        setHTML(q('micLabel'), say(label));
        setHTML(q('micSub'), sent(sub));
        mic.disabled = !usable;
      }

      // 準備（ゲームの前に一度：逃走者は音を試す）
      const prep = q('prep');
      if (inRound && beforeOrDuring && role === '逃走者' && !emitter.unlocked) {
        prep.hidden = false;
        setHTML(q('prepText'), sent(['捕まったら長押しすると音が鳴る', 'When caught, hold the button to play your sound']));
        setHTML(q('prepBtn'), say(['音を試す', 'TEST SOUND']));
        (q('prepBtn') as HTMLButtonElement).hidden = !code;
      } else {
        prep.hidden = true;
      }
    },
  };
}
