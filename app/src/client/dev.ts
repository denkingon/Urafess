/**
 * デバッグ台（/debug）の中に並べるスマホ1台ぶんの「にせもの」。参加者の画面（/?g=部屋&dev=番号）にだけ効く。
 *
 * - 覚えておく値（localStorage・sessionStorage）を番号ごとに分ける：同じブラウザの中で、台ごとに別の参加者になる
 * - 位置：本物の GPS の代わりに、デバッグ台の地図で動かした点を返す（1秒ごと）
 * - 動き：「走る」の間は、走っているときの揺れ（1秒に約2.8歩）を作って流す。止まっている間は静かな値を流す
 * - 本番の部屋（main）では何もしない（?g= が無い・main のときは効かない）
 *
 * デバッグ台とは postMessage で話す（同じ出どころからのものだけ受ける）：
 *   { t: 'dev-pos', lat, lon } 位置を動かす／{ t: 'dev-run', on } 走る・止まる
 * こちらからは { t: 'dev-hello', slot } を1回だけ送る（つながった合図）
 */

const params = new URLSearchParams(location.search);
const raw = params.get('dev');
const room = params.get('g');
const isPlayerPage = location.pathname.replace(/\/+$/, '') === '';

/** デバッグ台のスマホの番号（1〜24）。デバッグ台の中でなければ null */
export const devSlot: number | null =
  raw && /^\d{1,2}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 24 && room && room !== 'main' && isPlayerPage ? Number(raw) : null;

/** SFC のまんなか（デバッグ台が位置を送る前の場所。番号ごとに少しずらす） */
const CENTER = { lat: 35.3880, lon: 139.4276 };

if (devSlot !== null) installDev(devSlot);

function installDev(slot: number): void {
  // ---------- 覚えておく値を台ごとに分ける ----------
  const pre = `urafess:dev${slot}:`;
  const P = Storage.prototype;
  const get = P.getItem;
  const set = P.setItem;
  const rem = P.removeItem;
  P.getItem = function (this: Storage, k: string) {
    return get.call(this, pre + k);
  };
  P.setItem = function (this: Storage, k: string, v: string) {
    set.call(this, pre + k, v);
  };
  P.removeItem = function (this: Storage, k: string) {
    rem.call(this, pre + k);
  };

  // ---------- 位置 ----------
  const ang = (slot * 137.5 * Math.PI) / 180;
  let pos = {
    lat: Number(params.get('lat')) || CENTER.lat + Math.sin(ang) * 0.0004 * Math.sqrt(slot),
    lon: Number(params.get('lon')) || CENTER.lon + Math.cos(ang) * 0.0005 * Math.sqrt(slot),
  };
  let running = false;
  let lastPos = { ...pos, at: Date.now() };
  let speed = 0;
  const watchers = new Map<number, PositionCallback>();
  let nextId = 1;
  const fixNow = (): GeolocationPosition => {
    const coords = {
      latitude: pos.lat,
      longitude: pos.lon,
      accuracy: 6,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: running ? Math.max(speed, 3) : speed,
    };
    return { coords: { ...coords, toJSON: () => coords }, timestamp: Date.now(), toJSON: () => ({ coords, timestamp: Date.now() }) } as GeolocationPosition;
  };
  const fire = () => {
    const f = fixNow();
    for (const cb of watchers.values()) cb(f);
  };
  const geo = {
    watchPosition(ok: PositionCallback): number {
      const id = nextId++;
      watchers.set(id, ok);
      setTimeout(() => watchers.get(id)?.(fixNow()), 200);
      return id;
    },
    getCurrentPosition(ok: PositionCallback): void {
      setTimeout(() => ok(fixNow()), 200);
    },
    clearWatch(id: number): void {
      watchers.delete(id);
    },
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  setInterval(fire, 1000);

  // 許可の問い合わせ：位置はいつも「許可ずみ」
  const perms = navigator.permissions;
  if (perms?.query) {
    const q = perms.query.bind(perms);
    perms.query = ((d: PermissionDescriptor) =>
      d?.name === 'geolocation' ? Promise.resolve({ state: 'granted', onchange: null } as unknown as PermissionStatus) : q(d)) as typeof perms.query;
  }

  // ---------- 動き ----------
  // iPhone と同じく「押して許可」の流れを通す：確認は出さず、いつも許可にする（PC の Chrome は断ってくることがある）
  for (const ctor of [window.DeviceMotionEvent, window.DeviceOrientationEvent] as unknown[]) {
    if (ctor) Object.defineProperty(ctor, 'requestPermission', { value: () => Promise.resolve('granted'), configurable: true });
  }
  // 走るとき：重力（9.8）に、1秒に約2.8回の強い山（〜22）を重ねる。止まっているとき：9.8 のまま
  const t0 = performance.now();
  setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const bump = running ? Math.max(0, Math.sin(2 * Math.PI * 2.8 * t)) ** 2 * 13 : 0;
    const z = 9.8 + bump;
    const e = new Event('devicemotion') as DeviceMotionEvent;
    Object.defineProperty(e, 'accelerationIncludingGravity', { value: { x: 0.2, y: 0.1, z } });
    Object.defineProperty(e, 'acceleration', { value: { x: 0, y: 0, z: bump } });
    Object.defineProperty(e, 'interval', { value: 20 });
    window.dispatchEvent(e);
  }, 20);

  // ---------- デバッグ台から ----------
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data as { t?: string; lat?: number; lon?: number; on?: boolean } | null;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'dev-pos' && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
      const now = Date.now();
      const dist = Math.hypot((d.lat! - lastPos.lat) * 111_000, (d.lon! - lastPos.lon) * 91_000);
      speed = now > lastPos.at ? Math.min(8, dist / ((now - lastPos.at) / 1000)) : 0;
      pos = { lat: d.lat!, lon: d.lon! };
      lastPos = { ...pos, at: now };
      fire();
    } else if (d.t === 'dev-run') {
      running = !!d.on;
      if (!running) speed = 0;
    }
  });
  window.parent?.postMessage({ t: 'dev-hello', slot }, location.origin);
  document.documentElement.dataset.dev = String(slot);
}
