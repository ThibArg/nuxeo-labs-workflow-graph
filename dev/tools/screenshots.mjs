/*
 * (C) Copyright 2026 Hyland (http://hyland.com/) and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *     Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)
 */

/*
 * Renders the demo (dev/demo/index.html) in headless Chrome for every sample and theme, fails on any console
 * error or warning, writes the screenshots to dev/out/demo/, then checks the view interactions (initial view,
 * keys, toolbar, wheel, drag, no animation, read-only steps).
 *     LWG_NODE_MODULES=... CHROME_PATH=... node dev/tools/screenshots.mjs [filter]
 * The optional filter keeps the cases whose name contains it (e.g. "serial-default"); "checks" runs the
 * interaction checks only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, outDir, startServer } from './common.mjs';

const filter = process.argv[2] || '';
const target = path.join(outDir, 'demo');
fs.mkdirSync(target, { recursive: true });

const cases = [];
for (const wf of ['serial', 'parallel', 'subWorkflow', 'contract', 'large']) {
  for (const theme of ['default', 'dark', 'hyland-light', 'hyland-dark']) {
    cases.push({ name: `${wf}-${theme}`, query: { wf, theme, dir: 'TB' } });
  }
  cases.push({ name: `${wf}-default-LR`, query: { wf, theme: 'default', dir: 'LR' } });
}
cases.push({ name: 'contract-hyland-dark-LR', query: { wf: 'contract', theme: 'hyland-dark', dir: 'LR' } });
cases.push({ name: 'serial-dark-fr', query: { wf: 'serial', theme: 'dark', lang: 'fr', dir: 'TB' } });
cases.push({
  name: 'contract-default-small',
  query: { wf: 'contract', theme: 'default', dir: 'TB' },
  width: 760,
  height: 520,
});

const { server, baseUrl } = await startServer();
const browser = await launchBrowser();
let failures = 0;

async function open(c) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warn' || msg.type() === 'warning') {
      errors.push(`${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.setViewport({ width: c.width || 1400, height: c.height || 900, deviceScaleFactor: 2 });
  const query = new URLSearchParams(c.query).toString();
  await page.goto(`${baseUrl}/dev/demo/index.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error, { timeout: 10000 });
  const error = await page.evaluate(() => document.body.dataset.error);
  if (error) {
    errors.push(error);
  }
  return { page, errors };
}

function report(name, errors, details) {
  if (errors.length) {
    failures++;
    console.log(`FAIL ${name}\n  ${errors.join('\n  ')}`);
  } else {
    console.log(`ok   ${name}${details ? ` (${details})` : ''}`);
  }
}

// Screen position of the center of a step, and the view state.
function viewState(page, nodeId) {
  return page.evaluate((id) => {
    const r = window.renderer;
    const vp = document.querySelector('.lwg-viewport').getBoundingClientRect();
    const state = { scale: r.transform.scale, x: r.transform.x, y: r.transform.y, vw: vp.width, vh: vp.height };
    const elem = id && document.querySelector(`.lwg-node[data-id="${id}"]`);
    if (elem) {
      const b = elem.getBoundingClientRect();
      state.node = { x: b.left + b.width / 2 - vp.left, y: b.top + b.height / 2 - vp.top };
    }
    state.zoomText = document.querySelector('.lwg-tb-zoom').textContent;
    return state;
  }, nodeId);
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= (tolerance === undefined ? 1 : tolerance);
}

function isCentered(state) {
  return state.node && near(state.node.x, state.vw / 2, 2) && near(state.node.y, state.vh / 2, 2);
}

/* ==================== Screenshots ==================== */

