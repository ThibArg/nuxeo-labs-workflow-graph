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

// Unit tests of the browser-independent part (core, geometry, layout), run with: node --test dev/test
// The production files are loaded as is into a VM context, no npm dependency is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..', '..');
const webDir = path.join(
  projectDir,
  'nuxeo-labs-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-workflow-graph',
);
const require = createRequire(import.meta.url);
const samples = require(path.join(projectDir, 'dev/demo/samples.js'));

// Same order as nuxeo-labs-workflow-graph-bundle.html (the DOM-dependent files excepted)
const FILES = ['lwg-core.js', 'vendor/dagre.min.js', 'lwg-layout.js'];

// Loads the production scripts in a fresh context, as classic scripts (dagre needs structuredClone).
function load(globals) {
  const ctx = Object.assign({ console, structuredClone }, globals || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(webDir, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

const ctx = load();
const LWG = ctx.NuxeoLabs.WorkflowGraph;
const G = LWG.geometry;

function boxOf(node, p) {
  return { x1: p.x - node.width / 2, y1: p.y - node.height / 2, x2: p.x + node.width / 2, y2: p.y + node.height / 2 };
}

function overlap(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function distanceToBox(p, b) {
  const dx = Math.max(b.x1 - p.x, 0, p.x - b.x2);
  const dy = Math.max(b.y1 - p.y, 0, p.y - b.y2);
  return Math.hypot(dx, dy);
}

/* ==================== Core ==================== */

test('getConfig: enabled by default, accepts booleans and strings', () => {
  const c = load();
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(L.getConfig().enabled, true);
  c.Nuxeo = { UI: { config: { labsWorkflowGraph: { enabled: 'false' } } } };
  assert.equal(L.getConfig().enabled, false);
  c.Nuxeo.UI.config.labsWorkflowGraph.enabled = ' TRUE ';
  assert.equal(L.getConfig().enabled, true);
  c.Nuxeo.UI.config.labsWorkflowGraph.enabled = false;
  assert.equal(L.getConfig().enabled, false);
  c.Nuxeo.UI.config.labsWorkflowGraph.enabled = 'nonsense';
  assert.equal(L.getConfig().enabled, true);
});

test('t: Web UI bundle first, English fallback, never a raw key of the plugin', () => {
  const c = load();
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(L.t('labsWorkflowGraph.toolbar.fit'), 'Fit to screen');
  c.nuxeo = { I18n: { translate: (k) => (k === 'labsWorkflowGraph.toolbar.fit' ? 'Ajuster' : k) } };
  assert.equal(L.t('labsWorkflowGraph.toolbar.fit'), 'Ajuster');
  assert.equal(L.t('labsWorkflowGraph.toolbar.zoomIn'), 'Zoom in');
});

test('every fallback message is in both translation files, and the reverse', () => {
  const i18nDir = path.join(webDir, '..', 'i18n');
  const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'messages.json'), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(path.join(i18nDir, 'messages-fr.json'), 'utf8'));
  const keys = Object.keys(LWG.FALLBACK_MESSAGES).sort();
  assert.deepEqual(Object.keys(en).sort(), keys);
  assert.deepEqual(Object.keys(fr).sort(), keys);
  keys.forEach((k) => assert.equal(en[k], LWG.FALLBACK_MESSAGES[k], k));
});

test('translateLabel: client translation, readable snake_case keys, empty values', () => {
  const c = load({ nuxeo: { I18n: { translate: (k) => (k === 'wf.title' ? 'My workflow' : k) } } });
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(L.translateLabel('wf.title'), 'My workflow');
  assert.equal(L.translateLabel('automatic_transition'), 'Automatic transition');
  assert.equal(L.translateLabel('Review Start'), 'Review Start');
  assert.equal(L.translateLabel(null), '');
  assert.equal(L.translateLabel(undefined), '');
});

test('wrapText and truncateToWidth respect the width and the number of lines', () => {
  const measure = (s) => s.length * 7;
  const wrapped = LWG.wrapText('one two three four five six seven eight nine ten', 70, 2, measure);
  assert.equal(wrapped.lines.length, 2);
  assert.equal(wrapped.truncated, true);
  assert.ok(wrapped.lines[1].endsWith('…'));
  wrapped.lines.forEach((l) => assert.ok(measure(l) <= 70, l));
  const long = LWG.wrapText('Supercalifragilisticexpialidocious', 70, 3, measure);
  long.lines.forEach((l) => assert.ok(measure(l) <= 70, l));
  assert.deepEqual(Array.from(LWG.wrapText('', 70, 3, measure).lines), ['']);
  assert.equal(LWG.truncateToWidth('short', 70, measure), 'short');
  assert.ok(measure(LWG.truncateToWidth('a much longer text', 70, measure)) <= 70);
});

test('buildModel: kinds, current steps, next transitions and warnings', () => {
  const model = LWG.buildModel(samples.contract.graph);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('n-start').kind, 'start');
  assert.equal(byId.get('n-stop').kind, 'end');
  assert.equal(byId.get('n-fork').kind, 'fork');
  assert.equal(byId.get('n-merge').kind, 'merge');
  assert.equal(byId.get('n-sign').kind, 'multiTask');
  assert.equal(byId.get('n-board').kind, 'subWorkflow');
  assert.equal(byId.get('n-decision').kind, 'step');
  assert.deepEqual(Array.from(model.currentNodeIds), ['n-legal']);
  // "waiting" (merge) is not current
  assert.equal(byId.get('n-merge').isCurrent, false);
  const next = Array.from(model.edges.filter((e) => e.isNext).map((e) => e.target));
  assert.deepEqual(next.sort(), ['n-merge', 'n-prepare']);
  assert.ok(byId.get('n-legal').titleTruncated);
  assert.equal(model.warnings.length, 0);

  const broken = LWG.buildModel({
    nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'A again' }, { title: 'no id' }],
    transitions: [{ nodeSourceId: 'a', nodeTargetId: 'missing', label: 'x' }],
  });
  assert.equal(broken.nodes.length, 1);
  assert.equal(broken.edges.length, 0);
  assert.equal(broken.warnings.length, 3);
  assert.equal(LWG.buildModel(null).nodes.length, 0);
});

