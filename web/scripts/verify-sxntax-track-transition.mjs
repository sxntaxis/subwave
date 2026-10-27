// Browser regression for the skip/refresh recording. Run against an ISOLATED
// web server: all station APIs, covers and media are intercepted by fixtures.
// PLAYWRIGHT_MODULE can point at an external temporary install's index.mjs.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.WEB || 'http://127.0.0.1:7788';
const output = process.env.OUTPUT_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader'] });
try {
  for (const viewport of [{ width: 520, height: 720 }, { width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      HTMLMediaElement.prototype.load = function () {};
      HTMLMediaElement.prototype.play = function () {
        queueMicrotask(() => this.dispatchEvent(new Event('playing')));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {};
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let current = { subsonic_id: 'old', title: 'Get Down Saturday Night (Special Extended Version)', artist: 'Oliver Cheatham', album: 'Saturday Night', duration: 360 };
    let startedAt = Date.now() - 60000;
    let failMetadata = false;
    const fixtureContext = { time: { show: 'Funkplay', vibe: 'Lunch hour' }, dominantMood: 'bright' };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('/cover/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#777"/></svg>' });
      if (path.endsWith('/now-playing')) {
        if (failMetadata) return route.fulfill({ status: 503, json: { error: 'temporary outage' } });
        return route.fulfill({ json: { nowPlaying: current, context: fixtureContext, dj: { name: 'sxntax', station: 'The Lab' }, streamOnline: true, stream: { bufferSeconds: 0, bitrate: 320 }, timezone: 'America/Costa_Rica' } });
      }
      if (path.endsWith('/state')) return route.fulfill({ json: { current: { ...current, startedAt: new Date(startedAt).toISOString() }, playbackTiming: { startedAt, pausedAt: null }, upcoming: [], history: [], djLog: [], airMessages: [], ui: { skin: 'sxntax', tuneInOverlay: true } } });
      if (path.endsWith('/session')) return route.fulfill({ json: { session: null, messages: [] } });
      if (path.endsWith('/like')) return route.fulfill({ json: { enabled: false } });
      if (path.endsWith('/onboarding/status')) return route.fulfill({ json: { needsSetup: false } });
      if (path.endsWith('/themes')) return route.fulfill({ json: { themes: [] } });
      return route.fulfill({ json: {} });
    });
    await page.route('**/stream.mp3*', route => route.abort());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-phosphor-text]')?.textContent.includes('Get Down'));
    await page.locator('[class*="tunePrompt"]').click();
    await page.waitForTimeout(3000);
    current = { ...current, subsonic_id: 'new', title: 'Mayonaka No Door ~Stay with Me (2008 Remastered)', artist: 'Miki Matsubara', album: 'Pocket Park (2008 Remastered)' };
    startedAt = Date.now() - 10000;
    let bridgeSeen = false;
    const samples = [];
    const until = Date.now() + 14000;
    while (Date.now() < until) {
      const layout = await page.evaluate(() => {
        const hero = document.querySelector('section[aria-label="Now playing"]');
        const cover = hero?.querySelector('figure');
        const plate = cover?.getBoundingClientRect();
        const layers = [...hero?.querySelectorAll('[class*="bridgeTextLayer"]') ?? []].filter(node => Number(getComputedStyle(node).opacity) > .08);
        return {
          layers: layers.map(node => ({ top: node.getBoundingClientRect().top, title: node.textContent })),
          coverBottom: plate?.bottom,
          active: Boolean(hero?.querySelector('[class*="identityBridge"]')),
        };
      });
      bridgeSeen ||= layout.active;
      if (viewport.height > viewport.width && layout.coverBottom != null) {
        for (const layer of layout.layers) assert.ok(layer.top >= layout.coverBottom - 1, `portrait bridge overlapped art: ${JSON.stringify(layout)}`);
      }
      samples.push(layout);
      await page.waitForTimeout(100);
    }
    assert.ok(bridgeSeen, 'the real animated handoff must run');
    await page.waitForFunction(() => document.querySelector('[data-phosphor-text]')?.textContent.includes('Mayonaka'));
    if (output) await page.screenshot({ path: `${output}/portrait-${viewport.width}-settled.png` });
    failMetadata = true;
    await page.waitForTimeout(6000);
    assert.ok((await page.locator('[data-phosphor-text]').first().textContent()).includes('Mayonaka'), 'HTTP failure erased the song');
    failMetadata = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-phosphor-text]')?.textContent.includes('Mayonaka'));
    assert.equal(await page.locator('[class*="identityBridge"]').count(), 0, 'first metadata must not animate from a placeholder');
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}×${viewport.height}: animated skip, portrait artwork separation, transient-error retention and refresh (${samples.length} frames)`);
    await context.close();
  }
} finally { await browser.close(); }
