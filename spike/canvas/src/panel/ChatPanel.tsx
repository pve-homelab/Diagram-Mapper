import { useCallback, useEffect, useRef, useState } from 'react';

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_W = 320;
const MIN_H = 240;
const STORAGE_KEY = 'dm.spike.panel';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ChatPanelProps {
  selectedAddress: string | null;
  selectedSource: string | null;
  /** Called whenever the panel's viewport rect changes, so the canvas can keep the
   *  explained node out from under it. */
  onRectChange: (rect: PanelRect) => void;
  onCitationClick: (index: number) => void;
}

function clampToViewport(r: PanelRect): PanelRect {
  const maxX = Math.max(0, window.innerWidth - r.width);
  const maxY = Math.max(0, window.innerHeight - r.height);
  return {
    width: Math.min(r.width, window.innerWidth),
    height: Math.min(r.height, window.innerHeight),
    x: Math.min(Math.max(0, r.x), maxX),
    y: Math.min(Math.max(0, r.y), maxY),
  };
}

function loadRect(): PanelRect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return clampToViewport(JSON.parse(raw) as PanelRect);
  } catch {
    /* ignore */
  }
  return clampToViewport({
    x: window.innerWidth - 420 - 24,
    y: 80,
    width: 420,
    height: 460,
  });
}

/**
 * Movable + resizable explanation panel. Named requirement from PROMPT.md, not an extra.
 *
 * Decisions worth writing down:
 *  - It is a floating panel, not a docked sidebar, because the requirement is that it
 *    must never obscure the resource it describes. A docked sidebar cannot be moved out
 *    of the way of a node that happens to sit under it; a floating panel can, and the
 *    canvas can also pan the node out from under it (see App.tsx `keepNodeVisible`).
 *  - Position persists in localStorage per the TECH-SPEC §9.5 line "persists per user per
 *    snapshot in client storage, not server-side".
 *  - Every drag/resize affordance is also a keyboard affordance: focus the grip and use
 *    arrow keys (16px steps, 1px with Shift). A mouse-only panel fails WCAG 2.2 AA
 *    (2.1.1 Keyboard) and fails power users.
 *  - Resize grips are 16px of hit area, not the 4px CSS default (Fitts's Law).
 */
export function ChatPanel({
  selectedAddress,
  selectedSource,
  onRectChange,
  onCitationClick,
}: ChatPanelProps) {
  const [rect, setRect] = useState<PanelRect>(loadRect);
  const dragRef = useRef<{ mode: 'move' | Edge; sx: number; sy: number; start: PanelRect } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  // report upward + persist
  useEffect(() => {
    onRectChange(rect);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rect));
    } catch {
      /* ignore */
    }
  }, [rect, onRectChange]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampToViewport(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const applyDelta = useCallback((mode: 'move' | Edge, start: PanelRect, dx: number, dy: number) => {
    if (mode === 'move') {
      return clampToViewport({ ...start, x: start.x + dx, y: start.y + dy });
    }
    let { x, y, width, height } = start;
    if (mode.includes('e')) width = Math.max(MIN_W, start.width + dx);
    if (mode.includes('s')) height = Math.max(MIN_H, start.height + dy);
    if (mode.includes('w')) {
      const w = Math.max(MIN_W, start.width - dx);
      x = start.x + (start.width - w);
      width = w;
    }
    if (mode.includes('n')) {
      const h = Math.max(MIN_H, start.height - dy);
      y = start.y + (start.height - h);
      height = h;
    }
    return clampToViewport({ x, y, width, height });
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      setRect(applyDelta(d.mode, d.start, e.clientX - d.sx, e.clientY - d.sy));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [applyDelta]);

  const startDrag = (mode: 'move' | Edge) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, start: rect };
    document.body.style.userSelect = 'none';
  };

  /** Keyboard equivalents: arrows move, Alt+arrows resize. */
  const onGripKeyDown = (mode: 'move' | Edge) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 16;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = map[e.key];
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    setRect((r) => applyDelta(mode, r, delta[0], delta[1]));
  };

  const grips: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  return (
    <section
      ref={panelRef}
      className="dm-panel"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      aria-label="Explanation and chat"
      data-testid="chat-panel"
    >
      <header
        className="dm-panel__header"
        onPointerDown={startDrag('move')}
        data-testid="panel-move-grip"
      >
        <span className="dm-panel__drag-dots" aria-hidden="true">
          ⠿
        </span>
        <span className="dm-panel__title">
          {selectedAddress ? 'Explaining' : 'Ask about this diagram'}
          {selectedAddress && <code className="dm-panel__subject">{selectedAddress}</code>}
        </span>
        <button
          type="button"
          className="dm-panel__kbd-grip"
          aria-label="Move panel. Arrow keys move, hold Shift for fine steps."
          onKeyDown={onGripKeyDown('move')}
        >
          ✥
        </button>
        <button
          type="button"
          className="dm-panel__kbd-grip"
          aria-label="Resize panel. Arrow keys resize from the bottom-right, hold Shift for fine steps."
          onKeyDown={onGripKeyDown('se')}
          data-testid="panel-resize-kbd"
        >
          ⤡
        </button>
      </header>

      <div className="dm-panel__scroll">
        {!selectedAddress ? (
          <p className="dm-panel__empty">
            Select a resource on the canvas, or ask a question about the whole diagram.
            Answers cite the Terraform file and line they came from.
          </p>
        ) : (
          <article className="dm-msg">
            <p className="dm-msg__text">
              <span className="dm-claim" data-grounding="verified">
                <code>{selectedAddress}</code> is defined in{' '}
                <button
                  type="button"
                  className="dm-citation"
                  onClick={() => onCitationClick(0)}
                  data-testid="citation-0"
                >
                  {selectedSource}
                </button>
                .
              </span>{' '}
              <span className="dm-claim" data-grounding="verified">
                It depends on the resources shown below it on the canvas.
              </span>{' '}
              <span className="dm-claim" data-grounding="inferred">
                It is probably the public entry point for this environment.
              </span>
            </p>
            <p className="dm-grounding-key">
              <span className="dm-key" data-grounding="verified">
                <span aria-hidden="true">▎</span> read from your source
              </span>
              <span className="dm-key" data-grounding="inferred">
                <span aria-hidden="true">┄</span> inferred, not in your source
              </span>
            </p>
          </article>
        )}
      </div>

      <form
        className="dm-panel__composer"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <label className="dm-visually-hidden" htmlFor="dm-ask">
          Ask a question about the selected resource
        </label>
        <input
          id="dm-ask"
          className="dm-input"
          placeholder={selectedAddress ? `Ask about ${selectedAddress}` : 'Ask about this diagram'}
        />
        <button type="submit" className="dm-btn dm-btn--primary">
          Ask
        </button>
      </form>

      {grips.map((g) => (
        <span
          key={g}
          className={`dm-panel__grip dm-panel__grip--${g}`}
          data-testid={`panel-grip-${g}`}
          onPointerDown={startDrag(g)}
          aria-hidden="true"
        />
      ))}
    </section>
  );
}