test('buildModel: transition colors by rank in their step, neutral when the step has a single one', () => {
  const colors = (model, source) =>
    Array.from(model.edges.filter((e) => e.source === source).map((e) => e.colorIndex));
  const serial = LWG.buildModel(samples.serial.graph);
  // current step with 4 transitions, in the order of the definition
  assert.deepEqual(colors(serial, 'Task6d8'), [1, 2, 3, 4]);
  serial.edges.filter((e) => e.source === 'Task375f').forEach((e) => assert.equal(e.colorIndex, 0, e.id));

  // beyond TRANSITION_COLOR_COUNT the colors are reused in turn; ignored transitions are not counted
  assert.equal(LWG.TRANSITION_COLOR_COUNT, 5);
  const targets = ['b', 'c', 'missing', 'b', 'c', 'b', 'c', 'b'];
  const model = LWG.buildModel({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    transitions: targets
      .map((t) => ({ nodeSourceId: 'a', nodeTargetId: t, label: 'x' }))
      .concat([{ nodeSourceId: 'b', nodeTargetId: 'c', label: 'single' }]),
  });
  assert.deepEqual(colors(model, 'a'), [1, 2, 3, 4, 5, 1, 2]);
  assert.deepEqual(colors(model, 'b'), [0]);
  assert.equal(model.warnings.length, 1);
});

// Minimal localStorage
function fakeStorage(failing) {
  const data = new Map();
  const check = () => {
    if (failing) {
      throw new Error('storage not available');
    }
  };
  return {
    data,
    getItem: (k) => (check(), data.has(k) ? data.get(k) : null),
    setItem: (k, v) => (check(), data.set(k, String(v))),
    removeItem: (k) => (check(), data.delete(k)),
  };
}

test('normalizeDirection: TB by default, case-insensitive', () => {
  assert.equal(LWG.normalizeDirection('lr'), 'LR');
  assert.equal(LWG.normalizeDirection(' TB '), 'TB');
  assert.equal(LWG.normalizeDirection('BT'), 'TB');
  assert.equal(LWG.normalizeDirection(null), 'TB');
});

