import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './app.css';
import { generateGraph, type SynthGraph } from './synth';
import { buildView, detailForZoom, moduleKeyOf, multiplicityLabel, type ViewModel } from './view';
import { GroupNode, ResourceNode, type DetailLevel } from './nodes/ResourceNode';
import { ChatPanel, type PanelRect } from './panel/ChatPanel';
import { installBench } from './bench';
import { buildNeighbourIndex, type NeighbourIndex } from './keyboard';

const nodeTypes: NodeTypes = {
  resource: ResourceNode,
  groupProxy: GroupNode,
  groupRegion: GroupNode,
};

type LayoutChoice = 'grid-by-module' | 'dagre' | 'elk-layered';

interface Config {
  nodeCount: number;
  layout: LayoutChoice;
  lod: boolean;
  culling: boolean;
  collapseDefault: boolean;
  edgeFactor: number;
  theme: 'light' | 'dark';
  seed: number;
}

function readConfig(): Config {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const flag = (k: string, d: boolean) => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : d);
  return {
    nodeCount: num('nodes', 500),
    layout: (q.get('layout') as LayoutChoice) || 'grid-by-module',
    lod: flag('lod', true),
    culling: flag('culling', true),
    collapseDefault: flag('collapse', true),
    edgeFactor: num('edgeFactor', 1.6),
    theme: q.get('theme') === 'dark' ? 'dark' : 'light',
    seed: num('seed', 1337),
  };
}

