import { SOUND_PROTOCOL, SOUND_VOLUME, type SoundProtocol } from '../../shared/rules';
import { SOUND_PROTOCOLS } from '../sound/codec';
import type { SoundEmitter } from '../sound/emitter';
import type { SoundListener } from '../sound/listener';

/**
 * 音の試し（/lab）。部屋もサーバーも使わず、2台のスマホだけで「鳴らす」「拾う」を確かめる。
 * 片方は「鳴らす」を長押し、もう片方は「聞く」を長押しして近づけ、何cmまで・まわりがうるさくても読めるかを見る。
 * 送り方と音量を変えて、いちばん読める組み合わせを rules.ts の SOUND_PROTOCOL・SOUND_VOLUME に入れる。
 */

const PROTOCOL_NAME: Record<SoundProtocol, string> = {
  'ultrasound-fastest': '超音波・最速（0.9秒）',
  'ultrasound-fast': '超音波・速い（1.2秒）',
  'ultrasound-normal': '超音波・ふつう（1.5秒）',
  'audible-fastest': '聞こえる音・最速（0.9秒）',
  'audible-fast': '聞こえる音・速い（1.2秒）',
  'audible-normal': '聞こえる音・ふつう（1.5秒）',
};

export function createLab(emitter: SoundEmitter, listener: SoundListener): HTMLElement {
  const el = document.createElement('main');
  el.className = 'phone lab';
  const code = String(100 + Math.floor(Math.random() * 900));
  el.innerHTML = `
    <h1>音の試し</h1>
    <p class="lead">2台で開く。片方は「鳴らす」、もう片方は「聞く」を長押しして、スマホを近づける。サーバーは使わない。</p>
    <div class="lab-mode">
      <button type="button" data-mode="emit" class="primary">鳴らす</button>
      <button type="button" data-mode="listen">聞く</button>
    </div>
    <label class="lab-field">送り方<select data-k="protocol">${SOUND_PROTOCOLS.map(
      (p) => `<option value="${p}"${p === SOUND_PROTOCOL ? ' selected' : ''}>${PROTOCOL_NAME[p]}${p === SOUND_PROTOCOL ? '（今の既定）' : ''}</option>`,
    ).join('')}</select></label>
    <label class="lab-field">音量 <span data-k="volText">${SOUND_VOLUME}</span><input type="range" min="5" max="100" step="5" value="${SOUND_VOLUME}" data-k="volume"></label>
    <label class="lab-field">鳴らす3桁<input type="text" inputmode="numeric" maxlength="3" value="${code}" data-k="code"></label>
    <div class="spacer"></div>
    <div class="lab-heard" data-k="heard" hidden></div>
    <p class="note" data-k="status"></p>
    <button type="button" class="hold" data-k="hold"><span class="hold-fill"></span><b data-k="holdLabel">鳴らす</b><span>長押し</span></button>
  `;
  const q = <T extends HTMLElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
  const hold = q<HTMLButtonElement>('hold');
  const protocolSel = q<HTMLSelectElement>('protocol');
  const volume = q<HTMLInputElement>('volume');
  const codeInput = q<HTMLInputElement>('code');
  const heardBox = q('heard');
  let mode: 'emit' | 'listen' = 'emit';
  let pressing: number | null = null;
  let pressStart = 0;
  const heard: { code: string; at: number }[] = [];

  const render = () => {
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('primary', b.dataset.mode === mode));
    q('holdLabel').textContent = mode === 'emit' ? (pressing !== null ? '鳴らしている…' : '鳴らす') : pressing !== null ? '聞いている…' : '聞く';
    (q('code').parentElement as HTMLElement).hidden = mode !== 'emit';
    heardBox.hidden = mode !== 'listen';
    heardBox.replaceChildren(
      ...heard.slice(-6).reverse().map((h) => {
        const row = document.createElement('div');
        row.textContent = `${h.code}　（押してから ${(h.at / 1000).toFixed(1)}秒）`;
        return row;
      }),
    );
    if (mode === 'listen' && heard.length === 0) heardBox.textContent = 'まだ何も拾っていない。';
    const meter = '▮'.repeat(1 + Math.round(listener.level * 9));
    q('status').textContent =
      mode === 'listen'
        ? `マイク：${{ off: '長押しで開く', starting: '準備中', ready: meter, denied: '許可されていない', unsupported: '使えない', error: '開けなかった' }[listener.state]}`
        : emitter.playing
          ? '鳴らしている'
          : emitter.unlocked
            ? '準備OK'
            : '一度どこかを押すと鳴らせるようになる';
  };

  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
    if (t?.dataset.mode) {
      mode = t.dataset.mode as 'emit' | 'listen';
      if (mode === 'listen') void listener.open();
      render();
    }
  });
  volume.addEventListener('input', () => {
    q('volText').textContent = volume.value;
  });

  hold.addEventListener('pointerdown', (e) => {
    if (pressing !== null) return;
    e.preventDefault();
    try {
      hold.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動く
    }
    pressing = e.pointerId;
    pressStart = performance.now();
    el.classList.add('is-pressing', 'is-holding');
    if (mode === 'emit') {
      const c = /^\d{3}$/.test(codeInput.value) ? codeInput.value : code;
      emitter.start(c, protocolSel.value as SoundProtocol, Number(volume.value));
    } else {
      listener.listen((c) => {
        heard.push({ code: c, at: performance.now() - pressStart });
        try {
          navigator.vibrate?.(30);
        } catch {
          // 震えない端末
        }
        listener.beep();
      });
    }
  });
  const release = (e: PointerEvent) => {
    if (pressing !== e.pointerId) return;
    pressing = null;
    emitter.stop();
    listener.pause();
    el.classList.remove('is-pressing', 'is-holding');
  };
  hold.addEventListener('pointerup', release);
  hold.addEventListener('pointercancel', release);
  hold.addEventListener('lostpointercapture', release);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  const loop = () => {
    render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return el;
}
