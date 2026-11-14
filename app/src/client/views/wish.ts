import '../picto/engine.js';
import type { RoleId } from '../../shared/rules';
import { wishCaption, wishPreview, type PhoneView, type WishView } from '../../shared/viewmodel';
import type { ClientState, GameClient } from '../core/game-client';
import { esc, say, sent, setHTML, type Pair } from '../ui';

/**
 * 配役の希望（見た目の層）。参加者の画面のいちばん下に差し込む。
 *
 * 次の配役の前（待合室・結果発表。見学の人はゲームが終わってから）に、板を2枚並べる：左＝逃走者（月白）、右＝鬼（朱と角）。
 * 押すとその役を希望する。もう一度押すと取り消す（どちらでも）。板の数字は「希望している人数／枠」。
 * 人数は主催者の割合のまま変わらない。枠より多い希望はくじで、外れた人は次の配役で優先される。
 */

export interface WishDeps {
  client: Pick<GameClient, 'wish'>;
}

export interface WishScreen {
  el: HTMLElement;
  update(view: PhoneView, state: Pick<ClientState, 'online'>): void;
}

/** 押してから、サーバーの返事が来るまで板を押した姿にしておく長さ（これを過ぎたら、サーバーの値に戻す） */
const PENDING_MS = 2_500;
/** 押した直後のこの間は、届いた値にかかわらず押した姿のまま（続けて2回押したとき、1回目の返事で板がちらつかないように） */
const PENDING_HOLD_MS = 350;

const NAME: Record<RoleId, Pair> = { runner: ['逃走者', 'RUNNER'], oni: ['鬼', 'CHASER'] };

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 震えない端末
  }
}

/** ピクトの止めた姿（板の中は動かさない。現場の画面で動かす絵は1つまで） */
let stills: Map<string, string> | null = null;
function still(id: string): string {
  if (!stills) {
    stills = new Map();
    // 拍は止めた姿に関係しない
    for (const p of window.URAFES_PICTO.build({}).pictos) {
      // 同じ絵が画面の真ん中にも出ることがある（配役の絵）。id が重ならないように付け替える
      stills.set(p.id, p.svgStatic.split(`up-${p.id}`).join(`wish-${p.id}`).split(`${p.id}-line`).join(`wish-${p.id}-line`));
    }
  }
  return stills.get(id) ?? '';
}

export function createWish({ client }: WishDeps): WishScreen {
  const el = document.createElement('section');
  el.className = 'wish';
  el.hidden = true;
  const board = (role: RoleId, picto: string) => `
    <button type="button" class="wish-btn" data-wish="${role}" aria-pressed="false">
      <span class="wish-pic">${still(picto)}</span>
      <span class="wish-name">${say(NAME[role])}</span>
      <span class="wish-num u" data-k="num-${role}"></span>
    </button>`;
  el.innerHTML = `
    <p class="wish-title" data-k="title"></p>
    <div class="wish-pair">${board('runner', 'runner')}${board('oni', 'chaser')}</div>
    <p class="wish-cap" data-k="cap" aria-live="polite"></p>
  `;
  const q = (k: string) => el.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const btns = [...el.querySelectorAll('.wish-btn')] as HTMLButtonElement[];

  let current: WishView | null = null;
  let online = true;
  /** 待合室（配役の前）か */
  let lobby = true;
  /** 押してから返事が来るまでの、押した姿 */
  let pending: { role: RoleId | null; at: number } | null = null;

  for (const b of btns) {
    b.addEventListener('click', () => {
      if (!current || !online) return;
      const role = b.dataset.wish as RoleId;
      const shown = pending ? pending.role : current.mine;
      const next = shown === role ? null : role;
      if (!client.wish(next)) return;
      pending = { role: next, at: Date.now() };
      vibrate(12);
      draw();
    });
  }

  function draw(): void {
    const w = current;
    el.hidden = !w;
    if (!w) return;
    // サーバーの値が追いついた・待ちすぎたら、押した姿をやめてサーバーの値に従う
    if (pending) {
      const age = Date.now() - pending.at;
      if ((pending.role === w.mine && age >= PENDING_HOLD_MS) || age > PENDING_MS) pending = null;
    }
    // 押した姿：自分の希望と、自分の1人ぶんの人数を先に動かして見せる
    const shown = pending ? wishPreview(w, pending.role) : w;
    const mine = shown.mine;
    el.dataset.mine = mine ?? 'none';
    el.classList.toggle('is-offline', !online);
    // 待合室では、すぐ上のひとこと（選ぶ CHOOSE）が題の代わり。結果発表・見学では「次の役」と添える
    setHTML(q('title'), lobby ? '' : say(['次の役', 'NEXT ROLE']));
    for (const b of btns) {
      const role = b.dataset.wish as RoleId;
      b.setAttribute('aria-pressed', String(mine === role));
      b.disabled = !online;
      b.classList.toggle('is-over', shown.want[role] > shown.slots[role]);
      b.setAttribute('aria-label', `${NAME[role][0]}：希望 ${shown.want[role]}人・枠 ${shown.slots[role]}人`);
      setHTML(q(`num-${role}`), `<b>${esc(String(shown.want[role]))}</b><span>/${esc(String(shown.slots[role]))}</span>`);
    }
    setHTML(q('cap'), sent(online ? wishCaption(shown) : ['通信が切れている。つながったら選べる', 'Offline. Pick when it reconnects']));
  }

  return {
    el,
    update(view, state) {
      current = view.wish ?? null;
      online = state.online;
      lobby = view.step === 0;
      if (!current) pending = null;
      draw();
    },
  };
}
