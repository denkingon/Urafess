// ウェブ版を手元の Chrome で開いて、切りかえ・日付・再生・裏返し・ドラッグを押す。 mkdir -p /tmp/webshots && node tools/webtest.mjs
import { createRequire } from 'module';
const require = createRequire(process.env.NODE_MODULES || '/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errs = [];
async function open(w, h, hash) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, hasTouch: w < 500 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errs.push(w + ': ' + m.text()); });
  page.on('pageerror', (e) => errs.push(w + ' pageerror: ' + e.message));
  await page.goto('file://' + new URL('../web/index.html', import.meta.url).pathname + (hash || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  return page;
}
// desktop
let p = await open(1440, 900);
const info = async (page) => page.evaluate(() => ({
  spans: document.querySelectorAll('#board span').length, date: document.getElementById('bdate').textContent,
  holes: (document.getElementById('board').innerHTML.match(/\{\{/g) || []).length,
  stageW: document.getElementById('stage').style.width, stageH: document.getElementById('stage').style.height, zl: document.getElementById('zl').textContent,
  log: Array.from(document.querySelectorAll('#board span')).map((s) => s.textContent).filter((t) => /合流した|生まれた/.test(t)).slice(0, 3),
  sx: document.documentElement.scrollWidth > window.innerWidth,
}));
console.log('clock', JSON.stringify(await info(p)));
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/d-clock-top.png' });
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/d-clock-full.png', fullPage: true });
// 前の動きへ → 11/11、再生ボタン、帯
await p.click('#bprev'); await p.waitForTimeout(200);
console.log('after prev', (await info(p)).date);
await p.fill('#brange', '31'); await p.dispatchEvent('#brange', 'input'); await p.waitForTimeout(200);
console.log('range 31 →', (await info(p)).date, JSON.stringify((await info(p)).log));
// ボードの中の帯の印（11/06 の「6」）を押す
const tick = p.locator('#board button', { hasText: /^これから$/ }).first();
await tick.click(); await p.waitForTimeout(300);
console.log('tick これから →', (await info(p)).date);
// 裏へ
await p.fill('#brange', '36'); await p.dispatchEvent('#brange', 'input');
await p.evaluate(() => window.scrollTo(0, 0));
const ura = p.locator('#board button', { hasText: '裏' }).first();
await ura.click(); await p.waitForTimeout(1300);
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/d-clock-ura.png', fullPage: true });
// 再生
await p.click('#bplay'); await p.waitForTimeout(700);
const d1 = (await info(p)).date; await p.waitForTimeout(600); const d2 = (await info(p)).date;
await p.click('#bplay'); console.log('play', d1, '→', d2);
// のぼり
await p.click('#tab-flags'); await p.waitForTimeout(500);
console.log('flags', JSON.stringify(await info(p)), 'hash', await p.evaluate(() => location.hash));
await p.fill('#brange', '36'); await p.dispatchEvent('#brange', 'input'); await p.waitForTimeout(200);
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/d-flags-full.png', fullPage: true });
// 地面をドラッグ
const before = await p.evaluate(() => document.querySelector('#board svg path').getAttribute('d'));
await p.mouse.move(600, 500); await p.mouse.down(); await p.mouse.move(760, 520, { steps: 4 }); await p.mouse.up();
const after = await p.evaluate(() => document.querySelector('#board svg path').getAttribute('d'));
console.log('drag rotates', before !== after);
await p.click('#zin'); console.log('zoom in', (await info(p)).zl, 'x-scroll in wrap', await p.evaluate(() => document.getElementById('wrap').scrollWidth > document.getElementById('wrap').clientWidth), 'page x overflow', (await info(p)).sx);
await p.context().close();
// phone
p = await open(390, 844);
console.log('phone clock', JSON.stringify(await info(p)));
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/m-clock.png' });
await p.click('#zin'); await p.click('#zin'); await p.click('#zin'); await p.click('#zin'); await p.waitForTimeout(200);
await p.evaluate(() => { document.getElementById('wrap').scrollLeft = 230; window.scrollTo(0, 250); });
await p.screenshot({ path: (process.env.SHOTS || '/tmp/webshots') + '/m-clock-zoom.png' });
const hb = await p.evaluate(() => { const r = document.querySelector('.top').getBoundingClientRect(); return [r.width, r.height, document.documentElement.scrollWidth]; });
console.log('phone header', hb);
await p.context().close();
p = await open(390, 844, '#flags');
console.log('phone flags', JSON.stringify(await info(p)));
await p.context().close();
console.log('errors', JSON.stringify(errs.slice(0, 10)));
await browser.close();