async function screenshots() {
  for (const c of cases.filter((x) => x.name.includes(filter))) {
    const { page, errors } = await open(c);
    await page.screenshot({ path: path.join(target, `${c.name}.png`) });
    const stats = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.lwg-node').length,
      edges: document.querySelectorAll('.lwg-edge').length,
      current: document.querySelectorAll('.lwg-node.is-current').length,
      next: document.querySelectorAll('.lwg-edge.is-next').length,
      scale: window.renderer.transform.scale,
    }));
    report(c.name, errors, `${stats.nodes} steps, ${stats.edges} transitions, ${stats.current} current, `
      + `${stats.next} next, zoom ${Math.round(stats.scale * 100)}%`);
    await page.close();
  }
}

/* ==================== Interaction checks ==================== */

async function checkLargeGraph() {
  const { page, errors } = await open({ query: { wf: 'large', theme: 'default' } });
  const expect = (cond, message) => cond || errors.push(message);
  const first = 'l-p5-review1';
  const second = 'l-p5-review3';

  let s = await viewState(page, first);
  expect(near(s.scale, 0.8, 0.001), `initial zoom ${s.scale}, expected 80% (fitted graph under 50%)`);
  expect(isCentered(s), 'the first current step is not centered at opening');

  // the current steps have a single transition: drawn in the highlight color, not with the palette
  const single = await page.evaluate(() => ({
    current: getComputedStyle(document.querySelector('.lwg-node.is-current')).borderTopColor,
    next: Array.from(document.querySelectorAll('.lwg-edge.is-next')).map((e) => ({
      colored: e.classList.contains('lwg-tc'),
      stroke: getComputedStyle(e.querySelector('.lwg-edge-line')).stroke,
    })),
  }));
  expect(
    single.next.length === 2 && single.next.every((n) => !n.colored && n.stroke === single.current),
    `single next transitions: ${JSON.stringify(single)}`,
  );

  // a click (without moving) on the graph gives it the keyboard focus and changes nothing else
  await page.mouse.click(8, 892);
  const afterClick = await viewState(page);
  expect(afterClick.x === s.x && afterClick.y === s.y && afterClick.scale === s.scale, 'a click moved the view');
  const focused = await page.evaluate(() => document.activeElement.classList.contains('lwg-viewport'));
  expect(focused, 'a click on the graph does not give it the focus');

  await page.keyboard.press('f');
  s = await viewState(page);
  expect(s.scale < 0.5, `"f": zoom ${s.scale}, expected the whole graph (under 50%)`);
  expect(s.zoomText === `${Math.round(s.scale * 100)}%`, `zoom level shows ${s.zoomText}`);
  await page.screenshot({ path: path.join(target, 'large-default-fit.png') });

  // after "f", a resize fits again (it does not go back to the opening view)
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.waitForFunction((scale) => window.renderer.transform.scale !== scale, { timeout: 2000 }, s.scale)
    .catch(() => {});
  const resized = await viewState(page);
  expect(resized.scale < s.scale, `after a resize, zoom ${resized.scale}, expected the graph fitted again`);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await page.keyboard.press('f');

  await page.keyboard.press('c');
  s = await viewState(page, second);
  expect(near(s.scale, 0.8, 0.001) && isCentered(s), '"c" does not center on the second current step');
  await page.keyboard.press('c');
  s = await viewState(page, first);
  expect(isCentered(s), 'a second "c" does not cycle back to the first current step');

  await page.keyboard.press('+');
  s = await viewState(page, first);
  expect(near(s.scale, 1, 0.001) && isCentered(s), `"+": zoom ${s.scale}, expected 100% around the center`);
  await page.keyboard.press('-');
  s = await viewState(page);
  expect(near(s.scale, 0.8, 0.001), `"-": zoom ${s.scale}, expected 80%`);
  await page.keyboard.press('=');
  s = await viewState(page);
  expect(near(s.scale, 1, 0.001), `"=": zoom ${s.scale}, expected 100%`);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('-');
  }
  s = await viewState(page);
  expect(near(s.scale, 0.05, 0.001), `minimum zoom ${s.scale}, expected 5%`);
  report('checks: large graph (initial view, single next transitions, f, c, +, -, =)', errors);
  await page.close();
}

