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
 * Layout of the graph and geometry helpers (pure functions, no DOM).
 *
 *   LWG.geometry: SVG path builders, arrow heads, self-loops, bounds, fit and zoom computations.
 *   LWG.computeLayout(model, { direction }): layered layout, top to bottom or left to right, computed by dagre
 *     (vendor/dagre.min.js, MIT), which must be loaded before this file.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const LWG = root.NuxeoLabs && root.NuxeoLabs.WorkflowGraph;
  if (!LWG || LWG.geometry) {
    return;
  }

  // Keep our own reference to dagre and give back the global to a previously loaded copy, if any.
  const dagreLib = root.dagre;
  if (dagreLib) {
    LWG.dagre = dagreLib;
    if (LWG._previousDagre && LWG._previousDagre !== dagreLib) {
      root.dagre = LWG._previousDagre;
    }
  }

  /* ==================== Geometry ==================== */

  function fmt(n) {
    return Math.round(n * 10) / 10;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /*
   * Smooth curve through dagre's control points: uniform B-spline, same algorithm as d3.curveBasis. It starts
   * at the first point, ends at the last one, and its last part follows the last segment, so the arrow head
   * can be oriented with the last two points.
   */
  function basisPath(points) {
    if (!points || points.length === 0) {
      return '';
    }
    let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`;
    if (points.length === 1) {
      return d;
    }
    let x0 = points[0].x;
    let y0 = points[0].y;
    let x1 = points[1].x;
    let y1 = points[1].y;
    const bezier = (x, y) => {
      d +=
        `C${fmt((2 * x0 + x1) / 3)},${fmt((2 * y0 + y1) / 3)} ` +
        `${fmt((x0 + 2 * x1) / 3)},${fmt((y0 + 2 * y1) / 3)} ` +
        `${fmt((x0 + 4 * x1 + x) / 6)},${fmt((y0 + 4 * y1 + y) / 6)}`;
    };
    if (points.length > 2) {
      d += `L${fmt((5 * x0 + x1) / 6)},${fmt((5 * y0 + y1) / 6)}`;
      for (let i = 2; i < points.length; i++) {
        const { x, y } = points[i];
        bezier(x, y);
        x0 = x1;
        y0 = y1;
        x1 = x;
        y1 = y;
      }
      bezier(x1, y1);
    }
    return `${d}L${fmt(x1)},${fmt(y1)}`;
  }

  // Polyline whose corners are rounded with the given radius (used for self-loops).
  function roundedPath(points, radius) {
    if (!points || points.length === 0) {
      return '';
    }
    let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const l1 = distance(prev, cur);
      const l2 = distance(cur, next);
      const r = Math.min(radius, l1 / 2, l2 / 2);
      if (r <= 0.01) {
        d += `L${fmt(cur.x)},${fmt(cur.y)}`;
        continue;
      }
      const a = { x: cur.x - ((cur.x - prev.x) / l1) * r, y: cur.y - ((cur.y - prev.y) / l1) * r };
      const b = { x: cur.x + ((next.x - cur.x) / l2) * r, y: cur.y + ((next.y - cur.y) / l2) * r };
      d += `L${fmt(a.x)},${fmt(a.y)}Q${fmt(cur.x)},${fmt(cur.y)} ${fmt(b.x)},${fmt(b.y)}`;
    }
    const last = points[points.length - 1];
    return `${d}L${fmt(last.x)},${fmt(last.y)}`;
  }

  // Moves the last point back by `length` px along the last segment (room for the arrow head).
  function shortenEnd(points, length) {
    const result = (points || []).map((p) => ({ x: p.x, y: p.y }));
    if (result.length < 2 || !(length > 0)) {
      return result;
    }
    const end = result[result.length - 1];
    const prev = result[result.length - 2];
    const len = distance(prev, end);
    if (len === 0) {
      return result;
    }
    const cut = Math.min(length, len * 0.5);
    end.x -= ((end.x - prev.x) / len) * cut;
    end.y -= ((end.y - prev.y) / len) * cut;
    return result;
  }

  // SVG path of an arrow head whose tip is `tip`, pointing in the direction from -> tip.
  function arrowHead(tip, from, length, width) {
    const len = distance(from, tip) || 1;
    const ux = (tip.x - from.x) / len;
    const uy = (tip.y - from.y) / len;
    const bx = tip.x - ux * length;
    const by = tip.y - uy * length;
    const nx = (-uy * width) / 2;
    const ny = (ux * width) / 2;
    const notch = length * 0.26;
    return (
      `M${fmt(tip.x)},${fmt(tip.y)}L${fmt(bx + nx)},${fmt(by + ny)}` +
      `L${fmt(bx + ux * notch)},${fmt(by + uy * notch)}L${fmt(bx - nx)},${fmt(by - ny)}Z`
    );
  }

  /*
   * Route of a transition looping on its own node. dagre reserves room for it (a dummy node next to the node,
   * as wide as the label) but its own self-edge points are not usable, so the loop is drawn here: it leaves
   * the node on the side of the dummy, goes around the dummy's center line (where the label is centered) and
   * comes back into the node. `index` (0 = closest loop) spreads nested loops apart.
   * Returns { points, labelPos }.
   */
  function selfLoop(node, dummy, index) {
    const i = index || 0;
    const dx = dummy.x - node.x;
    const dy = dummy.y - node.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const edgeX = node.x + ((dx >= 0 ? 1 : -1) * node.width) / 2;
      const spread = Math.max(6, Math.min(node.height / 2 - 8, 16 + 10 * i));
      return {
        points: [
          { x: edgeX, y: node.y - spread },
          { x: dummy.x, y: node.y - spread },
          { x: dummy.x, y: node.y + spread },
          { x: edgeX, y: node.y + spread },
        ],
        labelPos: { x: dummy.x, y: node.y },
      };
    }
    const edgeY = node.y + ((dy >= 0 ? 1 : -1) * node.height) / 2;
    const spread = Math.max(6, Math.min(node.width / 2 - 8, 22 + 14 * i));
    return {
      points: [
        { x: node.x + spread, y: edgeY },
        { x: node.x + spread, y: dummy.y },
        { x: node.x - spread, y: dummy.y },
        { x: node.x - spread, y: edgeY },
      ],
      labelPos: { x: node.x, y: dummy.y },
    };
  }

  // Shifts a layout result so its bounding box (nodes, edge points, labels) starts at (0, 0) and sets its
  // width and height. Mutates and returns it.
  function normalize(model, layout) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x1, y1, x2, y2) => {
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    };
    model.nodes.forEach((n) => {
      const p = layout.nodes[n.id];
      add(p.x - n.width / 2, p.y - n.height / 2, p.x + n.width / 2, p.y + n.height / 2);
    });
    model.edges.forEach((e) => {
      const r = layout.edges[e.id];
      r.points.forEach((p) => add(p.x, p.y, p.x, p.y));
      if (r.labelPos) {
        const { x, y } = r.labelPos;
        add(x - e.labelWidth / 2, y - e.labelHeight / 2, x + e.labelWidth / 2, y + e.labelHeight / 2);
      }
    });
    if (!Number.isFinite(minX)) {
      layout.width = 0;
      layout.height = 0;
      return layout;
    }
    const move = (p) => {
      p.x -= minX;
      p.y -= minY;
    };
    Object.values(layout.nodes).forEach(move);
    Object.values(layout.edges).forEach((r) => {
      r.points.forEach(move);
      if (r.labelPos) {
        move(r.labelPos);
      }
    });
    layout.width = maxX - minX;
    layout.height = maxY - minY;
    return layout;
  }

  /*
   * Transform (scale + translation, in screen px) showing a content of contentWidth x contentHeight centered
   * in a viewport of viewWidth x viewHeight, minus the margins. options: { margin, top, minScale, maxScale },
   * `top` being the margin at the top (room for the toolbar). Returns null when the viewport has no size yet.
   */
  function fitTransform(contentWidth, contentHeight, viewWidth, viewHeight, options) {
    const o = Object.assign({ margin: 16, top: 16, minScale: 0.05, maxScale: 1 }, options || {});
    if (!(viewWidth > 0) || !(viewHeight > 0)) {
      return null;
    }
    const cw = Math.max(1, contentWidth);
    const ch = Math.max(1, contentHeight);
    const availW = Math.max(1, viewWidth - o.margin * 2);
    const availH = Math.max(1, viewHeight - o.top - o.margin);
    const scale = clamp(Math.min(availW / cw, availH / ch), o.minScale, o.maxScale);
    return {
      scale,
      x: (viewWidth - cw * scale) / 2,
      y: o.top + (availH - ch * scale) / 2,
    };
  }

  // New transform with the given scale, keeping the screen point (cx, cy) fixed.
  function zoomAround(transform, scale, cx, cy) {
    const worldX = (cx - transform.x) / transform.scale;
    const worldY = (cy - transform.y) / transform.scale;
    return { scale, x: cx - worldX * scale, y: cy - worldY * scale };
  }

  LWG.geometry = {
    clamp,
    distance,
    basisPath,
    roundedPath,
    shortenEnd,
    arrowHead,
    selfLoop,
    normalize,
    fitTransform,
    zoomAround,
  };

  /* ==================== Layout ==================== */

  // nodesep: between steps of a rank, ranksep: between ranks. Cards are wide and short, so they are packed
  // closer side by side when the ranks are columns (LR).
  const SPACING = {
    TB: { nodesep: 56, ranksep: 60, edgesep: 22 },
    LR: { nodesep: 34, ranksep: 70, edgesep: 18 },
  };

  function finitePoint(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  /*
   * Lays out the model (see LWG.buildModel). options: { direction: 'TB' (top to bottom, default) | 'LR' (left
   * to right) }. Returns {
   *   width, height, direction,
   *   nodes: { [nodeId]: { x, y } },   // center of the node
   *   edges: { [edgeId]: { points: [{ x, y }], curve: 'basis' | 'rounded', labelPos: { x, y } | null } }
   * }, coordinates starting at (0, 0). Throws when dagre is missing or returns an unusable result.
   */
  LWG.computeLayout = function (model, options) {
    const dagre = LWG.dagre;
    if (!dagre || !dagre.graphlib || typeof dagre.layout !== 'function') {
      throw new Error('dagre is not loaded');
    }
    const direction = LWG.normalizeDirection(options && options.direction);
    const labelMetrics = LWG.METRICS.label;
    const g = new dagre.graphlib.Graph({ multigraph: true });
    // The default acyclicer is a depth-first search starting from the sources (the Start nodes): only the
    // real back edges (loops to a previous step) are reversed, so the flow reads from the start to the end.
    g.setGraph(
      Object.assign({ rankdir: direction, marginx: 0, marginy: 0, ranker: 'network-simplex' }, SPACING[direction]),
    );
    g.setDefaultEdgeLabel(() => ({}));
    model.nodes.forEach((n) => g.setNode(n.id, { width: n.width, height: n.height }));
    model.edges.forEach((e) => {
      // the dummy dagre puts next to a node for its self-loop must leave room for the loop, even without label
      const label = e.isSelfLoop
        ? {
            width: Math.max(e.labelWidth, labelMetrics.minSelfLoopWidth),
            height: Math.max(e.labelHeight, labelMetrics.height),
          }
        : { width: e.labelWidth, height: e.labelHeight, minlen: 1, weight: 1 };
      g.setEdge(e.source, e.target, Object.assign(label, { labelpos: 'c' }), e.id);
    });

    dagre.layout(g);

    const result = { width: 0, height: 0, direction, nodes: {}, edges: {} };
    model.nodes.forEach((n) => {
      const p = g.node(n.id);
      if (!finitePoint(p)) {
        throw new Error(`No position computed for the node ${n.id}`);
      }
      result.nodes[n.id] = { x: p.x, y: p.y };
    });

    const loopsByNode = new Map();
    model.edges.forEach((e) => {
      const label = g.edge({ v: e.source, w: e.target, name: e.id });
      if (!label) {
        throw new Error(`No route computed for the transition ${e.id}`);
      }
      if (e.isSelfLoop) {
        if (!finitePoint(label)) {
          throw new Error(`No room reserved for the self-loop ${e.id}`);
        }
        const loops = loopsByNode.get(e.source) || [];
        loops.push({ edge: e, dummy: { x: label.x, y: label.y } });
        loopsByNode.set(e.source, loops);
        return;
      }
      const points = (label.points || []).filter(finitePoint).map((p) => ({ x: p.x, y: p.y }));
      if (points.length < 2) {
        throw new Error(`Invalid route for the transition ${e.id}`);
      }
      result.edges[e.id] = {
        points,
        curve: 'basis',
        labelPos: e.labelWidth && finitePoint(label) ? { x: label.x, y: label.y } : null,
      };
    });

    // Self-loops are routed here, around the room dagre reserved (the label position).
    loopsByNode.forEach((loops, nodeId) => {
      const node = model.nodes.find((n) => n.id === nodeId);
      const center = result.nodes[nodeId];
      const box = { x: center.x, y: center.y, width: node.width, height: node.height };
      loops
        .sort((a, b) => distance(center, a.dummy) - distance(center, b.dummy))
        .forEach((loop, index) => {
          const route = selfLoop(box, loop.dummy, index);
          result.edges[loop.edge.id] = {
            points: route.points,
            curve: 'rounded',
            labelPos: loop.edge.labelWidth ? route.labelPos : null,
          };
        });
    });

    return normalize(model, result);
  };
})(typeof window !== 'undefined' ? window : globalThis);
