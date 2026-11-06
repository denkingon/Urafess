import { HOLD_MIN_MS, RESCUE_VOLUME, SOUND_PROTOCOL } from '../../shared/rules';
import type { PhoneView } from '../../shared/viewmodel';
import type { ClientState, GameClient } from '../core/game-client';
import type { SoundEmitter } from '../sound/emitter';
import type { SoundListener } from '../sound/listener';

/**
 * 牢屋の画面（見た目の層）。参加者の画面の下、捕獲の画面の上に差し込む。
 *
 * 牢屋の人：牢屋に入ったときからマイクで聞いている。助けに来た仲間の「助ける」の音を拾った瞬間に、その場で出られる。
 *           音が届かないときは「助けて」を長押し（仲間が同時に「助ける」を長押ししていれば、重なった瞬間に出られる）
 * 外の逃走者：牢屋に仲間がいる間だけ「助ける」を出す。長押しの間、自分の「助ける番号」を最大音量の超音波で鳴らす
 */

export interface JailDeps {
  client: GameClient;
  emitter: SoundEmitter;
  listener: SoundListener;
}

export interface JailScreen {
  el: HTMLElement;
  update(view: PhoneView, state: ClientState): void;
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 震えない端末
  }
}

/** 牢屋の人のマイクの案内：[大きい字, 小さい字, 押せるか]（何も出さなくてよければ null） */
function micPrompt(listener: SoundListener): [string, string, boolean] | null {
  if (listener.live && !listener.silent) return null;
  if (listener.silent) return ['マイクに音が来ていない', '押して開き直す。それまでは「助けて」を仲間と同時に長押しで出られる', true];
  switch (listener.state) {
    case 'starting':
      return ['マイクを準備中…', '許可を聞かれたら「許可」を押す', false];
    case 'denied':
      return ['マイクが許可されていない', '押してもう一度試す。それまでは「助けて」を仲間と同時に長押しで出られる', true];
    case 'unsupported':
      return ['このスマホではマイクが使えない', '「助けて」を仲間と同時に長押しで出られる', false];
    case 'error':
    case 'ready':
      return ['マイクをもう一度オンにする', 'マイクが止まっている。押すと戻る', true];
    default:
      return ['マイクをオンにする', '仲間が「助ける」を押した音を拾うと、その瞬間に出られる', true];
  }
}

