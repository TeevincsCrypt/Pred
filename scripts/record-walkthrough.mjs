// Records a silent screen walkthrough of PRED (1920×1080) for the demo video.
// Add your voice-over afterwards following docs/demo-video-script.md.
//
//   node scripts/record-walkthrough.mjs https://your-pred.up.railway.app          live dashboard
//   node scripts/record-walkthrough.mjs https://your-pred.up.railway.app --demo   simulated demo (/demo)
//
// Output: recordings/pred-walkthrough-<live|demo>.webm (and .mp4 when ffmpeg is on PATH).
// Needs Playwright:  npm i -g playwright  &&  npx playwright install chromium
//
// Read-only: it only views pages and clicks through the feed or the simulated
// demo. It never logs in and never touches trade approval or execution.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const base = (args.find((a) => /^https?:\/\//.test(a)) || process.env.PRED_URL || 'http://localhost:3000').replace(/\/$/, '');
const W = 1920;
const H = 1080;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const require = createRequire(import.meta.url);
    for (const dir of [process.env.NODE_GLOBAL_MODULES, '/opt/node22/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules', process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules')].filter(Boolean)) {
      try {
        return require(path.join(dir, 'playwright'));
      } catch {}
    }
    throw new Error('Playwright not found. Install it with: npm i -g playwright && npx playwright install chromium');
  }
}

// Headless Chromium draws no mouse pointer, so draw one that follows the mouse.
const CURSOR = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;transition:transform .08s;' +
      'background:url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\'><path d=\\'M3 2l7 19 2.5-7.5L20 11z\\' fill=\\'#111\\' stroke=\\'#fff\\' stroke-width=\\'1.5\\'/></svg>') + '") no-repeat';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
    addEventListener('mousedown', () => (c.style.transform = 'scale(.8)'));
    addEventListener('mouseup', () => (c.style.transform = ''));
  });`;

const { chromium } = await loadPlaywright();
const outDir = path.join(root, 'recordings');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } } });
await context.addInitScript(CURSOR);
const page = await context.newPage();
const video = page.video();

const wait = (ms) => page.waitForTimeout(ms);
let mouse = { x: W / 2, y: H / 2 };
async function moveTo(x, y) {
  await page.mouse.move(x, y, { steps: 30 });
  mouse = { x, y };
}
async function clickEl(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return false;
  await moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await wait(350);
  await locator.click();
  return true;
}
// Smooth scroll so a section's top sits just under the header.
async function scrollToEl(selector, offset = 90) {
  await page.evaluate(
    ([sel, off]) => {
      const el = document.querySelector(sel);
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth' });
    },
    [selector, offset],
  );
  await wait(1200);
}
async function scrollBy(dy, ms = 1500) {
  await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
  await wait(ms);
}
async function caption(text, ms) {
  await page.evaluate((t) => {
    let el = document.getElementById('__caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483646;background:rgba(14,15,31,.88);color:#fff;font:600 22px/1.3 system-ui,sans-serif;padding:12px 22px;border-radius:12px;pointer-events:none;max-width:80%;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  }, text);
  if (ms) await wait(ms);
}

const t0 = Date.now();
const mark = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${s}`);

// 1. Landing page (~0:00–0:35)
mark('landing');
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await moveTo(W * 0.3, H * 0.45);
await wait(5000);
await scrollToEl('#how', 70);
await wait(3500);
await scrollBy(700, 2200);
await wait(2500);
await scrollBy(700, 2200);
await wait(2500);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await wait(1500);
const cta = page.locator(demo ? '#demoCta' : 'a[href="/app"]').first();
if (await cta.isVisible()) await clickEl(cta);
const want = demo ? '/demo' : '/app';
if (!new URL(page.url()).pathname.startsWith(want)) await page.goto(`${base}${want}`, { waitUntil: 'domcontentloaded' });

await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('#connList');
await wait(1500);

