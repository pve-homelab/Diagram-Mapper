/**
 * Keyboard traversal index.
 *
 * The WCAG problem with a node-link canvas is not "can you focus a node" — it is that
 * 10,000 focusable nodes make Tab useless. So the canvas is **one** tab stop with a
 * roving cursor inside it, and traversal follows the graph rather than the DOM:
 *
 *   ArrowDown  -> a dependency of the current node   (`from depends on to`, so outgoing)
 *   ArrowUp    -> a dependent of the current node    (incoming)
 *   ArrowLeft/Right -> previous/next sibling in the same module, in layout order
 *   Enter      -> select (or expand a collapsed module)
 *   Escape     -> clear selection
 *   /          -> search
 *   g          -> the equivalent structure list
 *
 * Sibling order is *layout order* (reading order on screen), not id order, so the
 * keyboard path and the visual path agree.
 */
import type { ViewEdge, ViewNode } from './view';

export interface Neighbours {
  dependencies: string[];
  dependents: string[];
  nextSibling: string | null;
  prevSibling: string | null;
}

export type NeighbourIndex = Map<string, Neighbours>;

export function buildNeighbourIndex(nodes: ViewNode[], edges: ViewEdge[]): NeighbourIndex {
  const index: NeighbourIndex = new Map();
  const real = nodes.filter((n) => n.type !== 'groupRegion');

  for (const n of real) {
    index.set(n.id, { dependencies: [], dependents: [], nextSibling: null, prevSibling: null });
  }
  for (const e of edges) {
    index.get(e.source)?.dependencies.push(e.target);
    index.get(e.target)?.dependents.push(e.source);
  }

  // siblings = same module, ordered by on-screen position (row-major)
  const byModule = new Map<string, ViewNode[]>();
  for (const n of real) {
    const key = n.moduleKey ?? 'root';
    const arr = byModule.get(key) ?? [];
    arr.push(n);
    byModule.set(key, arr);
  }
  for (const group of byModule.values()) {
    group.sort((a, b) => (Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x));
    for (let i = 0; i < group.length; i++) {
      const entry = index.get(group[i].id)!;
      entry.nextSibling = group[(i + 1) % group.length].id;
      entry.prevSibling = group[(i - 1 + group.length) % group.length].id;
    }
  }
  return index;
}
