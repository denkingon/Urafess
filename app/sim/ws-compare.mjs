// 比較実験（作業用の機械の側）。node ws-compare.mjs <URL> <部屋> <本数> <分>
// ブラウザ側と同じ作り：参加して、30秒ごとに3回の問い合わせ。切れたら0.5〜1秒後につなぎ直す。
const [base, room, nArg, minArg] = process.argv.slice(2);
const N = Number(nArg ?? 50);
const MIN = Number(minArg ?? 5);
const url = `${base.replace(/^http/, 'ws')}/api/game/${room}/ws`;
const d = { started: Date.now(), opens: 0, closes: [], rtts: [], errors: [] };
let stopped = false;
const socks = [];

function open(i, seq) {
  const ws = new WebSocket(url);
  const rec = { i, seq, created: Date.now(), open: null, last: null, ws };
  socks.push(rec);
  let pid = 0;
  const sent = new Map();
  let timer = null;
  const burst = (n) => {
    for (let k = 0; k < n; k++)
      setTimeout(() => {
        if (ws.readyState === 1) {
          const id = ++pid;
          const a = Date.now();
          sent.set(id, a);
          ws.send(JSON.stringify({ t: 'ping', id, a }));
        }
      }, k * 120);
  };
  ws.onopen = () => {
    rec.open = Date.now();
    d.opens++;
    ws.send(JSON.stringify({ t: 'join', name: `us${i}` }));
    burst(3);
    timer = setInterval(() => burst(3), 30_000);
  };
  ws.onmessage = (ev) => {
    rec.last = Date.now();
    const s = String(ev.data);
    if (s.startsWith('{"t":"pong"')) {
      const m = JSON.parse(s);
      const a = sent.get(m.id);
      if (a !== undefined) {
        d.rtts.push(Date.now() - a);
        sent.delete(m.id);
      }
    }
  };
  ws.onerror = (ev) => d.errors.push({ i, t: Date.now(), msg: String(ev?.error?.message ?? ev?.message ?? 'error') });
  ws.onclose = (ev) => {
    if (timer) clearInterval(timer);
    if (stopped) return;
    d.closes.push({ i, seq, t: Date.now(), code: ev.code, reason: ev.reason, clean: ev.wasClean, age: rec.open ? Date.now() - rec.open : null, quiet: rec.last ? Date.now() - rec.last : null });
    setTimeout(() => open(i, seq + 1), 500 + Math.random() * 500);
  };
}

for (let i = 0; i < N; i++) setTimeout(() => open(i, 1), i * 40);
await new Promise((r) => setTimeout(r, MIN * 60_000));
stopped = true;
for (const s of socks) {
  try {
    s.ws.close();
  } catch {}
}
const r = [...d.rtts].sort((a, b) => a - b);
const at = (q) => r[Math.min(r.length - 1, Math.floor(q * r.length))];
const codes = {};
for (const c of d.closes) codes[c.code] = (codes[c.code] ?? 0) + 1;
const times = d.closes.map((c) => new Date(c.t).toLocaleTimeString('ja-JP', { hour12: false, timeZone: 'Asia/Tokyo' }));
const errs = {};
for (const e of d.errors) errs[e.msg] = (errs[e.msg] ?? 0) + 1;
console.log(JSON.stringify({ side: 'container', room, N, minutes: MIN, opens: d.opens, closes: d.closes.length, codes, closeTimes: times, errors: errs, rtt: { n: r.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: r[r.length - 1], over2s: r.filter((x) => x > 2000).length } }));
process.exit(0);
