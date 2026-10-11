/**
 * Graph -> canvas view model.
 *
 * This is where the scale techniques live. The canvas never renders the raw graph; it
 * renders a *view* of it, and the view is what we collapse, aggregate and lay out.
 *
 * Three things happen here:
 *  1. Collapse. A collapsed module contributes exactly one proxy node instead of its N
 *     nodes. This is the progressive-disclosure default: a 10,000-node repository opens
 *     as ~40 module boxes you can read, not 10,000 boxes you cannot.
 *  2. Edge aggregation. Every edge is rewritten to the visible representative of each
 *     endpoint, self-loops are dropped, and duplicates collapse into one line carrying a
 *     count. Without this, collapsing nodes does nothing for edge cost — which is where
 *     the real time goes above ~2,000 nodes.
 *  3. Incremental layout. Expanded modules are laid out individually with dagre and
 *     packed as blocks, so expanding one module re-lays-out one module, not the graph.
 */
import dagre from '@dagrejs/dagre';
import type { SynthGraph, SynthNode } from './synth';
import { NODE_H, NODE_W } from './layout';
import { layoutDagre, layoutElk } from './layout';
import type { DetailLevel } from './nodes/ResourceNode';

export interface ViewOptions {
  collapsed: Set<string>;
  layout: 'grid-by-module' | 'dagre' | 'elk-layered';
}

export interface ViewNode {
  id: string;
  type: 'resource' | 'groupProxy' | 'groupRegion';
  x: number;
  y: number;
  width: number;
  height: number;
  node?: SynthNode;
  moduleKey?: string;
  count?: number;
  label?: string;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  count: number;
  aggregated: boolean;
}

export interface ViewModel {
  nodes: ViewNode[];
  edges: ViewEdge[];
  timings: { layoutMs: number; aggregateMs: number; totalMs: number };
  counts: {
    visibleNodes: number;
    visibleEdges: number;
    collapsedModules: number;
    aggregatedEdges: number;
  };
}

export const moduleKeyOf = (n: SynthNode) => n.modulePath.join('/') || 'root';

const GROUP_PAD = 40;
const GROUP_HEADER = 30;
const GUTTER = 88;
const MAX_ROW = 5600;
const PROXY_W = 236;
const PROXY_H = 72;

interface Block {
  key: string;
  label: string;
  width: number;
  height: number;
  collapsed: boolean;
  /** local positions, relative to block origin */
  children: { id: string; x: number; y: number; node: SynthNode }[];
  count: number;
}

