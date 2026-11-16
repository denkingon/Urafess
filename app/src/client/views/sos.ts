import '../picto/engine.js';
import './sos.css';
import type { MeSos } from '../../shared/protocol';
import type { GameClient } from '../core/game-client';
import type { Sensors } from '../sense';

/**
 * 救護の呼び出し（緊急ボタン）。入室したあとは試合の段階に関係なく、画面の右上にいつも出る。
 * 3秒長押しで本部に知らせる（捕獲の0.5秒と取り違えない長さ）。位置が取れれば一緒に送る。
 * 押したあとは全画面の板：119 と北門警備室の電話がいちばん大きく、本部が見たかどうかが出る。
 * 届いたかはサーバーから返ってくる状態（me.sos）で見て、届くまでこのスマホが送り直す（切れていても、つながったら届く）。
 * 押したことはこのスマホに覚えておく（開き直しても、呼び出しのまま）
 */

export const SOS_HOLD_MS = 3_000;
/** 届くまで送り直す間 */
const RESEND_MS = 3_000;
/** 位置を送り直す間（呼び出しが終わるまで） */
const POS_EVERY_MS = 20_000;
/** 北門警備室（夜・休日。2026年度 SFC キャンパス案内） */
const GUARD_TEL = '0466-47-5114';
const PLACE_119 = '藤沢市遠藤5322 慶應義塾大学 湘南藤沢キャンパス';

interface Local {
  cid: string;
  at: number;
}

export interface SosScreen {
  /** 右上のボタン（入室したあとだけ出す） */
  btn: HTMLButtonElement;
  /** 全画面の板 */
  sheet: HTMLElement;
  /** 呼び出し中か（呼び出し中は新しい版への読み込み直しをしない） */
  active(): boolean;
  update(me: MeSos | null | undefined, ready: boolean, online: boolean): void;
}

function aidSVG(): string {
  try {
    const all = window.URAFES_PICTO.build({ BEAT: 1 }).pictos as { id: string; svg: string }[];
    return all.find((p) => p.id === 'aid')?.svg ?? '';
  } catch {
    return '';
  }
}

const tel = (n: string) => `tel:${n.replace(/[^0-9+]/g, '')}`;

