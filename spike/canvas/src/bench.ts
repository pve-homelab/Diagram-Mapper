/**
 * In-page measurement surface for bench/run.mjs.
 *
 * Everything the finding reports is read from here, so the numbers come from the same
 * code path a user drives — not from a separate synthetic loop.
 */
import type { ReactFlowInstance } from '@xyflow/react';
import type { SynthGraph } from './synth';
import type { ViewModel } from './view';
import type { PanelRect } from './panel/ChatPanel';
import { layoutByModule, layoutDagre, layoutElk } from './layout';
import { generateGraph } from './synth';

interface BenchHooks {
  getConfig: () => unknown;
  getGraph: () => SynthGraph | null;
  getView: () => ViewModel | null;
  getDetail: () => string;
  getPanelRect: () => PanelRect | null;
  getPaneRect: () => DOMRect | null;
  getFlow: () => ReactFlowInstance;
  selectNode: (id: string) => void;
  setCollapsedAll: (on: boolean) => void;
  isBusy: () => boolean;
  getSelected: () => string | null;
}

export interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
  p95FrameMs: number;
  longestFrameMs: number;
}

declare global {
  interface Window {
    __bench: ReturnType<typeof makeBench>;
  }
}

function rectsIntersect(a: DOMRect | PanelRect, b: DOMRect | PanelRect) {
  const ax2 = ('right' in a ? a.right : a.x + a.width) as number;
  const ay2 = ('bottom' in a ? a.bottom : a.y + a.height) as number;
  const bx2 = ('right' in b ? b.right : b.x + b.width) as number;
  const by2 = ('bottom' in b ? b.bottom : b.y + b.height) as number;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

function makeBench(hooks: BenchHooks) {
  const settled = async (timeoutMs = 120_000) => {
    const start = performance.now();
    // wait for the view to exist and the busy flag to clear
    while (performance.now() - start < timeoutMs) {
      if (!hooks.isBusy() && hooks.getView()) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  /** Count real composited frames over a window while `tick` drives the canvas. */
  const measureFrames = async (
    durationMs: number,
    tick: (t: number) => void,
  ): Promise<FrameStats> => {
    const frameTimes: number[] = [];
    let last = performance.now();
    const t0 = last;
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        frameTimes.push(now - last);
        last = now;
        const elapsed = now - t0;
        tick(elapsed / durationMs);
        if (elapsed < durationMs) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const total = performance.now() - t0;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    return {
      frames: frameTimes.length,
      durationMs: Math.round(total),
      fps: Number(((frameTimes.length / total) * 1000).toFixed(1)),
      p95FrameMs: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1)),
      longestFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    };
  };

  return {
    settled,

    snapshot() {
      const view = hooks.getView();
      const graph = hooks.getGraph();
      return {
        config: hooks.getConfig(),
        detail: hooks.getDetail(),
        graphStats: graph?.stats ?? null,
        viewCounts: view?.counts ?? null,
        viewTimings: view?.timings ?? null,
        domNodes: document.querySelectorAll('.react-flow__node').length,
        domEdges: document.querySelectorAll('.react-flow__edge').length,
        domTotal: document.getElementsByTagName('*').length,
        zoom: hooks.getFlow().getZoom(),
        heapBytes:
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
      };
    },

    /** Pan across the graph for `ms`, reporting real frame rate. */
    async panBench(ms = 2000) {
      const rf = hooks.getFlow();
      const start = rf.getViewport();
      const view = hooks.getView();
      const span = Math.max(
        1200,
        Math.min(6000, (view?.nodes.length ?? 100) * 4),
      );
      return measureFrames(ms, (p) => {
        rf.setViewport({
          x: start.x - Math.sin(p * Math.PI * 2) * span,
          y: start.y - Math.cos(p * Math.PI * 2) * span * 0.4,
          zoom: start.zoom,
        });
      });
    },

    /** Zoom in and out through the LOD thresholds for `ms`. */
    async zoomBench(ms = 2000) {
      const rf = hooks.getFlow();
      const start = rf.getViewport();
      return measureFrames(ms, (p) => {
        const z = 0.08 * Math.pow(12, (Math.sin(p * Math.PI * 2) + 1) / 2);
        rf.setViewport({ x: start.x, y: start.y, zoom: z });
      });
    },

    /** Time from click to the panel showing the node's address. */
    async selectBench(sampleCount = 8) {
      const view = hooks.getView();
      if (!view) return null;
      const ids = view.nodes.filter((n) => n.type === 'resource').map((n) => n.id);
      if (!ids.length) return null;
      const samples: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        const id = ids[Math.floor((i / sampleCount) * ids.length)];
        const t0 = performance.now();
        hooks.selectNode(id);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // wait until the panel subject actually reflects the selection
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          const el = document.querySelector('.dm-panel__subject');
          if (el && el.textContent && el.textContent.length > 0) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return {
        samples: samples.map((s) => Number(s.toFixed(1))),
        medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
        p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(1)),
      };
    },

    /** Collapse / expand all, timed. This is the incremental-layout measurement. */
    async toggleAllBench(on: boolean) {
      const t0 = performance.now();
      hooks.setCollapsedAll(on);
      await new Promise((r) => setTimeout(r, 0));
      await settled();
      return {
        ms: Number((performance.now() - t0).toFixed(1)),
        counts: hooks.getView()?.counts ?? null,
        timings: hooks.getView()?.timings ?? null,
      };
    },

    /**
     * Does the panel cover the resource it is describing?
     * Returns the two rects and the intersection verdict — machine-checkable evidence
     * for the "must never obscure" requirement.
     */
    occlusionCheck() {
      const panel = hooks.getPanelRect();
      const selected = hooks.getSelected();
      if (!panel || !selected) return { checked: false as const };
      const el = document.querySelector(`.react-flow__node[data-id="${selected}"]`);
      const nodeRect = el?.getBoundingClientRect() ?? null;
      const pane = hooks.getPaneRect();
      return {
        checked: true as const,
        selected,
        panel,
        nodeRect: nodeRect
          ? { x: nodeRect.x, y: nodeRect.y, width: nodeRect.width, height: nodeRect.height }
          : null,
        nodeInPane: !!(nodeRect && pane && rectsIntersect(nodeRect, pane)),
        occluded: !!(nodeRect && rectsIntersect(nodeRect, panel)),
      };
    },

    /** Raw layout-algorithm comparison, independent of React. */
    async layoutBench(nodeCount: number, seed = 1337) {
      const graph = generateGraph({ nodeCount, seed });
      const out: Record<string, unknown> = {
        nodeCount: graph.stats.nodeCount,
        edgeCount: graph.stats.edgeCount,
        moduleCount: graph.stats.moduleCount,
      };
      const dag = layoutDagre(graph);
      out.dagre = { ms: Number(dag.ms.toFixed(1)), quality: dag.quality };
      const mod = layoutByModule(graph);
      out.gridByModule = { ms: Number(mod.ms.toFixed(1)), quality: mod.quality };
      try {
        const elk = await layoutElk(graph);
        out.elkLayered = { ms: Number(elk.ms.toFixed(1)), quality: elk.quality };
      } catch (e) {
        out.elkLayered = { error: e instanceof Error ? e.message : String(e) };
      }
      return out;
    },
  };
}

export function installBench(hooks: BenchHooks) {
  window.__bench = makeBench(hooks);
}
