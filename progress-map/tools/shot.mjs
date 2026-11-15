// ウェブ版の夜の時計を1枚撮る。 node tools/shot.mjs 出力.png [ねじり] [ura] [日付の位置]
import { createRequire } from 'module';
const require = createRequire(process.env.NODE_MODULES || '/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [out, tw, side, t] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1720, height: 1560 } });
await page.goto('file://' + new URL('../web/index.html', import.meta.url).pathname);
await page.waitForTimeout(600);
if (tw !== undefined && tw !== '') { await page.fill('#twist', tw); await page.dispatchEvent('#twist', 'input'); }
if (t) { await page.fill('#brange', t); await page.dispatchEvent('#brange', 'input'); }
if (side === 'ura') { await page.locator('#board button', { hasText: '裏' }).first().click(); await page.waitForTimeout(1300); }
await page.addStyleTag({ content: '.bar,.top{display:none !important} #wrap{padding:0 !important}' });
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await page.waitForTimeout(300);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1720, height: 1470 } });
await browser.close();