export function createSos(deps: { client: GameClient; sensors: Sensors; gameId: string }): SosScreen {
  const key = `urafess:sos:${deps.gameId}`;
  const load = (): Local | null => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Local | null;
      return v && typeof v.cid === 'string' && Date.now() - v.at < 6 * 3600_000 ? v : null;
    } catch {
      return null;
    }
  };
  const save = (v: Local | null) => {
    try {
      if (v) localStorage.setItem(key, JSON.stringify(v));
      else localStorage.removeItem(key);
    } catch {
      // 保存できない端末。このページを開いている間は覚えている
    }
  };
  let local = load();
  let lastSent = 0;
  let lastPosSent = 0;
  let pos: { lat: number; lon: number; acc: number } | null = null;
  let watch: number | null = null;
  let sheetOpen = local !== null;
  let confirmCancel = false;
  let server: MeSos | null = null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sos-btn';
  btn.hidden = true;
  btn.setAttribute('aria-label', '救護の呼び出し（3秒長押し）');
  btn.innerHTML = `<span class="sos-ring"></span><span class="sos-pic">${aidSVG()}</span><span class="sos-lbl">救護</span>`;

  const sheet = document.createElement('section');
  sheet.className = 'sos-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'alertdialog');
  sheet.innerHTML = `
    <div class="sos-head">
      <div class="sos-pic big">${aidSVG()}</div>
      <div><b data-k="title"></b><p data-k="sub"></p></div>
    </div>
    <a class="sos-call" href="${tel('119')}"><b>119 に電話</b><span>救急・火事。意識がない・息がおかしい・血が止まらない・頭を強く打った → まずこっち</span></a>
    <a class="sos-call guard" href="${tel(GUARD_TEL)}"><b>北門警備室 ${GUARD_TEL}</b><span>夜・休日のキャンパスの窓口。救急車の手配や門のこと</span></a>
    <p class="sos-place">119 で言う場所：<b>${PLACE_119}</b></p>
    <p class="sos-pos" data-k="pos"></p>
    <div class="sos-row">
      <button type="button" class="sos-close" data-k="close">画面を閉じる（呼び出しはそのまま）</button>
      <button type="button" class="sos-cancel" data-k="cancel">押し間違い・取り消す</button>
    </div>`;
  const q = (k: string) => sheet.querySelector(`[data-k="${k}"]`) as HTMLElement;
  const title = q('title');
  const sub = q('sub');
  const posEl = q('pos');
  const closeBtn = q('close') as HTMLButtonElement;
  const cancelBtn = q('cancel') as HTMLButtonElement;

  // ---------- 位置 ----------
  const startWatch = () => {
    const known = deps.sensors.position(Date.now());
    if (known && !pos) pos = { lat: known.lat, lon: known.lon, acc: Math.round(known.acc ?? 9_999) };
    if (watch !== null || !('geolocation' in navigator)) return;
    try {
      watch = navigator.geolocation.watchPosition(
        (p) => {
          const next = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) };
          const better = !pos || next.acc < pos.acc - 5;
          pos = next;
          // よりよい位置が取れたら、間を待たずに送る
          if (better) lastPosSent = 0;
        },
        () => {
          // 位置が取れなくても呼び出しは届く
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
      );
    } catch {
      watch = null;
    }
  };
  const stopWatch = () => {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
  };

  // ---------- 長押し ----------
  let pressAt = 0;
  let pressTimer: number | null = null;
  let tickTimer: number | null = null;
  const live = () => !!local || (server !== null && (server.status === 'open' || server.status === 'ack'));
  const endPress = () => {
    pressAt = 0;
    btn.classList.remove('is-pressing');
    btn.style.removeProperty('--p');
    if (pressTimer !== null) clearTimeout(pressTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    pressTimer = tickTimer = null;
  };
  const fire = () => {
    endPress();
    local = { cid: Math.random().toString(36).slice(2, 12) + Date.now().toString(36), at: Date.now() };
    save(local);
    lastSent = 0;
    lastPosSent = Date.now();
    sheetOpen = true;
    confirmCancel = false;
    try {
      navigator.vibrate?.([200, 80, 200]);
    } catch {
      // 振動できない端末
    }
    startWatch();
    paint(true);
  };
  btn.addEventListener('pointerdown', (e) => {
    // 呼び出し中は、押せば板が開くだけ
    if (live()) return;
    e.preventDefault();
    pressAt = performance.now();
    btn.classList.add('is-pressing');
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      // 捕まえられなくても動く
    }
    pressTimer = window.setTimeout(fire, SOS_HOLD_MS);
    tickTimer = window.setInterval(() => {
      if (!pressAt) return;
      btn.style.setProperty('--p', String(Math.min(1, (performance.now() - pressAt) / SOS_HOLD_MS)));
    }, 50);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) btn.addEventListener(ev, () => pressAt && endPress());
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (live()) {
      sheetOpen = true;
      paint(true);
    }
  });
  closeBtn.addEventListener('click', () => {
    sheetOpen = false;
    confirmCancel = false;
    paint(true);
  });
  cancelBtn.addEventListener('click', () => {
    const st = server?.cid === local?.cid ? server?.status : undefined;
    // 終わった呼び出しの板は、そのまま閉じる
    if (!local || st === 'done' || st === 'cancel') {
      local = null;
      save(null);
      sheetOpen = false;
      stopWatch();
      paint(true);
      return;
    }
    if (!confirmCancel) {
      confirmCancel = true;
      paint(true);
      return;
    }
    deps.client.sos(false, local.cid, null);
    local = null;
    save(null);
    sheetOpen = false;
    confirmCancel = false;
    stopWatch();
    paint(true);
  });

  // ---------- 描く ----------
  let lastKey = '';
  const paint = (force = false) => {
    const st = local ? (server && server.cid === local.cid ? server.status : 'sending') : (server?.status ?? null);
    const k = JSON.stringify([st, sheetOpen, confirmCancel, pos ? Math.round(pos.acc / 10) : -1, btn.hidden]);
    if (!force && k === lastKey) return;
    lastKey = k;
    const calling = st === 'sending' || st === 'open' || st === 'ack';
    btn.classList.toggle('is-calling', calling);
    btn.querySelector('.sos-lbl')!.textContent = calling ? '呼び出し中' : '救護';
    sheet.hidden = !sheetOpen || btn.hidden;
    sheet.dataset.st = st ?? 'none';
    if (st === 'sending') {
      title.textContent = '本部に送っている…';
      sub.textContent = 'つながったらすぐ届く。急ぐときは下の 119 に電話';
    } else if (st === 'open') {
      title.textContent = '本部に届いた';
      sub.textContent = '本部が見るまで鳴り続ける。動ける人はその場で待って';
    } else if (st === 'ack') {
      title.textContent = '本部が見た。向かっている';
      sub.textContent = 'その場で待って。急ぐときは 119';
    } else if (st === 'done') {
      title.textContent = '本部が「終わった」にした';
      sub.textContent = 'また何かあれば、右上の救護をもう一度長押し';
    } else if (st === 'cancel') {
      title.textContent = '取り消した';
      sub.textContent = '';
    } else {
      title.textContent = '救護';
      sub.textContent = '';
    }
    posEl.textContent = calling ? (pos ? `位置を本部に送っている（誤差 約${pos.acc}m）` : '位置はまだ取れていない（本部には名前で届く）') : '';
    cancelBtn.textContent = !calling ? '閉じる' : confirmCancel ? '本当に取り消す' : '押し間違い・取り消す';
    cancelBtn.classList.toggle('is-confirm', confirmCancel);
    closeBtn.hidden = !calling;
  };

  return {
    btn,
    sheet,
    active: live,
    update(me, ready, online) {
      server = me ?? null;
      btn.hidden = !ready;
      if (local && server?.cid === local.cid && (server.status === 'done' || server.status === 'cancel')) {
        // 本部が終わりにした：覚えておくのをやめる（板は開いていれば、そのまま「終わった」を見せる）
        local = null;
        save(null);
        stopWatch();
      }
      // 別のスマホ（同じ人）や前の開き直しで呼び出し中のときも、位置を送れるようにする
      if (!local && server && (server.status === 'open' || server.status === 'ack')) {
        local = { cid: server.cid, at: server.at };
        save(local);
      }
      if (local && ready && online) {
        const now = Date.now();
        const arrived = server?.cid === local.cid && (server.status === 'open' || server.status === 'ack');
        if (!arrived && now - lastSent > RESEND_MS) {
          if (deps.client.sos(true, local.cid, pos)) lastSent = now;
          startWatch();
        } else if (arrived && pos && now - lastPosSent > POS_EVERY_MS) {
          if (deps.client.sos(true, local.cid, pos)) lastPosSent = now;
        } else if (arrived) {
          startWatch();
        }
      }
      paint();
    },
  };
}