async function checkSmallGraph() {
  const { page, errors } = await open({ query: { wf: 'serial', theme: 'default' } });
  const expect = (cond, message) => cond || errors.push(message);

  let s = await viewState(page);
  const initial = s.scale;
  expect(initial <= 1 && initial >= 0.5, `initial zoom ${initial}, expected the fitted graph`);

  // toolbar: zoom out, zoom level, zoom in, separator, fit, center, separator, top to bottom, left to right
  const buttons = await page.$$('.lwg-toolbar button');
  expect(buttons.length === 6, `${buttons.length} toolbar buttons, expected 6`);
  await page.click('.lwg-toolbar button[title^="Zoom in"]');
  s = await viewState(page);
  expect(near(s.scale, initial * 1.25, 0.001), `toolbar zoom in: ${s.scale}`);
  await page.click('.lwg-toolbar button[title^="Fit"]');
  s = await viewState(page);
  expect(near(s.scale, initial, 0.001), `toolbar fit: ${s.scale}`);
  await page.click('.lwg-toolbar button[title^="Center"]');
  s = await viewState(page, 'Task6d8');
  expect(isCentered(s), 'toolbar center does not center on the current step');

  // Ctrl + wheel zooms around the pointer, the wheel alone pans
  await page.mouse.move(500, 500);
  const before = await viewState(page);
  await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -40 });
  await page.keyboard.up('Control');
  s = await viewState(page);
  expect(s.scale > before.scale, 'Ctrl + wheel does not zoom in');
  // Chrome scales the synthetic wheel delta with the device scale factor: only the direction is checked
  await page.mouse.wheel({ deltaY: 100 });
  const panned = await viewState(page);
  expect(
    near(panned.scale, s.scale, 1e-9) && near(panned.x, s.x) && panned.y < s.y - 10,
    'the wheel does not pan vertically',
  );

  // drag on a step pans the view and does not change anything else
  const nodesBefore = await page.evaluate(() => document.querySelector('.lwg-nodes').innerHTML);
  const box = await (await page.$('.lwg-node[data-id="Task38e"]')).boundingBox();
  await page.mouse.click(box.x + 20, box.y + 20);
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.mouse.up();
  s = await viewState(page);
  expect(near(s.x, panned.x + 60) && near(s.y, panned.y + 40), 'dragging does not pan the view');
  const nodesAfter = await page.evaluate(() => document.querySelector('.lwg-nodes').innerHTML);
  expect(nodesBefore === nodesAfter, 'clicking a step changed the steps');

  const statics = await page.evaluate(() => ({
    animations: document.getAnimations().length,
    transition: getComputedStyle(document.querySelector('.lwg-stage')).transitionDuration,
    interactive: document.querySelectorAll('.lwg-nodes [tabindex], .lwg-nodes [role="button"], .lwg-labels [tabindex]')
      .length,
    nextLabels: document.querySelectorAll('.lwg-label.is-next').length,
  }));
  expect(statics.animations === 0, `${statics.animations} running animation(s)`);
  expect(statics.transition === '0s', `the stage has a transition (${statics.transition})`);
  expect(statics.interactive === 0, 'steps or labels are focusable');
  expect(statics.nextLabels === 4, `${statics.nextLabels} highlighted labels, expected 4`);

  // transition colors: the 4 transitions of the current step have 4 colors of the palette, drawn thicker with
  // bigger arrow heads; the single transition of the start stays neutral
  const tc = await page.evaluate(() => {
    const line = (e) => getComputedStyle(e.querySelector('.lwg-edge-line'));
    // arrow head path: tip, back corner, notch, other back corner; its width is the distance between the corners
    const arrowWidth = (e) => {
      const n = e.querySelector('.lwg-edge-arrow').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
      return Math.hypot(n[2] - n[6], n[3] - n[7]);
    };
    const edge = (e) => ({
      cls: e.getAttribute('class'),
      stroke: line(e).stroke,
      width: parseFloat(line(e).strokeWidth),
      arrow: arrowWidth(e),
    });
    return {
      current: getComputedStyle(document.querySelector('.lwg-node.is-current')).borderTopColor,
      next: Array.from(document.querySelectorAll('.lwg-edge.is-next')).map(edge),
      others: Array.from(document.querySelectorAll('.lwg-edge:not(.is-next)')).map(edge),
      palette: Array.from(document.querySelectorAll('.lwg-edge.lwg-tc')).map((e) => line(e).stroke),
      neutral: Array.from(document.querySelectorAll('.lwg-edge:not(.lwg-tc)')).map((e) => line(e).stroke),
    };
  });
  const nextColors = new Set(tc.next.map((n) => n.stroke));
  const thickest = Math.max(...tc.others.map((o) => o.width));
  const biggestArrow = Math.max(...tc.others.map((o) => o.arrow));
  expect(tc.next.every((n) => /\blwg-tc-[1-4]\b/.test(n.cls)), `next transitions: ${tc.next.map((n) => n.cls)}`);
  expect(nextColors.size === 4 && !nextColors.has(tc.current), `next transition colors: ${[...nextColors]}`);
  expect(tc.next.every((n) => n.width > thickest), `next transition widths: ${tc.next.map((n) => n.width)}`);
  expect(tc.next.every((n) => n.arrow > biggestArrow), `next arrow heads: ${tc.next.map((n) => n.arrow)}`);
  expect(tc.palette.length === 8 && tc.neutral.length === 1, `${tc.palette.length} colored, ${tc.neutral.length} not`);
  expect(!tc.palette.includes(tc.neutral[0]), `the single transition is colored (${tc.neutral[0]})`);

  // a transition color set on html is used by the line, the arrow and the label
  const overridden = await page.evaluate(() => {
    document.documentElement.style.setProperty('--lwg-transition-2', 'rgb(0, 128, 0)');
    const edge = document.querySelector('.lwg-edge.lwg-tc-2');
    return {
      line: getComputedStyle(edge.querySelector('.lwg-edge-line')).stroke,
      arrow: getComputedStyle(edge.querySelector('.lwg-edge-arrow')).fill,
      label: getComputedStyle(document.querySelector('.lwg-label.lwg-tc-2.is-next')).borderTopColor,
    };
  });
  const green = 'rgb(0, 128, 0)';
  expect(
    overridden.line === green && overridden.arrow === green && overridden.label === green,
    `--lwg-transition-2 set on html is not used (${JSON.stringify(overridden)})`,
  );

  // a color set on html (theme, Studio style) is used
  const border = await page.evaluate(() => {
    document.documentElement.style.setProperty('--lwg-current', 'rgb(255, 0, 0)');
    return getComputedStyle(document.querySelector('.lwg-node.is-current')).borderTopColor;
  });
  expect(border === 'rgb(255, 0, 0)', `--lwg-current set on html is not used (${border})`);
  report('checks: small graph (toolbar, wheel, drag, static, read-only, colors)', errors);
  await page.close();
}