function CanvasApp() {
  const cfg = useMemo(readConfig, []);
  const rf = useReactFlow();

  const [graph, setGraph] = useState<SynthGraph | null>(null);
  const [view, setView] = useState<ViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DetailLevel>('full');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [panelRect, setPanelRect] = useState<PanelRect | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState('');
  const [showList, setShowList] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = cfg.theme;
  }, [cfg.theme]);

  // --- load synthetic graph ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    try {
      const g = generateGraph({
        nodeCount: cfg.nodeCount,
        seed: cfg.seed,
        edgeFactor: cfg.edgeFactor,
      });
      if (cancelled) return;
      setGraph(g);
      // Progressive disclosure default: everything except the root module starts collapsed.
      setCollapsed(
        cfg.collapseDefault
          ? new Set(g.modules.map((m) => m.path.join('/')).filter((k) => k && k !== 'root'))
          : new Set(),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
    return () => {
      cancelled = true;
    };
  }, [cfg.nodeCount, cfg.seed, cfg.edgeFactor, cfg.collapseDefault]);

  // --- build the view (collapse + aggregate + layout) -------------------------------
  const rebuild = useCallback(
    async (g: SynthGraph, nextCollapsed: Set<string>, layout: LayoutChoice) => {
      setBusy(true);
      try {
        const vm = await buildView(g, { collapsed: nextCollapsed, layout });
        setView(vm);
        performance.mark('dm:view-built');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (graph) void rebuild(graph, collapsed, cfg.layout);
  }, [graph, collapsed, cfg.layout, rebuild]);

  // --- React Flow nodes / edges -----------------------------------------------------
  const toggleModule = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rfNodes: Node[] = useMemo(() => {
    if (!view) return [];
    return view.nodes.map((vn) => {
      if (vn.type === 'resource') {
        const n = vn.node!;
        return {
          id: vn.id,
          type: 'resource',
          position: { x: vn.x, y: vn.y },
          width: vn.width,
          height: vn.height,
          selected: vn.id === selectedId,
          data: {
            label: n.display.label,
            address: n.address,
            kind: n.kind,
            category: n.display.group,
            typeLabel: n.type,
            multiplicity: multiplicityLabel(n),
            diagnostics: n.diagnostics,
            detail: cfg.lod ? detail : 'full',
            sourcePath: `${n.source.path}:${n.source.startLine}`,
          },
        } satisfies Node;
      }
      if (vn.type === 'groupProxy') {
        return {
          id: vn.id,
          type: 'groupProxy',
          position: { x: vn.x, y: vn.y },
          width: vn.width,
          height: vn.height,
          selected: vn.id === selectedId,
          data: {
            label: vn.label,
            count: vn.count ?? 0,
            collapsed: true,
            onToggle: () => toggleModule(vn.moduleKey!),
          },
        } satisfies Node;
      }
      return {
        id: vn.id,
        type: 'groupRegion',
        position: { x: vn.x, y: vn.y },
        width: vn.width,
        height: vn.height,
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -1,
        style: { width: vn.width, height: vn.height },
        data: { label: vn.label, count: vn.count ?? 0, collapsed: false, onToggle: () => {} },
      } satisfies Node;
    });
  }, [view, selectedId, detail, cfg.lod, toggleModule]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!view) return [];
    // At `dot` detail the edges carry no information a user can read, and they are the
    // dominant cost. Drawing them straight instead of bezier is the cheapest real win.
    const straight = detail !== 'full';
    return view.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: straight ? 'straight' : 'default',
      label: e.count > 1 && detail === 'full' ? `×${e.count}` : undefined,
      className: `dm-edge dm-edge--${e.kind}${e.aggregated ? ' dm-edge--agg' : ''}`,
    }));
  }, [view, detail]);

  // --- level of detail on zoom ------------------------------------------------------
  const onMove = useCallback(() => {
    if (!cfg.lod) return;
    const z = rf.getZoom();
    const next = detailForZoom(z);
    setDetail((prev) => (prev === next ? prev : next));
  }, [cfg.lod, rf]);

  // --- keyboard traversal -----------------------------------------------------------
  const neighbours: NeighbourIndex = useMemo(
    () => buildNeighbourIndex(view?.nodes ?? [], view?.edges ?? []),
    [view],
  );

  const describe = useCallback(
    (id: string) => {
      const vn = view?.nodes.find((n) => n.id === id);
      if (!vn) return '';
      const nb = neighbours.get(id);
      const deps = nb?.dependencies.length ?? 0;
      const dependents = nb?.dependents.length ?? 0;
      if (vn.type === 'groupProxy') {
        return `module ${vn.label}, collapsed, ${vn.count} resources. ${deps} dependencies, ${dependents} dependents. Press Enter to expand.`;
      }
      const n = vn.node!;
      return `${n.address}. ${n.kind}${n.type ? ` ${n.type}` : ''} in ${
        moduleKeyOf(n) === 'root' ? 'the root module' : `module ${moduleKeyOf(n)}`
      }. ${deps} dependencies, ${dependents} dependents. Defined in ${n.source.path} line ${
        n.source.startLine
      }.`;
    },
    [view, neighbours],
  );

  const moveFocus = useCallback(
    (id: string | null) => {
      if (!id) return;
      setFocusId(id);
      setAnnouncement(describe(id));
      const vn = view?.nodes.find((n) => n.id === id);
      if (vn) {
        rf.setCenter(vn.x + vn.width / 2, vn.y + vn.height / 2, {
          zoom: Math.max(rf.getZoom(), 0.5),
          duration: 180,
        });
      }
    },
    [describe, rf, view],
  );

  const onPaneKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!view) return;
      const first = view.nodes.find((n) => n.type !== 'groupRegion')?.id ?? null;
      const current = focusId ?? first;
      const nb = current ? neighbours.get(current) : undefined;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(nb?.dependencies[0] ?? current);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(nb?.dependents[0] ?? current);
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveFocus(nb?.nextSibling ?? current);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          moveFocus(nb?.prevSibling ?? current);
          break;
        case 'Enter': {
          e.preventDefault();
          if (!current) break;
          const vn = view.nodes.find((n) => n.id === current);
          if (vn?.type === 'groupProxy') {
            toggleModule(vn.moduleKey!);
            setAnnouncement(`Expanded module ${vn.label}, ${vn.count} resources now shown.`);
          } else {
            setSelectedId(current);
            setAnnouncement(`Selected. ${describe(current)}`);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          setSelectedId(null);
          setAnnouncement('Selection cleared.');
          break;
        case '/':
          e.preventDefault();
          document.getElementById('dm-search')?.focus();
          break;
        case 'g':
          e.preventDefault();
          setShowList((s) => !s);
          break;
        default:
          break;
      }
    },
    [view, focusId, neighbours, moveFocus, toggleModule, describe],
  );

  // --- do not obscure the thing being explained -------------------------------------
  /**
   * The panel is movable, so the user decides where it sits. When a selection would end
   * up underneath it, we move the *viewport*, not the panel — moving the user's panel out
   * from under their cursor is the wrong correction. We pan the node into the largest
   * free rectangle left by the panel.
   */
  const keepNodeVisible = useCallback(
    (nodeId: string) => {
      if (!panelRect || !view || !paneRef.current) return;
      const vn = view.nodes.find((n) => n.id === nodeId);
      if (!vn) return;
      const pane = paneRef.current.getBoundingClientRect();
      const MARGIN = 24;

      // free space on each side of the panel, in viewport px
      const regions = [
        { name: 'left', w: panelRect.x - pane.left, cx: pane.left + (panelRect.x - pane.left) / 2 },
        {
          name: 'right',
          w: pane.right - (panelRect.x + panelRect.width),
          cx: panelRect.x + panelRect.width + (pane.right - (panelRect.x + panelRect.width)) / 2,
        },
      ];
      const best = regions.sort((a, b) => b.w - a.w)[0];

      const zoom = rf.getZoom();
      const nodeCx = vn.x + vn.width / 2;
      const nodeCy = vn.y + vn.height / 2;

      let targetScreenX = best.cx;
      // If neither side is wide enough for the node, fall back to vertical free space.
      if (best.w < vn.width * zoom + MARGIN * 2) {
        const above = panelRect.y - pane.top;
        const below = pane.bottom - (panelRect.y + panelRect.height);
        const cy = above > below ? pane.top + above / 2 : panelRect.y + panelRect.height + below / 2;
        targetScreenX = pane.left + pane.width / 2;
        const dxFlow = (targetScreenX - pane.left - pane.width / 2) / zoom;
        const dyFlow = (cy - pane.top - pane.height / 2) / zoom;
        rf.setCenter(nodeCx - dxFlow, nodeCy - dyFlow, { zoom, duration: 200 });
        return;
      }

      const dxFlow = (targetScreenX - pane.left - pane.width / 2) / zoom;
      rf.setCenter(nodeCx - dxFlow, nodeCy, { zoom, duration: 200 });
    },
    [panelRect, rf, view],
  );

  useEffect(() => {
    if (selectedId) keepNodeVisible(selectedId);
    // keepNodeVisible changes with panelRect; re-running on panel move is intentional —
    // if the user drags the panel over the selected node, the node moves out from under it.
  }, [selectedId, keepNodeVisible]);

  // --- bench instrumentation --------------------------------------------------------
  useEffect(() => {
    installBench({
      getConfig: () => cfg,
      getGraph: () => graph,
      getView: () => view,
      getDetail: () => detail,
      getPanelRect: () => panelRect,
      getPaneRect: () => paneRef.current?.getBoundingClientRect() ?? null,
      getFlow: () => rf,
      selectNode: (id) => setSelectedId(id),
      setCollapsedAll: (on) => {
        if (!graph) return;
        setCollapsed(
          on
            ? new Set(graph.modules.map((m) => m.path.join('/')).filter((k) => k && k !== 'root'))
            : new Set(),
        );
      },
      isBusy: () => busy,
      getSelected: () => selectedId,
    });
  }, [cfg, graph, view, detail, panelRect, rf, busy, selectedId]);

  const selectedNode = useMemo(
    () => view?.nodes.find((n) => n.id === selectedId)?.node ?? null,
    [view, selectedId],
  );

  const matches = useMemo(() => {
    if (!query.trim() || !graph) return [];
    const q = query.toLowerCase();
    return graph.nodes.filter((n) => n.address.toLowerCase().includes(q)).slice(0, 50);
  }, [query, graph]);

  // --- states ----------------------------------------------------------------------
  if (error) {
    return (
      <div className="dm-state dm-state--error" role="alert">
        <h1>We could not build this diagram</h1>
        <p className="dm-state__detail">{error}</p>
        <button type="button" className="dm-btn dm-btn--primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="dm-shell">
      <header className="dm-topbar">
        <span className="dm-brand">Diagram Mapper <span className="dm-brand__tag">spike</span></span>
        <label className="dm-visually-hidden" htmlFor="dm-search">
          Search resources
        </label>
        <input
          id="dm-search"
          className="dm-input dm-input--search"
          placeholder="Search resources  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              setSelectedId(matches[0].id);
              moveFocus(matches[0].id);
            }
            if (e.key === 'Escape') paneRef.current?.focus();
          }}
          autoComplete="off"
        />
        <div className="dm-topbar__stats" data-testid="stats">
          {view ? (
            <>
              <span>{view.counts.visibleNodes.toLocaleString()} shown</span>
              <span aria-hidden="true">·</span>
              <span>{graph?.stats.nodeCount.toLocaleString()} total</span>
              <span aria-hidden="true">·</span>
              <span>{view.counts.visibleEdges.toLocaleString()} edges</span>
              <span aria-hidden="true">·</span>
              <span>{view.counts.collapsedModules} modules collapsed</span>
            </>
          ) : (
            <span>Loading…</span>
          )}
        </div>
        <button
          type="button"
          className="dm-btn"
          onClick={() => setCollapsed(new Set())}
          data-testid="expand-all"
        >
          Expand all
        </button>
        <button
          type="button"
          className="dm-btn"
          onClick={() => {
            if (!graph) return;
            setCollapsed(
              new Set(graph.modules.map((m) => m.path.join('/')).filter((k) => k && k !== 'root')),
            );
          }}
          data-testid="collapse-all"
        >
          Collapse all
        </button>
        <button
          type="button"
          className="dm-btn"
          aria-pressed={showList}
          onClick={() => setShowList((s) => !s)}
          data-testid="toggle-list"
        >
          Structure list
        </button>
      </header>

      {matches.length > 0 && (
        <ul className="dm-results" role="listbox" aria-label="Search results">
          {matches.slice(0, 8).map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(n.id);
                  moveFocus(n.id);
                  setQuery('');
                }}
              >
                <code>{n.address}</code>
                <span>{n.source.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="dm-main">
        <div
          className="dm-canvas"
          ref={paneRef}
          tabIndex={0}
          role="application"
          aria-label="Infrastructure diagram. Arrow keys traverse dependencies, Enter selects, slash searches, g toggles the structure list."
          aria-describedby="dm-canvas-help"
          onKeyDown={onPaneKeyDown}
          data-testid="canvas"
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onlyRenderVisibleElements={cfg.culling}
            minZoom={0.04}
            maxZoom={2.5}
            fitView
            proOptions={{ hideAttribution: false }}
            nodesDraggable={false}
            elevateNodesOnSelect={false}
            onMove={onMove}
            onNodeClick={(_, n) => {
              if (n.type === 'groupProxy') {
                const key = n.id.replace(/^g:/, '');
                toggleModule(key);
                return;
              }
              setSelectedId(n.id);
              setFocusId(n.id);
            }}
            onPaneClick={() => setSelectedId(null)}
            defaultEdgeOptions={{ type: 'default' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <Controls showInteractive={false} />
            {(view?.counts.visibleNodes ?? 0) <= 2500 && (
              <MiniMap pannable zoomable ariaLabel="Diagram overview" />
            )}
          </ReactFlow>

          {focusId && (
            <FocusRing nodeId={focusId} view={view} />
          )}

          {busy && (
            <div className="dm-overlay" role="status">
              <span className="dm-spinner" aria-hidden="true" />
              Laying out {graph?.stats.nodeCount.toLocaleString() ?? ''} resources…
            </div>
          )}

          {!busy && view && view.counts.visibleNodes === 0 && (
            <div className="dm-overlay dm-overlay--empty">
              <h2>Nothing to show yet</h2>
              <p>Every module is collapsed and the root module is empty.</p>
              <button type="button" className="dm-btn dm-btn--primary" onClick={() => setCollapsed(new Set())}>
                Expand all modules
              </button>
            </div>
          )}

          <p id="dm-canvas-help" className="dm-visually-hidden">
            This canvas has a keyboard-equivalent list view. Press g, or use the Structure
            list button, to explore the same graph as a searchable list of resources with
            their dependencies.
          </p>
          <div className="dm-live" role="status" aria-live="polite">
            {announcement}
          </div>
        </div>

        {showList && graph && (
          <nav className="dm-list" aria-label="Structure list">
            <h2>Modules</h2>
            <ul>
              {graph.modules.map((m) => {
                const key = m.path.join('/') || 'root';
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="dm-list__module"
                      aria-expanded={!collapsed.has(key)}
                      onClick={() => toggleModule(key)}
                    >
                      <span>{key === 'root' ? 'root module' : `module.${key}`}</span>
                      <span className="dm-list__count">{m.nodeIds.length}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>

      <ChatPanel
        selectedAddress={selectedNode?.address ?? null}
        selectedSource={
          selectedNode ? `${selectedNode.source.path}:${selectedNode.source.startLine}` : null
        }
        onRectChange={setPanelRect}
        onCitationClick={() => {
          if (selectedId) moveFocus(selectedId);
        }}
      />
    </div>
  );
}

/** A focus ring drawn in flow coordinates, so keyboard focus is visible without
 *  mounting a DOM node per graph node. */
function FocusRing({ nodeId, view }: { nodeId: string; view: ViewModel | null }) {
  const rf = useReactFlow();
  const vn = view?.nodes.find((n) => n.id === nodeId);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  if (!vn) return null;
  const vp = rf.getViewport();
  return (
    <span
      className="dm-focus-ring"
      data-testid="focus-ring"
      style={{
        left: vn.x * vp.zoom + vp.x - 4,
        top: vn.y * vp.zoom + vp.y - 4,
        width: vn.width * vp.zoom + 8,
        height: vn.height * vp.zoom + 8,
      }}
      aria-hidden="true"
    />
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <CanvasApp />
    </ReactFlowProvider>
  );
}