export function createJail({ client, emitter, listener }: JailDeps): JailScreen {
  const el = document.createElement('section');
  el.className = 'jail';
  el.innerHTML = `
    <button type="button" class="cap-mic" data-act="mic" data-k="mic" hidden>
      <span class="cap-lab"><b data-k="micLabel"></b><span data-k="micSub"></span></span>
    </button>
    <p class="cap-status" data-k="status" hidden></p>
    <button type="button" class="hold hold-rescue" data-k="hold" hidden>
      <span class="hold-fill"></span>
      <span class="cap-lab"><b data-k="holdLabel"></b><span data-k="holdSub"></span></span>
    </button>
    <div class="toast" data-k="toast" hidden></div>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const hold = q('hold') as HTMLButtonElement;
  const toast = q('toast');

  let mode: NonNullable<PhoneView['rescue']> = 'none';
  let rcode: string | null = null;
  let preparedRcode: string | null = null;
  let pressing: { id: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let holding = false;
  /** 牢屋の人として、いまマイクで「助ける番号」を聞いている */
  let jailListening = false;
  let lastNotice = 0;
  let lastAllCaught: number | null | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const sentCodes = new Map<string, number>();

  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 4_000);
  };

  // ---------- 長押し ----------

  const endPress = () => {
    if (!pressing) return;
    clearTimeout(pressing.timer);
    pressing = null;
    emitter.stop();
    if (holding) {
      holding = false;
      client.rescueEnd(Date.now());
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
        client.rescueStart(pressing.at);
        vibrate(20);
      }, HOLD_MIN_MS),
    };
    el.classList.add('is-pressing');
    // 助ける人は、指を置いた瞬間から最大音量で鳴らす（牢屋の人のスマホが拾った瞬間に出られる）
    if (mode === 'save' && rcode) emitter.start(rcode, SOUND_PROTOCOL, RESCUE_VOLUME);
  });
  const release = (e: PointerEvent) => {
    if (pressing && e.pointerId === pressing.id) endPress();
  };
  hold.addEventListener('pointerup', release);
  hold.addEventListener('pointercancel', release);
  hold.addEventListener('lostpointercapture', release);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'mic') {
      // このタップの中で開く（音の処理を動かすのも、許可を聞くのもタップの直後でないとできない端末がある）
      listener.unlock();
      void listener.open();
    }
  });

  // ---------- 牢屋の人のマイク ----------

  const startJailListening = () => {
    jailListening = true;
    listener.listen((heard) => {
      // 同じ番号は2秒に1回だけ送る（助ける人は繰り返し鳴らしている）
      const last = sentCodes.get(heard) ?? 0;
      if (Date.now() - last < 2_000) return;
      sentCodes.set(heard, Date.now());
      client.heard(heard);
    });
  };
  const stopJailListening = () => {
    if (!jailListening) return;
    jailListening = false;
    listener.pause();
  };

  // ---------- 知らせ ----------

  const onNotice = (state: ClientState) => {
    const n = state.notice;
    if (!n || n.seq === lastNotice) return;
    lastNotice = n.seq;
    const who = n.other ? n.other.name : '';
    switch (n.kind) {
      case 'freed':
        showToast(n.via === 'mission' ? 'ミッション成功。牢屋から出た' : who ? `${who}が助けてくれた。牢屋から出た` : '牢屋から出た');
        vibrate([60, 40, 60, 40, 120]);
        listener.beep();
        return;
      case 'saved':
        // 1回の長押しで1人：出せたら鳴らすのをやめる（そばの別の牢屋の人が、同じ音で続けて出ないように）
        endPress();
        showToast(`${who}を牢屋から出した`);
        vibrate([80, 60, 80]);
        return;
      case 'immune':
        showToast(who ? `${who}は牢屋から出た直後。まだ捕まらない` : '牢屋から出た直後なので、まだ捕まらない');
        return;
    }
  };

  return {
    el,
    update(view, state) {
      const prev = mode;
      mode = view.rescue ?? 'none';
      rcode = state.me?.rcode ?? null;
      if (prev !== mode) endPress();
      onNotice(state);

      // 全員が牢屋に入った瞬間：みんなのスマホを震わせる
      const allCaught = state.game?.allCaughtAt ?? null;
      if (lastAllCaught !== undefined && lastAllCaught === null && allCaught !== null) {
        showToast('全員が牢屋に入った。ゲーム終了');
        vibrate([200, 100, 200]);
      }
      lastAllCaught = allCaught;

      // 助ける音は前もって作っておく（長押しの瞬間に間に合うように）
      if (rcode && rcode !== preparedRcode) {
        preparedRcode = rcode;
        void emitter.prepare(rcode, SOUND_PROTOCOL, RESCUE_VOLUME).catch(() => undefined);
      }

      // 牢屋の人のマイク：牢屋にいる間ずっと聞く。出たら・時間が終わったら止める
      if (mode === 'help') {
        if (listener.state === 'ready' && !listener.isListening) startJailListening();
      } else {
        stopJailListening();
      }
      const mic = q('mic') as HTMLButtonElement;
      const prompt = mode === 'help' ? micPrompt(listener) : null;
      mic.hidden = !prompt;
      if (prompt) {
        q('micLabel').textContent = prompt[0];
        q('micSub').textContent = prompt[1];
        mic.disabled = !prompt[2];
      }
      const status = q('status');
      status.hidden = mode !== 'help' || !listener.live;
      if (!status.hidden) status.textContent = `マイク：聞いている ${'▮'.repeat(1 + Math.round(listener.level * 5))}`;

      // 長押しの板
      hold.hidden = mode === 'none';
      el.dataset.mode = mode;
      if (mode === 'help') {
        q('holdLabel').textContent = holding ? '待っている…' : '助けて';
        q('holdSub').textContent = holding ? '仲間も「助ける」を長押し' : '仲間と同時に長押し（音が届かないとき）';
      } else if (mode === 'save') {
        q('holdLabel').textContent = holding ? '鳴らしている…' : '助ける';
        q('holdSub').textContent = holding ? '牢屋の仲間のスマホに近づける' : `牢屋の仲間に触れて長押し（牢屋 ${state.game?.counts.caught ?? 0}人）`;
      }
    },
  };
}