test('directionStorageKey: per workflow model, else per instance, else none', () => {
  const byModel = LWG.directionStorageKey({ workflowModelName: 'SerialDocumentReview', name: 'x' }, 'id-1');
  assert.equal(byModel, LWG.directionStorageKey({ workflowModelName: 'SerialDocumentReview' }, 'id-2'));
  assert.notEqual(byModel, LWG.directionStorageKey({ workflowModelName: 'ParallelDocumentReview' }, 'id-1'));
  assert.equal(LWG.directionStorageKey({ name: 'SerialDocumentReview' }, 'id-1'), byModel);
  const byInstance = LWG.directionStorageKey(null, 'id-1');
  assert.ok(byInstance && byInstance !== LWG.directionStorageKey(null, 'id-2'));
  assert.equal(LWG.directionStorageKey(null, ''), null);
});

test('loadDirection / saveDirection: kept per key, default not stored, storage errors ignored', () => {
  const store = fakeStorage();
  const c = load({ localStorage: store });
  const L = c.NuxeoLabs.WorkflowGraph;
  const serial = L.directionStorageKey({ workflowModelName: 'SerialDocumentReview' });
  const parallel = L.directionStorageKey({ workflowModelName: 'ParallelDocumentReview' });
  assert.equal(L.loadDirection(serial), 'TB');
  L.saveDirection(serial, 'LR');
  assert.equal(L.loadDirection(serial), 'LR');
  assert.equal(L.loadDirection(parallel), 'TB');
  L.saveDirection(serial, 'TB');
  assert.equal(L.loadDirection(serial), 'TB');
  assert.equal(store.data.size, 0, 'the default direction is not stored');
  store.data.set(serial, 'garbage');
  assert.equal(L.loadDirection(serial), 'TB');
  L.saveDirection(null, 'LR');
  assert.equal(store.data.size, 1);

  const failing = load({ localStorage: fakeStorage(true) }).NuxeoLabs.WorkflowGraph;
  failing.saveDirection(serial, 'LR');
  assert.equal(failing.loadDirection(serial), 'TB');
  const none = load().NuxeoLabs.WorkflowGraph;
  none.saveDirection(serial, 'LR');
  assert.equal(none.loadDirection(serial), 'TB');
});

/* ==================== Geometry ==================== */

test('fitTransform: centered below the toolbar, clamped, null without size', () => {
  assert.equal(G.fitTransform(100, 100, 0, 500), null);
  const big = G.fitTransform(2000, 1000, 1000, 600, { margin: 16, top: 60, minScale: 0.05, maxScale: 1 });
  assert.ok(Math.abs(big.scale - (1000 - 32) / 2000) < 1e-9);
  assert.ok(Math.abs(big.x - (1000 - 2000 * big.scale) / 2) < 1e-9);
  assert.ok(big.y >= 60);
  const small = G.fitTransform(100, 50, 1000, 600, { margin: 16, top: 60, maxScale: 1 });
  assert.equal(small.scale, 1);
  const huge = G.fitTransform(100000, 100000, 1000, 600, { minScale: 0.05 });
  assert.equal(huge.scale, 0.05);
});

test('zoomAround keeps the screen point fixed', () => {
  const t = { scale: 0.5, x: 40, y: -20 };
  const z = G.zoomAround(t, 1.25, 300, 200);
  const before = { x: (300 - t.x) / t.scale, y: (200 - t.y) / t.scale };
  const after = { x: (300 - z.x) / z.scale, y: (200 - z.y) / z.scale };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
});

test('paths, arrow heads and shortened ends', () => {
  assert.equal(G.basisPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0,0L10,0');
  const curve = G.basisPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
  assert.ok(curve.startsWith('M0,0') && curve.endsWith('L20,0'), curve);
  const rounded = G.roundedPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }], 10);
  assert.ok(rounded.includes('Q0,40 10,40'), rounded);
  const short = G.shortenEnd([{ x: 0, y: 0 }, { x: 0, y: 100 }], 6);
  assert.deepEqual({ ...short[1] }, { x: 0, y: 94 });
  assert.equal(G.shortenEnd([{ x: 0, y: 0 }, { x: 0, y: 4 }], 6)[1].y, 2);
  // arrow pointing down: the tip is the lowest point
  const arrow = G.arrowHead({ x: 50, y: 100 }, { x: 50, y: 0 }, 9, 8);
  assert.ok(arrow.startsWith('M50,100L'), arrow);
  const ys = arrow.match(/-?\d+(\.\d+)?/g).filter((v, i) => i % 2 === 1).map(Number);
  assert.equal(Math.max(...ys), 100);
});