function layoutModuleBlock(
  key: string,
  label: string,
  nodes: SynthNode[],
  intraEdges: { from: string; to: string }[],
): Block {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 54 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of intraEdges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  let maxX = 0;
  let maxY = 0;
  const children: Block['children'] = [];
  for (const id of g.nodes()) {
    const p = g.node(id);
    const node = byId.get(id);
    if (!p || !node) continue;
    const x = p.x - NODE_W / 2;
    const y = p.y - NODE_H / 2;
    children.push({ id, x, y, node });
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  return {
    key,
    label,
    width: maxX + GROUP_PAD * 2,
    height: maxY + GROUP_PAD + GROUP_HEADER + GROUP_PAD / 2,
    collapsed: false,
    children,
    count: nodes.length,
  };
}

export async function buildView(graph: SynthGraph, opts: ViewOptions): Promise<ViewModel> {
  const t0 = performance.now();

  // --- partition by module ---------------------------------------------------------
  const byModule = new Map<string, SynthNode[]>();
  const moduleOf = new Map<string, string>();
  for (const n of graph.nodes) {
    const key = moduleKeyOf(n);
    moduleOf.set(n.id, key);
    const arr = byModule.get(key) ?? [];
    arr.push(n);
    byModule.set(key, arr);
  }

  const proxyIdOf = (moduleKey: string) => `g:${moduleKey}`;
  const isCollapsed = (moduleKey: string) => moduleKey !== 'root' && opts.collapsed.has(moduleKey);

  /** The visible representative of a graph node id. */
  const repOf = (nodeId: string) => {
    const mk = moduleOf.get(nodeId);
    if (!mk) return null;
    return isCollapsed(mk) ? proxyIdOf(mk) : nodeId;
  };

  // --- edge aggregation ------------------------------------------------------------
  const tAgg = performance.now();
  const agg = new Map<string, ViewEdge>();
  for (const e of graph.edges) {
    const s = repOf(e.fromNodeId);
    const t = repOf(e.toNodeId);
    if (!s || !t || s === t) continue;
    const key = `${s}->${t}`;
    const existing = agg.get(key);
    if (existing) {
      existing.count++;
      existing.aggregated = true;
      continue;
    }
    agg.set(key, { id: key, source: s, target: t, kind: e.kind, count: 1, aggregated: false });
  }
  const aggregateMs = performance.now() - tAgg;

  // --- layout ----------------------------------------------------------------------
  const tLay = performance.now();
  const viewNodes: ViewNode[] = [];

  if (opts.layout === 'grid-by-module') {
    // intra-module edges per module, for the per-module dagre runs
    const intra = new Map<string, { from: string; to: string }[]>();
    for (const e of graph.edges) {
      const a = moduleOf.get(e.fromNodeId);
      const b = moduleOf.get(e.toNodeId);
      if (a && a === b && !isCollapsed(a)) {
        const arr = intra.get(a) ?? [];
        arr.push({ from: e.fromNodeId, to: e.toNodeId });
        intra.set(a, arr);
      }
    }

    const blocks: Block[] = [];
    for (const [key, nodes] of byModule) {
      if (isCollapsed(key)) {
        blocks.push({
          key,
          label: key,
          width: PROXY_W,
          height: PROXY_H,
          collapsed: true,
          children: [],
          count: nodes.length,
        });
      } else {
        blocks.push(layoutModuleBlock(key, key, nodes, intra.get(key) ?? []));
      }
    }
    // Collapsed proxies first so the overview reads top-left; biggest expanded next.
    blocks.sort((a, b) => Number(b.collapsed) - Number(a.collapsed) || b.count - a.count);

    let cx = 0;
    let cy = 0;
    let rowH = 0;
    for (const b of blocks) {
      if (cx > 0 && cx + b.width > MAX_ROW) {
        cx = 0;
        cy += rowH + GUTTER;
        rowH = 0;
      }
      if (b.collapsed) {
        viewNodes.push({
          id: proxyIdOf(b.key),
          type: 'groupProxy',
          x: cx,
          y: cy,
          width: b.width,
          height: b.height,
          moduleKey: b.key,
          count: b.count,
          label: b.label,
        });
      } else {
        if (b.key !== 'root') {
          viewNodes.push({
            id: `region:${b.key}`,
            type: 'groupRegion',
            x: cx,
            y: cy,
            width: b.width,
            height: b.height,
            moduleKey: b.key,
            count: b.count,
            label: b.label,
          });
        }
        for (const c of b.children) {
          viewNodes.push({
            id: c.id,
            type: 'resource',
            x: cx + GROUP_PAD + c.x,
            y: cy + GROUP_HEADER + GROUP_PAD / 2 + c.y,
            width: NODE_W,
            height: NODE_H,
            node: c.node,
            moduleKey: b.key,
          });
        }
      }
      cx += b.width + GUTTER;
      rowH = Math.max(rowH, b.height);
    }
  } else {
    // Whole-graph layout over the *visible* set: collapsed modules are single nodes.
    const visibleNodes: SynthNode[] = [];
    for (const [key, nodes] of byModule) {
      if (!isCollapsed(key)) visibleNodes.push(...nodes);
    }
    const proxyNodes = [...byModule.keys()].filter(isCollapsed).map((key) => ({
      key,
      id: proxyIdOf(key),
      count: byModule.get(key)!.length,
    }));

    const pseudo: SynthGraph = {
      ...graph,
      nodes: [
        ...visibleNodes,
        ...proxyNodes.map(
          (p) =>
            ({
              id: p.id,
              stableKey: p.id,
              kind: 'module_call',
              address: `module.${p.key}`,
              type: null,
              name: p.key,
              modulePath: [p.key],
              provider: null,
              multiplicity: { kind: 'single', resolved: 1 },
              source: { path: `modules/${p.key}/main.tf`, startLine: 1, endLine: 1 },
              display: { label: `module.${p.key}`, group: 'module', icon: 'package' },
              diagnostics: 0,
            }) as SynthNode,
        ),
      ],
      edges: [...agg.values()].map((e, i) => ({
        id: `a${i}`,
        fromNodeId: e.source,
        toNodeId: e.target,
        kind: 'reference' as const,
        provenance: 'static_hcl' as const,
        confidence: 'exact' as const,
        attributePath: [],
        source: null,
        label: null,
      })),
    };

    const res =
      opts.layout === 'dagre' ? layoutDagre(pseudo) : await layoutElk(pseudo);
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const [id, p] of res.positions) {
      const n = nodeById.get(id);
      if (n) {
        viewNodes.push({
          id,
          type: 'resource',
          x: p.x,
          y: p.y,
          width: NODE_W,
          height: NODE_H,
          node: n,
          moduleKey: moduleOf.get(id),
        });
      } else {
        const proxy = proxyNodes.find((q) => q.id === id);
        if (proxy) {
          viewNodes.push({
            id,
            type: 'groupProxy',
            x: p.x,
            y: p.y,
            width: PROXY_W,
            height: PROXY_H,
            moduleKey: proxy.key,
            count: proxy.count,
            label: proxy.key,
          });
        }
      }
    }
  }
  const layoutMs = performance.now() - tLay;

  const edges = [...agg.values()];
  return {
    nodes: viewNodes,
    edges,
    timings: { layoutMs, aggregateMs, totalMs: performance.now() - t0 },
    counts: {
      visibleNodes: viewNodes.filter((n) => n.type !== 'groupRegion').length,
      visibleEdges: edges.length,
      collapsedModules: [...byModule.keys()].filter(isCollapsed).length,
      aggregatedEdges: edges.filter((e) => e.aggregated).length,
    },
  };
}

/**
 * Zoom -> level of detail. The thresholds come from legibility, not taste: the label is
 * 13px, so below ~0.45 zoom it is under 6px and unreadable; below ~0.18 the whole 208px
 * node is under 38px, at which point the box itself is the only useful signal.
 */
export function detailForZoom(zoom: number): DetailLevel {
  if (zoom >= 0.45) return 'full';
  if (zoom >= 0.18) return 'compact';
  return 'dot';
}

export function multiplicityLabel(n: SynthNode): string | null {
  if (n.multiplicity.kind === 'single') return null;
  return n.multiplicity.resolved === null ? '×?' : `×${n.multiplicity.resolved}`;
}
