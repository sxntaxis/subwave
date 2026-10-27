// Verify against an isolated production web image. Every station API and media
// request is fixture-owned; this script never writes to the real station.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.WEB || 'http://127.0.0.1:7788';
const output = process.env.OUTPUT_DIR;
const fixtureTime = new Date('2026-10-22T03:00:00Z'); // Wednesday 21:00 in the station zone
if (output) await mkdir(output, { recursive: true });
let browser;

const showNames = ['Night Transmission', 'Natural Mystic', 'Funkplay', 'Evening Frequencies', 'Atmospheres'];
const shows = showNames.map((name, i) => ({ id: `show-${i}`, name, topic: name === 'Atmospheres' ? 'Ambient, downtempo and drone as patient deep-night listening. Prioritise space, texture, sustained development and low-friction sequencing; rotate between beatless and gently rhythmic material without drifting into ordinary club music.' : `${name}: records selected for the hour, with space for unexpected connections, rhythmic detail, mood shifts, and the stories that tie each selection to the next. `.repeat(4), moods: [], mood: '', personaId: 'host' }));
const programme = {
  timezone: 'America/Costa_Rica', locale: 'en-GB',
  personas: [{ id: 'host', name: 'sxntax', avatar: '' }], shows,
  schedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array.from({ length: 24 }, (_, hour) => hour === 3 || hour === 4 ? 'show-4' : `show-${hour < 18 ? Math.floor(hour / 6) : (hour - 18) % 4}`)])),
  override: null,
};

