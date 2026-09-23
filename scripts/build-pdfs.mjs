// Renders docs/whitepaper.html and docs/pitch-deck.html to PDFs in web/
// (served by PRED at /whitepaper.pdf and /pitch-deck.pdf).
//
//   npm run build:pdfs
//
// Needs Playwright + Chromium on the machine that builds them; the server
// itself stays dependency-free and only serves the committed PDFs.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const require = createRequire(import.meta.url);
    for (const dir of [process.env.NODE_GLOBAL_MODULES, '/opt/node22/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib/node_modules'].filter(Boolean)) {
      try {
        return require(path.join(dir, 'playwright'));
      } catch {}
    }
    throw new Error('Playwright not found — install it (npm i -g playwright) to build the PDFs');
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const docs = [
    { src: 'docs/whitepaper.html', out: 'web/whitepaper.pdf', opts: { format: 'A4' } },
    { src: 'docs/pitch-deck.html', out: 'web/pitch-deck.pdf', opts: { width: '1280px', height: '720px' } },
  ];
  for (const d of docs) {
    await page.goto(pathToFileURL(path.join(root, d.src)).href, { waitUntil: 'networkidle' });
    await page.pdf({ path: path.join(root, d.out), printBackground: true, preferCSSPageSize: true, ...d.opts });
    console.log(`✓ ${d.out}`);
  }
} finally {
  await browser.close();
}
