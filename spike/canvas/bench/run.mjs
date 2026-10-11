#!/usr/bin/env node
/**
 * AIS-5 benchmark driver.
 *
 * Drives the real spike app in headless Chromium and writes results/measurements.json
 * plus the screenshots the finding references. Every number in RESULTS.md comes from
 * this script; nothing is typed in by hand.
 *
 *   npm run build && npm run bench
 *
 * Flags:
 *   --sizes 50,500,2000,10000   node counts to measure
 *   --headed                    run with a visible browser (local debugging)
 *   --quick                     shorter frame windows, for iteration
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'results');
const PORT = 5273;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1680, height: 1050 };

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const QUICK = argv.includes('--quick');
const SIZES = argVal('sizes', '50,500,2000,10000').split(',').map(Number);
const FRAME_MS = QUICK ? 1200 : 2500;

function startServer() {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  return proc;
}

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite preview did not come up');
}

/** One configuration run. */
async function runCase(browser, { label, nodes, params }) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const qs = new URLSearchParams({ nodes: String(nodes), ...params }).toString();
  const t0 = Date.now();
  await page.goto(`${BASE}/?${qs}`, { waitUntil: 'domcontentloaded' });

  // "Interactive render" = the app has built the view and painted two frames.
  const ok = await page.evaluate(async () => {
    const deadline = Date.now() + 180_000;
    while (!window.__bench && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!window.__bench) return false;
    return window.__bench.settled(180_000);
  });
  const renderMs = Date.now() - t0;
  if (!ok) {
    await context.close();
    return { label, nodes, params, failed: 'view never settled', renderMs };
  }

  const snapshot = await page.evaluate(() => window.__bench.snapshot());
  const pan = await page.evaluate((ms) => window.__bench.panBench(ms), FRAME_MS);
  const zoom = await page.evaluate((ms) => window.__bench.zoomBench(ms), FRAME_MS);
  const select = await page.evaluate(() => window.__bench.selectBench(8));
  const afterSelect = await page.evaluate(() => window.__bench.snapshot());

  // occlusion: a node is selected by selectBench above; check the panel does not cover it
  const occlusion = await page.evaluate(() => window.__bench.occlusionCheck());

  await context.close();
  return {
    label,
    nodes,
    params,
    renderMs,
    snapshot,
    afterSelect,
    pan,
    zoom,
    select,
    occlusion,
    consoleErrors,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = startServer();
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
      headless: !argv.includes('--headed'),
    });
    const version = browser.version();

    const results = [];

    // ---- A: default product configuration (collapse + LOD + culling) --------------
    for (const nodes of SIZES) {
      console.log(`[bench] default @ ${nodes}`);
      results.push(
        await runCase(browser, {
          label: 'default (collapsed modules, LOD, culling)',
          nodes,
          params: { layout: 'grid-by-module', collapse: '1', lod: '1', culling: '1' },
        }),
      );
    }

    // ---- B: everything expanded, i.e. the naive full-graph render -----------------
    for (const nodes of SIZES) {
      console.log(`[bench] expanded-naive @ ${nodes}`);
      results.push(
        await runCase(browser, {
          label: 'expanded, no LOD, no culling (naive)',
          nodes,
          params: { layout: 'grid-by-module', collapse: '0', lod: '0', culling: '0' },
        }),
      );
    }

    // ---- C: ablations at the interesting size ------------------------------------
    const ABLATE = 2000;
    const ablations = [
      ['expanded + culling only', { collapse: '0', lod: '0', culling: '1' }],
      ['expanded + LOD only', { collapse: '0', lod: '1', culling: '0' }],
      ['expanded + culling + LOD', { collapse: '0', lod: '1', culling: '1' }],
      ['collapsed only', { collapse: '1', lod: '0', culling: '0' }],
    ];
    for (const [label, params] of ablations) {
      console.log(`[bench] ${label} @ ${ABLATE}`);
      results.push(
        await runCase(browser, {
          label,
          nodes: ABLATE,
          params: { layout: 'grid-by-module', ...params },
        }),
      );
    }

    // ---- D: layout algorithm comparison ------------------------------------------
    const layoutCtx = await browser.newContext({ viewport: VIEWPORT });
    const layoutPage = await layoutCtx.newPage();
    await layoutPage.goto(`${BASE}/?nodes=50`, { waitUntil: 'domcontentloaded' });
    await layoutPage.evaluate(async () => {
      const deadline = Date.now() + 60_000;
      while (!window.__bench && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return window.__bench.settled();
    });
    const layouts = [];
    for (const n of SIZES) {
      console.log(`[bench] layout algorithms @ ${n}`);
      layouts.push(
        await layoutPage.evaluate((count) => window.__bench.layoutBench(count), n),
      );
    }
    await layoutCtx.close();

    // ---- E: expand-one-module latency (incremental layout) ------------------------
    const incCtx = await browser.newContext({ viewport: VIEWPORT });
    const incPage = await incCtx.newPage();
    await incPage.goto(`${BASE}/?nodes=10000&collapse=1`, { waitUntil: 'domcontentloaded' });
    await incPage.evaluate(async () => {
      const deadline = Date.now() + 180_000;
      while (!window.__bench && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return window.__bench.settled(180_000);
    });
    const expandAll = await incPage.evaluate(() => window.__bench.toggleAllBench(false));
    const collapseAll = await incPage.evaluate(() => window.__bench.toggleAllBench(true));
    const expandOne = await incPage.evaluate(async () => {
      const t0 = performance.now();
      const proxy = document.querySelector('.dm-group--collapsed');
      proxy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await window.__bench.settled();
      return Number((performance.now() - t0).toFixed(1));
    });
    await incCtx.close();

    // ---- F: screenshots ----------------------------------------------------------
    const shots = [];
    const shot = async (name, nodes, params, steps) => {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const qs = new URLSearchParams({ nodes: String(nodes), ...params }).toString();
      await page.goto(`${BASE}/?${qs}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const deadline = Date.now() + 180_000;
        while (!window.__bench && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        return window.__bench.settled(180_000);
      });
      let meta = null;
      if (steps) meta = await steps(page);
      const file = join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      await ctx.close();
      shots.push({ name, file: `results/${name}.png`, nodes, params, meta });
      console.log(`[bench] screenshot ${name}`);
      return meta;
    };

    await shot('01-overview-10000-collapsed', 10000, {
      collapse: '1',
      layout: 'grid-by-module',
    });
    await shot('02-expanded-2000-light', 2000, { collapse: '0', layout: 'grid-by-module' });
    await shot('03-expanded-2000-dark', 2000, {
      collapse: '0',
      layout: 'grid-by-module',
      theme: 'dark',
    });

    // panel: select a node that sits under the panel's default position, then prove the
    // canvas moved it out from under the panel.
    const panelEvidence = await shot(
      '04-panel-non-occluding',
      2000,
      { collapse: '0', layout: 'grid-by-module' },
      async (page) => {
        return page.evaluate(async () => {
          const panel = document.querySelector('[data-testid="chat-panel"]');
          const pr = panel.getBoundingClientRect();
          // find a node whose rect currently intersects the panel
          const nodes = [...document.querySelectorAll('.react-flow__node[data-id]')];
          const under = nodes.find((el) => {
            const r = el.getBoundingClientRect();
            return r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top;
          });
          const before = under
            ? { id: under.getAttribute('data-id'), rect: under.getBoundingClientRect().toJSON() }
            : null;
          if (under) under.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 600));
          return { before, after: window.__bench.occlusionCheck() };
        });
      },
    );

    // panel moved + resized, keyboard only
    const panelKeyboard = await shot(
      '05-panel-moved-resized-keyboard',
      500,
      { collapse: '0', layout: 'grid-by-module' },
      async (page) => {
        await page.evaluate(() => {
          const n = document.querySelector('.react-flow__node[data-id]');
          n?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await page.waitForTimeout(300);
        const start = await page.evaluate(() =>
          document.querySelector('[data-testid="chat-panel"]').getBoundingClientRect().toJSON(),
        );
        // keyboard move: focus the move grip, press arrows
        await page.focus('[aria-label^="Move panel"]');
        for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
        // keyboard resize
        await page.focus('[data-testid="panel-resize-kbd"]');
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const end = await page.evaluate(() =>
          document.querySelector('[data-testid="chat-panel"]').getBoundingClientRect().toJSON(),
        );
        const occ = await page.evaluate(() => window.__bench.occlusionCheck());
        return { start, end, occlusionAfterKeyboardMove: occ };
      },
    );

    // keyboard traversal evidence
    const keyboardCtx = await browser.newContext({ viewport: VIEWPORT });
    const kbPage = await keyboardCtx.newPage();
    await kbPage.goto(`${BASE}/?nodes=2000&collapse=0`, { waitUntil: 'domcontentloaded' });
    await kbPage.evaluate(async () => {
      const deadline = Date.now() + 120_000;
      while (!window.__bench && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return window.__bench.settled(120_000);
    });
    // how many Tab stops before the canvas?
    const tabStops = await kbPage.evaluate(() => {
      const focusables = document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      return focusables.length;
    });
    await kbPage.focus('[data-testid="canvas"]');
    const traversal = [];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Enter']) {
      await kbPage.keyboard.press(key);
      await kbPage.waitForTimeout(260);
      traversal.push({
        key,
        announced: await kbPage.textContent('.dm-live'),
        focusRingVisible: (await kbPage.locator('[data-testid="focus-ring"]').count()) > 0,
      });
    }
    await kbPage.screenshot({ path: join(OUT, '06-keyboard-traversal.png') });
    shots.push({
      name: '06-keyboard-traversal',
      file: 'results/06-keyboard-traversal.png',
      nodes: 2000,
      params: { collapse: '0' },
      meta: null,
    });
    await keyboardCtx.close();

    const payload = {
      meta: {
        capturedAt: new Date().toISOString(),
        browser: version,
        playwright: (await import('playwright/package.json', { with: { type: 'json' } })).default
          .version,
        viewport: VIEWPORT,
        machine: {
          platform: `${platform()} ${release()} ${arch()}`,
          cpuModel: cpus()[0]?.model,
          cpuCount: cpus().length,
          totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
        },
        frameWindowMs: FRAME_MS,
        note: 'Headless Chromium on a cloud VM with no GPU. Frame rates are a floor, not a ceiling — a user on a GPU laptop sees better. The relative ordering between configurations is what the recommendation rests on.',
      },
      results,
      layouts,
      incremental: { expandAll, collapseAll, expandOneModuleMs: expandOne },
      panelEvidence,
      panelKeyboard,
      keyboard: { tabStopsBeforeCanvas: tabStops, traversal },
      screenshots: shots,
    };

    await writeFile(join(OUT, 'measurements.json'), JSON.stringify(payload, null, 2));
    console.log(`\n[bench] wrote ${join(OUT, 'measurements.json')}`);

    // console summary
    for (const r of results) {
      if (r.failed) {
        console.log(`${r.label} @ ${r.nodes}: FAILED (${r.failed}) after ${r.renderMs}ms`);
        continue;
      }
      console.log(
        `${String(r.nodes).padStart(6)} | ${r.label.padEnd(42)} | render ${String(
          r.renderMs,
        ).padStart(6)}ms | dom ${String(r.snapshot.domNodes).padStart(5)}n/${String(
          r.snapshot.domEdges,
        ).padStart(6)}e | pan ${String(r.pan.fps).padStart(5)}fps | zoom ${String(
          r.zoom.fps,
        ).padStart(5)}fps | select p95 ${String(r.select?.p95Ms ?? '-').padStart(7)}ms`,
      );
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