async function verifyExpandPushesRows(dialog, card) {
  assert.equal(await card.getAttribute('aria-expanded'), 'false');
  const before = await card.evaluate(node => {
    const grid = node.parentElement.parentElement;
    const row = grid.querySelector('[data-hour-rail] [data-hour="21"]');
    return { gridHeight: grid.clientHeight, rowHeight: row.getBoundingClientRect().height };
  });
  await card.click({ force: true });
  assert.equal(await card.getAttribute('aria-expanded'), 'true');
  assert.equal(await dialog.locator('[class*="weekBlock"][data-expanded="true"]:visible').count(), 1, 'only one show expands');
  await card.page().waitForTimeout(600);
  const after = await card.evaluate(node => {
    const grid = node.parentElement.parentElement;
    const row = grid.querySelector('[data-hour-rail] [data-hour="21"]');
    return { gridHeight: grid.clientHeight, rowHeight: row.getBoundingClientRect().height };
  });
  assert.ok(after.gridHeight > before.gridHeight, `expanded description should grow the schedule: ${JSON.stringify({ before, after })}`);
  assert.ok(after.rowHeight > before.rowHeight, `expanded show should grow its scheduled row: ${JSON.stringify({ before, after })}`);
  const textFit = await card.evaluate(node => { const text = node.querySelector('[class*="blockDescription"]'); return { scroll: text.scrollHeight, client: text.clientHeight, max: getComputedStyle(text).maxHeight, content: node.querySelector('[class*="blockContent"]').getBoundingClientRect().height, style: getComputedStyle(node).getPropertyValue('--expanded-description-height') }; });
  assert.ok(textFit.scroll <= textFit.client + 1, `full expanded description fits without a nested scroll box: ${JSON.stringify(textFit)}`);
  if (process.env.OUTPUT_DIR && process.env.SCHEDULE_VIEWPORT === '1920x960') {
    const session = await card.page().context().newCDPSession(card.page());
    try {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(`${process.env.OUTPUT_DIR}/schedule-expanded-dark.png`, Buffer.from(data, 'base64'));
    } finally { await session.detach(); }
  }
  await card.click({ force: true });
  assert.equal(await card.getAttribute('aria-expanded'), 'false');
  await card.page().waitForTimeout(600);
  let collapsed = await card.evaluate(node => node.parentElement.parentElement.clientHeight);
  for (let attempt = 0; collapsed !== before.gridHeight && attempt < 10; attempt++) {
    await card.page().waitForTimeout(100);
    collapsed = await card.evaluate(node => node.parentElement.parentElement.clientHeight);
  }
  assert.equal(collapsed, before.gridHeight, 'collapsing restores the compact full-week/day grid');
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 1366 }, { width: 1920, height: 960 }, { width: 1600, height: 800 }, { width: 1280, height: 800 }, { width: 844, height: 390 }]) {
    if (process.env.SCHEDULE_VIEWPORT && process.env.SCHEDULE_VIEWPORT !== `${viewport.width}x${viewport.height}`) continue;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader'] });
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      HTMLMediaElement.prototype.load = function () {};
      HTMLMediaElement.prototype.play = function () { queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve(); };
      HTMLMediaElement.prototype.pause = function () {};
    });
    const page = await context.newPage();
    const capture = async path => {
      const session = await context.newCDPSession(page);
      try {
        const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        await writeFile(path, Buffer.from(data, 'base64'));
      } finally { await session.detach(); }
    };
    // Fix Date only: native animation/timer scheduling stays real, avoiding
    // virtual-rAF interactions with the player fitter and screenshots.
    await page.clock.setFixedTime(fixtureTime);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    let scheduleCalls = 0;
    let failSchedule = false;
    let takeover = false;
    const track = { subsonic_id: 'fixture', title: 'Law of Nature', artist: 'Taeko Onuki', album: 'Sunshower', duration: 229 };
    const stationContext = { time: { show: 'Evening Frequencies', vibe: 'Night' }, activeShow: { name: 'Evening Frequencies', persona: { id: 'host', name: 'sxntax' } } };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/schedule')) {
        scheduleCalls++;
        if (failSchedule) return route.fulfill({ status: 503, json: { error: 'offline' } });
        return route.fulfill({ json: { ...programme, override: takeover ? { showId: 'show-2', startedAt: fixtureTime.getTime() - 10000, expiresAt: fixtureTime.getTime() + 3600000 } : null } });
      }
      if (path.includes('/cover/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#386b94"/></svg>' });
      if (path.endsWith('/now-playing')) return route.fulfill({ json: { nowPlaying: track, context: stationContext, activeShow: stationContext.activeShow, dj: { name: 'sxntax', station: 'The Lab' }, streamOnline: true, stream: { bufferSeconds: 0, bitrate: 320 }, timezone: programme.timezone } });
      if (path.endsWith('/state')) return route.fulfill({ json: { current: { ...track, startedAt: new Date(fixtureTime.getTime() - 60000).toISOString() }, upcoming: [], history: [], djLog: [], ui: { skin: 'sxntax', tuneInOverlay: true } } });
      if (path.endsWith('/session')) return route.fulfill({ json: { session: null, messages: [] } });
      if (path.endsWith('/like')) return route.fulfill({ json: { enabled: false } });
      if (path.endsWith('/onboarding/status')) return route.fulfill({ json: { needsSetup: false } });
      if (path.endsWith('/themes')) return route.fulfill({ json: { themes: [] } });
      return route.fulfill({ json: {} });
    });
    await page.route('**/stream.mp3*', route => route.abort());
    await page.goto(`${base}?lite=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-phosphor-text]')?.textContent.includes('Law of Nature'));
    await page.locator('[class*="tunePrompt"]').click();
    await page.waitForTimeout(3000);
    const trigger = page.getByRole('button', { name: /View schedule/, includeHidden: true });
    assert.equal(await trigger.textContent(), 'Evening Frequencies');
    assert.equal(await trigger.locator('svg, img').count(), 0, 'trigger must have no calendar icon');
    assert.equal(scheduleCalls, 0, 'closed schedule must not poll');
    await trigger.hover();
    const highlight = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      const root = element.closest('[data-sxntax-revision]');
      return { decoration: style.textDecorationLine, background: style.backgroundColor, expected: getComputedStyle(root).getPropertyValue('--sx-fg').trim() };
    });
    assert.equal(highlight.decoration, 'none');
    assert.notEqual(highlight.background, 'rgba(0, 0, 0, 0)', 'show name should highlight on hover');
    await trigger.focus();
    await page.keyboard.press('Space');
    const dialog = page.getByRole('dialog', { name: 'Schedule', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByText(/One day at a time|The week on your frequency/).count(), 0);
    assert.equal(await dialog.getByText(/Weekly programme|All times/).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Close schedule' }).textContent(), '\uF00D');
    const closeBox = await dialog.getByRole('button', { name: 'Close schedule' }).evaluate(node => ({ border: getComputedStyle(node).borderTopWidth, width: node.clientWidth, height: node.clientHeight }));
    assert.equal(closeBox.border, '0px');
    assert.ok(closeBox.width >= 44 && closeBox.height >= 44, 'X should retain a generous invisible hit target');
    assert.equal(await dialog.locator('[class*="weekHead"]').getByText('TODAY', { exact: true }).count(), 0);
    assert.equal(await dialog.locator('[class*="clock"]').count(), 0);
    const background = await dialog.evaluate(element => ({
      panel: getComputedStyle(element).backgroundColor,
      backdrop: getComputedStyle(element).backdropFilter,
      pageVisibility: getComputedStyle(document.querySelector('[class*="scrollport"]')).visibility,
    }));
    assert.notEqual(background.panel, 'rgb(0, 0, 0)', 'schedule panel should be translucent');
    assert.ok(background.backdrop !== 'none' || await page.evaluate(() => document.documentElement.classList.contains('lite')), 'blur is disabled only by the player low-power preference');
    assert.equal(background.pageVisibility, 'hidden', 'page text must not show behind the schedule');
    assert.equal(await dialog.evaluate(element => getComputedStyle(element.closest('[data-sxntax-revision]').querySelector('svg')).visibility), 'visible', 'outer radio frame must remain visible');
    assert.equal(await dialog.evaluate(element => getComputedStyle(element.parentElement.querySelector('[data-state="open"][class*="overlay"]')).backgroundColor), 'rgba(0, 0, 0, 0)', 'outside ambient must not be dimmed');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    const portrait = viewport.height >= viewport.width;
    const dayChooser = dialog.getByRole('navigation', { name: 'Choose schedule day' });
    assert.equal(await dayChooser.isVisible(), portrait);
    if (portrait) {
      await dayChooser.getByRole('button', { name: 'Monday', exact: true }).click();
      assert.equal(await dayChooser.getByRole('button', { name: 'Monday', exact: true }).getAttribute('aria-pressed'), 'true');
      await dialog.getByRole('heading', { name: 'Monday', exact: true }).waitFor();
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForTimeout(200);
      assert.equal(await dayChooser.isVisible(), false);
      for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
        assert.equal(await dialog.getByRole('region', { name: `${day} schedule`, exact: true }).isVisible(), true);
      }
      await page.setViewportSize(viewport);
      await page.waitForTimeout(200);
      assert.equal(await dayChooser.getByRole('button', { name: 'Monday', exact: true }).getAttribute('aria-pressed'), 'true');
      await dialog.getByRole('button', { name: 'TODAY', exact: true }).click();
      const dayGrid = dialog.locator('[class*="portraitGrid"]');
      assert.equal(await dayGrid.locator('[class*="hours"] i').count(), 24);
      assert.equal(await dayGrid.locator('[data-time-marker]').count(), 1);
      assert.equal(await dayGrid.locator('[data-current-hour]').count(), 1);
      await dayChooser.getByRole('button', { name: 'Monday', exact: true }).click();
      assert.equal(await dayGrid.locator('[data-time-marker]').count(), 0);
      await dialog.getByRole('button', { name: 'TODAY', exact: true }).click();
      const portraitCard = dialog.getByRole('region', { name: 'Wednesday schedule' }).getByRole('button', { name: /Evening Frequencies, 21:00/ });
      await verifyExpandPushesRows(dialog, portraitCard);
    } else {
      for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
        assert.equal(await dialog.getByRole('region', { name: `${day} schedule`, exact: true }).isVisible(), true);
      }
    }
    const bounds = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const scroller = [...element.querySelectorAll('[class*="Scroll"]')].find(node => getComputedStyle(node).display !== 'none' && node.clientHeight > 0);
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: element.clientWidth, scrollWidth: element.scrollWidth, scrollHeight: scroller?.clientHeight ?? 0 };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width + 1 && bounds.top >= 0 && bounds.bottom <= viewport.height + 1, JSON.stringify(bounds));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, 'schedule overflows horizontally');
    assert.ok(bounds.scrollHeight >= 90, `too little usable programme space: ${JSON.stringify(bounds)}`);
    const frameInset = await dialog.evaluate(element => Number.parseFloat(getComputedStyle(element.closest('[data-sxntax-revision]')).getPropertyValue('--sx-frame-inset')));
    assert.ok(bounds.left >= frameInset + 10 && bounds.top >= frameInset + 10, 'schedule border must retain breathing room inside the outer frame');
    if (!portrait) {
      const rail = await dialog.evaluate(element => {
        const grid = [...element.querySelectorAll('[class*="weekGrid"]')].find(node => node.clientWidth > 0);
        const marker = grid.querySelector('[data-time-marker]');
        const hours = grid.querySelector('[class*="hours"]');
        const railStyle = getComputedStyle(hours, '::before');
        const firstLabel = hours.querySelector('span');
        const range = document.createRange();
        range.selectNode(firstLabel.querySelector('b').firstChild);
        const currentDot = hours.querySelector('[data-current-hour] i');
        return { grid: grid.getBoundingClientRect().toJSON(), marker: marker.getBoundingClientRect().toJSON(), hours: hours.getBoundingClientRect().toJSON(), railLeft: Number.parseFloat(railStyle.left), labelLeft: range.getBoundingClientRect().left, dotLeft: hours.querySelector('i').getBoundingClientRect().left, currentDot: currentDot.getBoundingClientRect().toJSON(), dotWidth: getComputedStyle(hours.querySelector('i')).width, dots: hours.querySelectorAll('i').length, active: hours.querySelectorAll('[data-current-hour]').length };
      });
      assert.equal(rail.dots, 24);
      assert.equal(rail.active, 1);
      assert.ok(Math.abs(rail.marker.left - (rail.grid.left + 20)) < 1 && Math.abs(rail.marker.right - rail.grid.right) < 1);
      assert.ok(Math.abs(rail.railLeft - 20) < 1 && rail.labelLeft > rail.hours.left + 30, JSON.stringify(rail));
      assert.ok(Math.abs(rail.dotLeft - (rail.hours.left + 18)) < 1);
      assert.ok(Math.abs((rail.marker.top + .5) - (rail.currentDot.top + 2.5)) < 2, `at 21:00 the now line should meet the existing hourly dot: ${JSON.stringify(rail)}`);
      assert.equal(rail.dotWidth, '5px');
      const autoFull = dialog.locator('[class*="weekBlock"][data-auto-description="true"]');
      assert.ok(await autoFull.count() > 0, 'longer shows should display descriptions that fit without a click');
      assert.equal(await autoFull.first().getAttribute('role'), null, 'a fully visible description should not look expandable');
      if (viewport.width >= 1920) {
        const atmospheres = dialog.locator('[aria-label="Wednesday schedule"]:visible [data-schedule-block="3:3"]');
        assert.match(await atmospheres.getAttribute('aria-label'), /^Atmospheres, 03:00/);
        assert.equal(await atmospheres.getAttribute('data-auto-description'), 'true', 'a two-hour Atmospheres show that physically fits should be fully visible without expanding');
        const spacing = await atmospheres.locator('[class*="blockContent"]').evaluate(node => ({ content: node.querySelector('[class*="blockDescription"]').getBoundingClientRect().height + node.querySelector('h3').getBoundingClientRect().height + node.querySelector('[class*="blockTime"]').getBoundingClientRect().height, breathing: Number.parseFloat(getComputedStyle(node).paddingBottom) }));
        assert.ok(spacing.breathing > 0 && spacing.breathing < spacing.content && spacing.breathing <= 10, `bottom cushion should stay small relative to content: ${JSON.stringify(spacing)}`);
      }
      assert.equal(await dialog.locator('[data-time-marker]:visible').evaluate(element => getComputedStyle(element, '::before').content), 'none', 'current line must reuse hourly dots, not add a leading dot');
      const timelineStyle = await dialog.evaluate(element => {
        const grid = [...element.querySelectorAll('[class*="weekGrid"]')].find(node => node.clientWidth > 0);
        const scroller = grid.parentElement;
        scroller.scrollTop = 0;
        const firstLabel = grid.querySelector('[data-hour="0"] b').getBoundingClientRect();
        const dot = grid.querySelector('[data-hour="0"] i');
        const currentDot = grid.querySelector('[data-current-hour] i');
        const marker = grid.querySelector('[data-time-marker]');
        const section = [...grid.querySelectorAll('[aria-label="Wednesday schedule"]')].find(node => node.clientWidth > 0);
        return { labelTop: firstLabel.top, scrollTop: scroller.getBoundingClientRect().top, dotColor: getComputedStyle(dot).backgroundColor, textColor: getComputedStyle(grid.querySelector('[data-hour-rail]')).color, dotOpacity: getComputedStyle(dot).opacity, currentOpacity: getComputedStyle(currentDot).opacity, currentHalo: getComputedStyle(currentDot).boxShadow, markerLayer: getComputedStyle(marker).zIndex, sectionLayer: getComputedStyle(section).zIndex, verticalStart: getComputedStyle(section, '::before').top };
      });
      assert.ok(timelineStyle.labelTop >= timelineStyle.scrollTop - 1, `midnight label must not clip at the top of the timeline: ${JSON.stringify(timelineStyle)}`);
      assert.equal(timelineStyle.dotColor, timelineStyle.textColor, 'hour dots should use the hour rail polarity, not the opposing surface color');
      assert.equal(timelineStyle.dotOpacity, '0.38', 'non-current hour dots should be subdued');
      assert.equal(timelineStyle.currentOpacity, '1', 'current hour dot should remain full polarity');
      assert.equal(timelineStyle.currentHalo, 'none', 'current dot should not have a halo');
      assert.ok(Number(timelineStyle.markerLayer) < Number(timelineStyle.sectionLayer), 'current line must sit behind show copy');
      assert.equal(timelineStyle.verticalStart, '-8px', 'day dividers should reach the header edge without adding a top rule');
      const gridAlignment = await dialog.evaluate(element => [...[...element.querySelectorAll('[aria-label="Wednesday schedule"]')].find(node => node.clientWidth > 0).querySelectorAll('article')].map(block => {
        const weekGrid = block.parentElement.parentElement;
        const startHour = Number(block.dataset.scheduleBlock.split(':')[1]);
        const hourStart = weekGrid.querySelector(`[data-hour-rail] [data-hour="${startHour}"]`).getBoundingClientRect().top;
        return Math.abs(block.getBoundingClientRect().top - hourStart);
      }));
      assert.ok(gridAlignment.every(delta => delta < 1), `show blocks must start on the hour grid: ${gridAlignment}`);
      const weekCard = dialog.getByRole('region', { name: 'Wednesday schedule' }).getByRole('button', { name: /Evening Frequencies, 21:00/ });
      await verifyExpandPushesRows(dialog, weekCard);
    }
    const visibleGrid = dialog.locator('[class*="weekGrid"]:visible');
    assert.equal(await visibleGrid.locator('[data-time-marker]').getAttribute('data-label-overlap'), 'true', 'at the hour the line must protect the overlapping label');
    const contentFit = await visibleGrid.evaluate(grid => [...grid.querySelectorAll('article')].map(card => {
      const content = card.querySelector('[class*="blockContent"]');
      const time = card.querySelector('[class*="blockTime"]');
      const label = card.getAttribute('aria-label');
      return { fits: content.offsetHeight <= card.clientHeight + 1, time: time.textContent, label };
    }));
    assert.ok(contentFit.every(card => card.fits && card.time.includes('–') && !card.label.includes('sxntax')), `show content must fit and always display start/end times: ${JSON.stringify(contentFit.filter(card => !card.fits))}`);
    const labelAlignment = await visibleGrid.evaluate(grid => [...grid.querySelectorAll('[class*="hours"] > span')].map(row => {
      const label = row.querySelector('b').getBoundingClientRect();
      const dot = row.querySelector('i').getBoundingClientRect();
      return Math.abs(label.top + label.height / 2 - dot.top - dot.height / 2);
    }));
    assert.ok(labelAlignment.every(delta => delta < 1), 'hours must be centered on the existing dots');
    await page.clock.setFixedTime(new Date('2026-10-22T03:20:00Z'));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await trigger.click({ force: true });
    await dialog.waitFor();
    await visibleGrid.locator('article').first().waitFor();
    const minuteAlignment = await visibleGrid.evaluate(grid => {
      const marker = grid.querySelector('[data-time-marker]').getBoundingClientRect();
      const hours = grid.querySelector('[class*="hours"]');
      const dot = hours.querySelector('[data-current-hour] i').getBoundingClientRect();
      const rowHeight = hours.querySelector('[data-hour="21"]').getBoundingClientRect().height;
      return { actual: marker.top - dot.top - dot.height / 2, expected: rowHeight / 3 + 1 };
    });
    assert.ok(Math.abs(minuteAlignment.actual - minuteAlignment.expected) < 2, `21:20 must be one-third through the 21:00 hour: ${JSON.stringify(minuteAlignment)}`);
    const clearMarker = visibleGrid.locator('[data-time-marker]');
    assert.equal(await clearMarker.getAttribute('data-label-overlap'), null, 'between hours there must be no label gap');
    assert.equal(await clearMarker.evaluate(node => getComputedStyle(node).backgroundImage), 'none', 'between labels the time rule must be continuous');
    // :35 lands inside the description rather than the gap above it. Verify
    // the actual routed stroke, not merely the stacking order of transparent cards.
    await page.clock.setFixedTime(new Date('2026-10-22T03:35:00Z'));
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await trigger.click({ force: true });
    await dialog.waitFor();
    await visibleGrid.locator('article').first().waitFor();
    await page.waitForTimeout(300);
    const crossings = await visibleGrid.evaluate(grid => {
      const path = grid.querySelector('[data-time-marker] path');
      if (path.getAttribute('d').includes('V')) throw new Error('The current-time rule must remain one straight horizontal line');
      const origin = path.ownerSVGElement.getBoundingClientRect();
      const rects = [];
      for (const text of grid.querySelectorAll('section h3, section p, section [class*="blockTime"]')) {
        const clip = text.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.top < clip.bottom && rect.bottom > clip.top) rects.push(rect);
        }
      }
      let hits = 0;
      const examples = [];
      for (let distance = 0; distance < path.getTotalLength(); distance += 2) {
        const point = path.getPointAtLength(distance);
        const x = origin.left + point.x;
        const y = origin.top + point.y;
        if (rects.some(rect => x > rect.left && x < rect.right && y > rect.top - .5 && y < rect.bottom + .5)) { hits++; if (examples.length < 2) examples.push({ x, y, rect: rects.find(rect => x > rect.left && x < rect.right && y > rect.top - .5 && y < rect.bottom + .5).toJSON() }); }
      }
      return { hits, examples, path: path.getAttribute('d'), origin: origin.toJSON(), texts: [...grid.querySelectorAll('section p')].map(node => ({ clip: node.getBoundingClientRect().toJSON(), text: node.textContent.slice(0, 20) })).filter(item => item.clip.top < origin.top + 32 && item.clip.bottom > origin.top - 32) };
    });
    assert.equal(crossings.hits, 0, `the actual painted current-time path must avoid visible text line boxes: ${JSON.stringify(crossings)}`);
    await dialog.getByRole('button', { name: 'Close schedule' }).focus();
    const muted = await page.locator('audio').evaluate(element => element.muted);
    await page.keyboard.press('m');
    assert.equal(await page.locator('audio').evaluate(element => element.muted), muted, 'player shortcuts must stand down while the modal is open');
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus must stay inside modal');
    await page.waitForTimeout(260);
    if (output) await capture(`${output}/schedule-${viewport.width}-dark.png`);
    await page.evaluate(() => {
      const root = document.querySelector('[data-sxntax-revision]');
      root.style.setProperty('--sx-fg', '#000000');
      root.style.setProperty('--sx-opposing', '#ffffff');
      root.style.setProperty('--sx-ambient-base', '#eeeeee');
    });
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 0)', 'modal must inherit light Phosphoria polarity');
    if (output) await capture(`${output}/schedule-${viewport.width}-light.png`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(100);
    assert.ok(await trigger.evaluate(element => document.activeElement === element), 'closing must return focus to the show');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

    // Friendly retry and honest takeover display are exercised on the first size.
    if (portrait) {
      failSchedule = true;
      await trigger.click({ force: true });
      await page.getByText('The schedule could not be loaded.', { exact: true }).waitFor();
      failSchedule = false;
      takeover = true;
      await page.getByRole('button', { name: 'TRY AGAIN', exact: true }).click({ force: true });
      await page.getByText(/Live takeover until/).waitFor();
      assert.equal(await page.locator('[data-current="true"]').count(), 0, 'weekly slots must not claim to be live during takeover');
      await page.keyboard.press('Escape');
    } else {
      await trigger.click();
      await dialog.waitFor();
      await page.waitForTimeout(100);
      await page.mouse.click(3, 3);
      await dialog.waitFor({ state: 'detached' });
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}×${viewport.height}: highlight-only trigger, responsive layout, focus trap/return, theme polarity and viewport fit`);
    await context.close();
    await browser.close();
    browser = null;
  }
} finally { await browser?.close(); }
