/**
 * Layout candidates for a directed dependency graph.
 *
 * Both are measured. Licences, for the record (TECH-SPEC §6.2 constrains us to
 * MIT/BSD/Apache/ISC unless QA & Security clears an exception):
 *   @dagrejs/dagre  MIT          — allowed
 *   elkjs           EPL-2.0      — NOT allowed without a QA & Security exception
 *
 * elkjs is still benchmarked here so the exception request (if we ever make one) has
 * numbers attached rather than a hunch.
 */
import dagre from '@dagrejs/dagre';
import type { SynthGraph } from './synth';

export type LayoutAlgorithm = 'dagre' | 'elk-layered' | 'grid-by-module';

export interface Positioned {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  positions: Map<string, Positioned>;
  ms: number;
  algorithm: LayoutAlgorithm;
  /** Crossing-count proxy and area, for a quality comparison that is not "it looks nice". */
  quality: { width: number; height: number; aspect: number; edgeLengthMean: number };
}

export const NODE_W = 208;
export const NODE_H = 56;

function quality(
  positions: Map<string, Positioned>,
  graph: SynthGraph,
): LayoutResult['quality'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.width);
    maxY = Math.max(maxY, p.y + p.height);
  }
  let total = 0;
  let counted = 0;
  for (const e of graph.edges) {
    const a = positions.get(e.fromNodeId);
    const b = positions.get(e.toNodeId);
    if (!a || !b) continue;
    total += Math.hypot(a.x - b.x, a.y - b.y);
    counted++;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    width: Math.round(width),
    height: Math.round(height),
    aspect: Number((width / Math.max(1, height)).toFixed(2)),
    edgeLengthMean: Math.round(total / Math.max(1, counted)),
  };
}

/** dagre, MIT. Top-to-bottom; dependencies below their dependents. */
export function layoutDagre(graph: SynthGraph, rankdir: 'TB' | 'LR' = 'TB'): LayoutResult {
  const t0 = performance.now();
  const g = new dagre.graphlib.Graph({ compound: false });
  g.setGraph({ rankdir, nodesep: 36, ranksep: 72, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) {
    if (g.hasNode(e.fromNodeId) && g.hasNode(e.toNodeId)) g.setEdge(e.fromNodeId, e.toNodeId);
  }
  dagre.layout(g);
  const positions = new Map<string, Positioned>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (!n) continue;
    positions.set(id, { id, x: n.x - NODE_W / 2, y: n.y - NODE_H / 2, width: NODE_W, height: NODE_H });
  }
  return {
    positions,
    ms: performance.now() - t0,
    algorithm: 'dagre',
    quality: quality(positions, graph),
  };
}

/**
 * elkjs `layered`, EPL-2.0. Runs in a worker by default; we call it on the main thread
 * through the bundled API so the timing is comparable with dagre's.
 */
export async function layoutElk(graph: SynthGraph): Promise<LayoutResult> {
  const t0 = performance.now();
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      // without this elk spends most of its time on crossing minimisation
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.fromNodeId], targets: [e.toNodeId] })),
  });
  const positions = new Map<string, Positioned>();
  for (const c of result.children ?? []) {
    positions.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: NODE_W, height: NODE_H });
  }
  return {
    positions,
    ms: performance.now() - t0,
    algorithm: 'elk-layered',
    quality: quality(positions, graph),
  };
}

/**
 * The cheap baseline: dagre inside each module, modules packed as blocks.
 * This is the "incremental layout" candidate — a module can be re-laid-out on expand
 * without touching the rest of the graph.
 */
export function layoutByModule(graph: SynthGraph): LayoutResult {
  const t0 = performance.now();
  const positions = new Map<string, Positioned>();
  const byModule = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const key = n.modulePath.join('/') || 'root';
    const arr = byModule.get(key) ?? [];
    arr.push(n.id);
    byModule.set(key, arr);
  }
  const edgesWithin = new Map<string, { from: string; to: string }[]>();
  const moduleOf = new Map<string, string>();
  for (const n of graph.nodes) moduleOf.set(n.id, n.modulePath.join('/') || 'root');
  for (const e of graph.edges) {
    const a = moduleOf.get(e.fromNodeId);
    const b = moduleOf.get(e.toNodeId);
    if (a && a === b) {
      const arr = edgesWithin.get(a) ?? [];
      arr.push({ from: e.fromNodeId, to: e.toNodeId });
      edgesWithin.set(a, arr);
    }
  }

  const PAD = 48;
  const GUTTER = 96;
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const maxRowWidth = 5200;

  for (const [key, ids] of byModule) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 56 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
    for (const e of edgesWithin.get(key) ?? []) {
      if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
    }
    dagre.layout(g);
    let w = 0;
    let h = 0;
    for (const id of g.nodes()) {
      const n = g.node(id);
      if (!n) continue;
      w = Math.max(w, n.x + NODE_W / 2);
      h = Math.max(h, n.y + NODE_H / 2);
    }
    if (cursorX > 0 && cursorX + w + PAD * 2 > maxRowWidth) {
      cursorX = 0;
      cursorY += rowHeight + GUTTER;
      rowHeight = 0;
    }
    for (const id of g.nodes()) {
      const n = g.node(id);
      if (!n) continue;
      positions.set(id, {
        id,
        x: cursorX + PAD + n.x - NODE_W / 2,
        y: cursorY + PAD + n.y - NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
      });
    }
    const blockW = w + PAD * 2;
    const blockH = h + PAD * 2;
    cursorX += blockW + GUTTER;
    rowHeight = Math.max(rowHeight, blockH);
  }

  return {
    positions,
    ms: performance.now() - t0,
    algorithm: 'grid-by-module',
    quality: quality(positions, graph),
  };
}

export async function runLayout(
  graph: SynthGraph,
  algorithm: LayoutAlgorithm,
): Promise<LayoutResult> {
  if (algorithm === 'dagre') return layoutDagre(graph);
  if (algorithm === 'grid-by-module') return layoutByModule(graph);
  return layoutElk(graph);
}
