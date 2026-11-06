import './styles.css';
import { connectingView, participantView } from '../shared/viewmodel';
import { GameClient, type KeyValueStore } from './core/game-client';
import { detectInstall, lineEscapeUrl, type InstallPath } from './install/detect';
import { getCodec } from './sound/codec';
import { SoundEmitter } from './sound/emitter';
import { SoundListener } from './sound/listener';
import { createCapture } from './views/capture';
import { createHost } from './views/host';
import { createInstall, type InstallScreen } from './views/install';
import { createJoin } from './views/join';
import { createLab } from './views/lab';
import { createPhone } from './views/phone';
import { createScreenKeeper } from './wake-lock';

// ---------- しくみの用意 ----------

const params = new URLSearchParams(location.search);
const gameId = (params.get('g') ?? 'main').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'main';
const route = location.pathname.replace(/\/+$/, '');
const isHost = route === '/host';
const isLab = route === '/lab';
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/game/${gameId}/ws`;

const storage: KeyValueStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
};

const root = document.getElementById('app')!;

/** 試合中（配役〜タイマー）は画面を消さない */
const screenKeeper = createScreenKeeper();
const inMatch = (stage: string | undefined) => stage === 'assigned' || stage === 'timer';

if (isLab) {
  startLab();
} else if (isHost) {
  // 主催者用の合言葉は URL の ?token= で一度渡せば、この端末に覚えさせて URL からは消す
  const fromUrl = params.get('token');
  if (fromUrl) {
    storage.set('urafess:host-token', fromUrl);
    params.delete('token');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  const token = storage.get('urafess:host-token');
  if (!token) showTokenForm();
  else startHost(token);
} else {
  const path = installPath();
  if (path === 'line' && escapeLine()) {
    // LINE が外のブラウザで開き直す。この画面はこのまま閉じられる
  } else if (path) {
    showInstall(path);
  } else {
    startPlayer();
  }
}

registerServiceWorker();

// ---------- 置き方の案内 ----------

/**
 * ブラウザで開いた人には、入室の前にホーム画面への置き方を見せる（つなぐのは置いたあと＝アプリから開いたとき）。
 * 出さないとき：ホーム画面のアプリ・パソコン・試し部屋（?g=）・この画面で一度「このまま」を選んだあと
 */
function installPath(): Exclude<InstallPath, 'installed' | 'desktop'> | null {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const path = detectInstall({ ua: navigator.userAgent, standalone, maxTouchPoints: navigator.maxTouchPoints || 0 });
  // LINE から外のブラウザへ開き直したあとは、目印の ?openExternalBrowser=1 を URL から消す（ホーム画面に置く URL に残さない）
  if (path !== 'line' && params.has('openExternalBrowser')) {
    params.delete('openExternalBrowser');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  if (path === 'installed' || path === 'desktop') return null;
  if (params.has('g')) return null;
  if (sessionGet('urafess:install-skip')) return null;
  return path;
}

function escapeLine(): boolean {
  const to = lineEscapeUrl(location.href);
  if (!to) return false; // 付けて開き直したのに LINE の中のまま → 右上のメニューからの案内を出す
  location.replace(to);
  return true;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function showInstall(path: Exclude<InstallPath, 'installed' | 'desktop'>): void {
  let screen: InstallScreen | null = createInstall({
    path,
    icon: '/apple-touch-icon.png',
    onSkip: () => {
      sessionSet('urafess:install-skip', '1');
      screen?.stop();
      screen = null;
      startPlayer();
    },
  });
  root.replaceChildren(screen.el);
  // Android の Chrome：ボタン1つで入れられるようになったら、手順の代わりにボタンを出す
  window.addEventListener('beforeinstallprompt', (e) => {
    if (!screen) return; // 案内を閉じたあとは、ブラウザの出す帯に任せる
    e.preventDefault();
    const ev = e as BeforeInstallPromptEvent;
    screen.setPrompt(async () => {
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      return outcome === 'accepted';
    });
  });
  window.addEventListener('appinstalled', () => screen?.done());
}

function sessionGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function sessionSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    // 使えない端末では、次に開いたときにまた案内が出るだけ
  }
}

// ---------- 参加者 ----------

function startPlayer(): void {
  const client = makeClient({ kind: 'player' });
  startUpdateChecks(() => !(client.state.phase === 'ready' && inMatch(client.state.game?.stage)));
  const join = createJoin((name) => client.join(name));
  const phone = createPhone();
  // 捕獲：逃走者のスマホは長押しの間3桁を鳴らし、鬼のスマホはマイクで聞く
  const emitter = new SoundEmitter();
  const listener = new SoundListener();
  const capture = createCapture({ client, emitter, listener });
  phone.slot.append(capture.el);
  // 音は「画面に触れた直後」にしか出させてもらえない。長押しより前のタップで一度準備しておく
  const unlock = () => {
    emitter.unlock();
    listener.unlock();
  };
  document.addEventListener('pointerup', unlock, { capture: true, passive: true });
  document.addEventListener('click', unlock, { capture: true, passive: true });
  let preparedCode: string | null = null;
  // 試験用（?debug=1 で、本番の部屋 main 以外のときだけ）：ヘッドレスのブラウザから音の波形を取り出して、もう一方の偽マイクに流すため
  if (params.get('debug') === '1' && (gameId !== 'main' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    (window as unknown as { __urafess?: unknown }).__urafess = {
      client,
      emitter,
      listener,
      wavBase64: async (code: string) => {
        const url = await emitter.prepare(code);
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      },
    };
  }
  let shown: HTMLElement | null = null;
  const show = (el: HTMLElement) => {
    if (shown !== el) {
      root.replaceChildren(el);
      shown = el;
    }
  };

  loop(() => {
    const s = client.state;
    screenKeeper.set(s.phase === 'ready' && inMatch(s.game?.stage));
    if (s.phase === 'need-name' || s.phase === 'joining') {
      show(join.el);
      join.update({ busy: s.phase === 'joining', error: s.joinError });
      return;
    }
    if (s.phase !== 'ready' || !s.game || !s.me) {
      show(phone.el);
      phone.update(connectingView(s.online));
      return;
    }
    show(phone.el);
    const view = participantView(s.game, s.me, client.serverNow() ?? Date.now(), s.online);
    phone.update(view);
    capture.update(view, s);
    // 配役が出たら、音の部品を読み込み、自分の3桁の音を前もって作っておく（長押しの瞬間に間に合うように）
    if (s.me.code && s.me.code !== preparedCode) {
      preparedCode = s.me.code;
      void getCodec()
        .then(() => emitter.prepare(s.me!.code!))
        .catch(() => undefined);
    }
  });
}

// ---------- 音の試し（/lab） ----------

function startLab(): void {
  const emitter = new SoundEmitter();
  const listener = new SoundListener();
  const unlock = () => {
    emitter.unlock();
    listener.unlock();
  };
  document.addEventListener('pointerup', unlock, { capture: true, passive: true });
  document.addEventListener('click', unlock, { capture: true, passive: true });
  void getCodec().catch(() => undefined);
  // 試験用（?debug=1）：ヘッドレスのブラウザからマイクの様子を読むため。/lab はサーバーも部屋も使わない
  if (params.get('debug') === '1') (window as unknown as { __urafessLab?: unknown }).__urafessLab = { emitter, listener };
  root.replaceChildren(createLab(emitter, listener));
}

// ---------- 主催者 ----------

function startHost(token: string): void {
  const client = makeClient({ kind: 'host', token });
  startUpdateChecks(() => !inMatch(client.state.game?.stage));
  const host = createHost({
    command: (op, extra) => client.command(op, extra),
    downloadLog: async () => {
      const res = await fetch(`/api/game/${gameId}/log`, { headers: { 'x-host-token': token }, cache: 'no-store' });
      if (!res.ok) throw new Error(`log ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `urafess-${gameId}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  root.replaceChildren(host.el);
  loop(() => {
    const s = client.state;
    screenKeeper.set(inMatch(s.game?.stage));
    if (s.phase === 'denied') {
      screenKeeper.set(false);
      storage.remove('urafess:host-token');
      showTokenForm('合言葉が違う。');
      return false;
    }
    host.update({
      game: s.game,
      host: s.host,
      serverNow: client.serverNow() ?? Date.now(),
      online: s.online,
      lastReject: s.lastReject,
    });
  });
}

function showTokenForm(error?: string): void {
  const el = document.createElement('main');
  el.className = 'phone join';
  el.innerHTML = `
    <h1>主催者</h1>
    <form>
      <label for="token">主催者用の合言葉</label>
      <input id="token" type="password" autocomplete="off" required>
      <p class="error" ${error ? '' : 'hidden'}>${error ?? ''}</p>
      <button type="submit">入る</button>
    </form>`;
  el.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = (el.querySelector('input') as HTMLInputElement).value.trim();
    if (!value) return;
    storage.set('urafess:host-token', value);
    location.reload();
  });
  root.replaceChildren(el);
}

// ---------- 共通 ----------

function makeClient(mode: ConstructorParameters<typeof GameClient>[1]): GameClient {
  const client = new GameClient(
    { url: wsUrl, gameId, createSocket: (u) => new WebSocket(u), now: () => Date.now(), storage },
    mode,
  );
  client.start();
  // 画面に戻った・電波が戻った・ページが復元された → すぐにつなぎ直し、時計を測り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') client.wake();
  });
  window.addEventListener('online', () => client.wake());
  window.addEventListener('pageshow', () => client.wake());
  // スマホの時計が飛んだら（手で時刻を変えた等）測り直す
  let base = Date.now() - performance.now();
  setInterval(() => {
    const b = Date.now() - performance.now();
    if (Math.abs(b - base) > 1000) client.resetClock();
    base = b;
  }, 1000);
  return client;
}

/** 表示は数えず、毎フレーム「今の状態」から描き直す。false を返すと止まる */
function loop(render: () => void | false): void {
  const frame = () => {
    if (render() === false) return;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // 画面が裏にある間は requestAnimationFrame が止まるが、戻った瞬間に正しい値で描き直す
}

/**
 * 新しい版が公開されていたら、試合中でないときに読み込み直す。
 * Service Worker は保存しておいた画面を先に返すので、何もしないと公開後に1回目に開いたときは古い版のまま動く。
 * - 新しい Service Worker に切り替わったとき（sw.js が変わった公開）
 * - 開いたとき・画面に戻ったとき（最大1分に1回）、保存していない最新の index.html と、今動いている画面の版を比べる
 * 試合中（配役〜タイマー）は読み込み直さない。同じ版のために2回は読み込み直さない（読み込みが回り続けないように）
 */
function startUpdateChecks(idle: () => boolean): void {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
  const running = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
  const reloadIfIdle = (version: string) => {
    if (!idle()) return;
    try {
      if (sessionStorage.getItem('urafess:reloaded-for') === version) return;
      sessionStorage.setItem('urafess:reloaded-for', version);
    } catch {
      // 保存できない端末でも読み込み直す
    }
    location.reload();
  };
  // 初めて開いたとき（まだ Service Worker が無かった）の切り替わりでは読み込み直さない。入室の途中で画面が消えないように
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadIfIdle('sw');
  });
  let lastCheck = 0;
  const check = async () => {
    if (!running || !navigator.serviceWorker.controller || !navigator.onLine || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    try {
      const res = await fetch('/index.html', { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const latest = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? /<script[^>]*src="([^"]+)"[^>]*type="module"/.exec(html)?.[1];
      if (!latest || latest === running) return;
      // 保存してある画面を新しいものに差し替えてから読み込み直す（保存場所の名前は sw.js が版ごとに変えるので、名前を決め打ちしない）
      const names = (await caches.keys()).filter((k) => k.startsWith('urafess-'));
      await Promise.all(
        names.map(async (n) =>
          (await caches.open(n)).put('/index.html', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
        ),
      );
      reloadIfIdle(latest);
    } catch {
      // 通信が無い。次に画面に戻ったときにまた確かめる
    }
  };
  window.addEventListener('load', () => void check());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  // 待合室で開きっぱなしの画面も、ときどき確かめる
  setInterval(() => {
    if (idle()) void check();
  }, 5 * 60_000);
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 使えない端末でも、通信があれば普通に動く
    });
  });
}