/* ==================== Layout ==================== */

for (const [name, sample] of Object.entries(samples)) {
  for (const direction of ['TB', 'LR']) {
    test(`computeLayout (${name}, ${direction}): steps placed without overlap, transitions attached`, () => {
      const model = LWG.buildModel(sample.graph);
      const layout = LWG.computeLayout(model, { direction });
      assert.equal(layout.direction, direction);
      assert.ok(layout.width > 0 && layout.height > 0);
      const boxes = new Map();
      model.nodes.forEach((n) => {
        const p = layout.nodes[n.id];
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), n.id);
        const b = boxOf(n, p);
        assert.ok(b.x1 >= -0.5 && b.y1 >= -0.5 && b.x2 <= layout.width + 0.5 && b.y2 <= layout.height + 0.5, n.id);
        boxes.set(n.id, b);
      });
      const list = Array.from(boxes.entries());
      list.forEach(([a, ba], i) =>
        list.slice(i + 1).forEach(([b, bb]) => assert.ok(!overlap(ba, bb), `${a} overlaps ${b}`)),
      );
      model.edges.forEach((e) => {
        const r = layout.edges[e.id];
        assert.ok(r && r.points.length >= 2, e.id);
        const first = r.points[0];
        const last = r.points[r.points.length - 1];
        assert.ok(distanceToBox(first, boxes.get(e.source)) < 2, `${e.id} does not leave ${e.source}`);
        assert.ok(distanceToBox(last, boxes.get(e.target)) < 2, `${e.id} does not reach ${e.target}`);
        if (r.labelPos) {
          const lb = boxOf({ width: e.labelWidth, height: e.labelHeight }, r.labelPos);
          boxes.forEach((nb, id) => assert.ok(!overlap(lb, nb), `label of ${e.id} overlaps ${id}`));
        }
      });
    });
  }
}

test('computeLayout reads from top to bottom by default, from left to right with LR', () => {
  const model = LWG.buildModel(samples.serial.graph);
  const order = ['Task375f', 'Task38e', 'Task6d8', 'Task5c1'];
  for (const [direction, axis] of [[undefined, 'y'], ['nonsense', 'y'], ['TB', 'y'], ['LR', 'x'], ['lr', 'x']]) {
    const layout = LWG.computeLayout(model, { direction });
    order.slice(1).forEach((id, i) => {
      assert.ok(layout.nodes[order[i]][axis] < layout.nodes[id][axis], `${direction}: ${order[i]} before ${id}`);
    });
  }
});

test('computeLayout of the large sample is fast, taller than wide (TB), wider than tall (LR)', () => {
  const model = LWG.buildModel(samples.large.graph);
  assert.equal(model.nodes.length, 59);
  assert.equal(model.currentNodeIds.length, 2);
  const start = Date.now();
  const tb = LWG.computeLayout(model);
  assert.ok(Date.now() - start < 3000);
  assert.ok(tb.height > tb.width);
  const lr = LWG.computeLayout(model, { direction: 'LR' });
  assert.ok(lr.width > lr.height);
});

test('computeLayout fails clearly without dagre', () => {
  const c = load();
  const L = c.NuxeoLabs.WorkflowGraph;
  L.dagre = null;
  assert.throws(() => L.computeLayout(L.buildModel(samples.serial.graph)), /dagre is not loaded/);
});

test('a dagre global defined by another add-on is restored', () => {
  const other = { name: 'another dagre' };
  const c = load({ dagre: other });
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(c.dagre, other);
  assert.notEqual(L.dagre, other);
  assert.equal(typeof L.dagre.layout, 'function');
});