if (!demo) {
  // 2. Live dashboard (~0:35–0:55)
  mark('live dashboard');
  const conn = page.locator('#connBox');
  if (await conn.isVisible()) await moveTo(160, 360);
  await wait(4000);
  const strip = page.locator('#assetStrip');
  if (await strip.isVisible()) {
    const b = await strip.boundingBox();
    await moveTo(b.x + 200, b.y + b.height / 2);
    await moveTo(b.x + b.width - 200, b.y + b.height / 2);
  }
  await wait(3000);

  // 3. A Ghost Event (~0:55–1:35): prefer a resolved one
  mark('ghost event');
  const items = page.locator('#eventList .ev-item');
  const n = await items.count();
  let pick = null;
  for (let i = 0; i < n && !pick; i++) if (/CONFIRMED|RESOLVED/.test(await items.nth(i).innerText())) pick = items.nth(i);
  if (!pick && n) pick = items.first();
  if (pick) await clickEl(pick);
  await wait(3000);
  await scrollToEl('#overview');
  await wait(5000);
  await scrollToEl('#graph-sec');
  await wait(6000);
  await scrollToEl('#hyp-sec');
  await wait(7000);
  await scrollBy(500);
  await wait(4000);
  await scrollToEl('#timeline-sec');
  await wait(6000);

  // 4. Resolution + memory (~1:35–1:55)
  mark('reaction + memory');
  await scrollToEl('#reaction-sec');
  await wait(5000);
  await scrollToEl('#memory-sec');
  await wait(8000);
} else {
  // 2–4. Simulated demo, one step at a time (~0:35–1:55)
  mark('simulated demo');
  await caption('Simulated demo: scripted scenario, not live market data', 4000);
  await caption('');
  const panelFor = { 3: '#overview', 5: '#graph-sec', 7: '#hyp-sec', 9: '#timeline-sec', 10: '#timeline-sec', 11: '#overview', 12: '#reaction-sec', 14: '#memory-sec' };
  const next = page.locator('#btnNext');
  for (let step = 1; step <= 30; step++) {
    await page.waitForFunction(() => {
      const b = document.getElementById('btnNext');
      return !b.disabled || b.textContent === 'Complete';
    }, null, { timeout: 90_000 });
    if ((await next.textContent()).trim() === 'Complete') break;
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await wait(700);
    await clickEl(next);
    mark(`demo step ${step}`);
    await wait(1800);
    if (panelFor[step]) await scrollToEl(panelFor[step]);
    await wait(step === 7 || step === 14 ? 5000 : 2500);
  }
}

// 5. Trade panel (~1:55–2:15): shown only; no login, no approval, no execution
mark('trade panel');
await page.evaluate(() => {
  const t = document.getElementById('trade-sec');
  if (!t) return;
  window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3, behavior: 'smooth' });
  t.style.transition = 'box-shadow .4s';
  t.style.boxShadow = '0 0 0 4px #3b3ff0, 0 12px 40px rgba(59,63,240,.25)';
});
await wait(1500);
const trade = page.locator('#trade-sec');
if (await trade.isVisible()) {
  const b = await trade.boundingBox();
  await moveTo(b.x + b.width * 0.4, b.y + 50);
}
await caption('Agents cannot trade. Every order needs explicit human approval.', 9000);
await caption('');
await page.evaluate(() => { const t = document.getElementById('trade-sec'); if (t) t.style.boxShadow = ''; });

// 6. Closing (~2:15–2:30)
mark('closing');
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => document.querySelector('.cta')?.scrollIntoView({ block: 'center' }));
await wait(1000);
await moveTo(W / 2, H / 2 + 40);
await wait(8000);

await context.close();
await browser.close();

const name = `pred-walkthrough-${demo ? 'demo' : 'live'}`;
const webm = path.join(outDir, `${name}.webm`);
fs.renameSync(await video.path(), webm);
mark(`saved ${path.relative(root, webm)}`);

// Optional MP4 (YouTube and Clipchamp also accept the WebM as is).
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', webm.replace(/\.webm$/, '.mp4')], { stdio: 'inherit' });
if (ff.status === 0) mark(`saved ${path.relative(root, webm.replace(/\.webm$/, '.mp4'))}`);
else console.log('ffmpeg not found: kept the .webm (upload it as is, or convert it in Clipchamp).');