// Layout orientation and toolbar state of the page.
function directionState(page) {
  return page.evaluate(() => {
    const center = (id) => {
      const b = document.querySelector(`.lwg-node[data-id="${id}"]`).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const pressed = Array.from(document.querySelectorAll('.lwg-toolbar button[aria-pressed="true"]'));
    const start = document.querySelector('.lwg-kind-start').dataset.id;
    const stops = Array.from(document.querySelectorAll('.lwg-kind-end')).map((n) => n.dataset.id);
    return {
      direction: window.renderer.direction,
      pressed: pressed.map((b) => b.dataset.direction),
      start: center(start),
      stops: stops.map(center),
      current: document.querySelectorAll('.lwg-node.is-current').length,
      next: document.querySelectorAll('.lwg-edge.is-next').length,
      scale: window.renderer.transform.scale,
      stored: Object.keys(localStorage)
        .filter((k) => k.startsWith('nuxeo-labs-workflow-graph.direction.'))
        .map((k) => `${k.replace('nuxeo-labs-workflow-graph.direction.model.', '')}=${localStorage.getItem(k)}`),
    };
  });
}

// Runs last: it stores directions in the browser and cleans them at the end.
async function checkDirection() {
  const errors = [];
  const expect = (cond, message) => cond || errors.push(message);
  let { page, errors: pageErrors } = await open({ query: { wf: 'serial', theme: 'default' } });
  let d = await directionState(page);
  expect(d.direction === 'TB' && d.pressed.join() === 'TB', `opening: ${d.direction}, pressed ${d.pressed}`);
  expect(d.stops.every((p) => p.y > d.start.y), 'TB: an end is not below the start');
  expect(d.stored.length === 0, `nothing should be stored yet: ${d.stored}`);

  await page.click('.lwg-toolbar button[data-direction="LR"]');
  d = await directionState(page);
  expect(d.direction === 'LR' && d.pressed.join() === 'LR', `after the click: ${d.direction}, pressed ${d.pressed}`);
  expect(d.stops.every((p) => p.x > d.start.x), 'LR: an end is not right of the start');
  expect(d.current === 1 && d.next === 4, `LR: ${d.current} current step(s), ${d.next} next transition(s)`);
  const fitted = await page.evaluate(() => window.renderer._fitTransform().scale);
  expect(near(d.scale, Math.min(fitted, 1), 0.001), `LR: zoom ${d.scale}, expected the opening view (fit)`);
  expect(d.stored.join() === 'demo-serial=LR', `stored: ${d.stored}`);
  await page.screenshot({ path: path.join(target, 'serial-default-LR-switched.png') });
  pageErrors.forEach((e) => errors.push(e));
  await page.close();

  // kept for this workflow only
  ({ page, errors: pageErrors } = await open({ query: { wf: 'serial', theme: 'default' } }));
  d = await directionState(page);
  expect(d.direction === 'LR' && d.pressed.join() === 'LR', `serial reopened: ${d.direction}`);
  pageErrors.forEach((e) => errors.push(e));
  await page.close();
  ({ page, errors: pageErrors } = await open({ query: { wf: 'parallel', theme: 'default' } }));
  d = await directionState(page);
  expect(d.direction === 'TB', `parallel: ${d.direction}, expected TB (not affected by serial)`);
  pageErrors.forEach((e) => errors.push(e));
  await page.close();

  // a large graph switched to LR gets the opening view (zoom on the current step)
  ({ page, errors: pageErrors } = await open({ query: { wf: 'large', theme: 'default' } }));
  await page.click('.lwg-toolbar button[data-direction="LR"]');
  const s = await viewState(page, 'l-p5-review1');
  expect(near(s.scale, 0.8, 0.001) && isCentered(s), `large LR: zoom ${s.scale}, not centered on the current step`);
  await page.screenshot({ path: path.join(target, 'large-default-LR-switched.png') });

  // back to TB: the entry is removed
  await page.click('.lwg-toolbar button[data-direction="TB"]');
  d = await directionState(page);
  expect(d.direction === 'TB' && d.stored.join() === 'demo-serial=LR', `large back to TB, stored: ${d.stored}`);
  await page.evaluate(() => localStorage.clear());
  pageErrors.forEach((e) => errors.push(e));
  await page.close();
  report('checks: direction (toggle, opening view, kept per workflow)', errors);
}

try {
  if (filter !== 'checks') {
    await screenshots();
  }
  if (!filter || filter === 'checks') {
    await checkLargeGraph();
    await checkSmallGraph();
    await checkDirection();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  process.exitCode = 1;
}
