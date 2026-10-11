import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeKind } from '../synth';

export type DetailLevel = 'full' | 'compact' | 'dot';

export interface ResourceNodeData extends Record<string, unknown> {
  label: string;
  address: string;
  kind: NodeKind;
  category: string;
  typeLabel: string | null;
  multiplicity: string | null;
  diagnostics: number;
  detail: DetailLevel;
  sourcePath: string;
}

/** One glyph per category, so colour is never the only signal. */
const GLYPH: Record<string, string> = {
  compute: '▣',
  network: '◇',
  storage: '▤',
  database: '◍',
  identity: '◆',
  security: '⬟',
  observability: '◉',
  messaging: '▷',
  lookup: '⌕',
  module: '▥',
  config: '○',
  unknown: '?',
};

/**
 * Level of detail is the single highest-leverage technique in this spike: React Flow
 * still mounts a DOM node per visible node, so the cost is the DOM subtree size, not the
 * node count. At `dot` the subtree is one div; at `full` it is nine elements.
 */
function ResourceNodeImpl({ data, selected }: NodeProps) {
  const d = data as ResourceNodeData;
  const colour = `var(--dm-cat-${d.category}, var(--dm-cat-config))`;

  if (d.detail === 'dot') {
    return (
      <div
        className="dm-node dm-node--dot"
        style={{ background: colour }}
        data-selected={selected || undefined}
        aria-hidden="true"
      />
    );
  }

  return (
    <div className="dm-node" data-detail={d.detail} data-selected={selected || undefined}>
      <Handle type="target" position={Position.Top} className="dm-handle" />
      <span className="dm-node__rail" style={{ background: colour }} aria-hidden="true" />
      <span className="dm-node__glyph" style={{ color: colour }} aria-hidden="true">
        {GLYPH[d.category] ?? '○'}
      </span>
      <span className="dm-node__body">
        <span className="dm-node__label">{d.label}</span>
        {d.detail === 'full' && (
          <span className="dm-node__meta">
            {d.typeLabel ?? d.kind}
            {d.multiplicity ? <span className="dm-node__mult"> {d.multiplicity}</span> : null}
          </span>
        )}
      </span>
      {d.diagnostics > 0 && d.detail === 'full' && (
        <span className="dm-node__diag" title="This resource has a parse diagnostic">
          !
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="dm-handle" />
    </div>
  );
}

export const ResourceNode = memo(ResourceNodeImpl);

export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Gestalt common region: a module is an enclosure with its own label, not a colour.
 * Collapsed, it is one node standing in for its whole subtree — the progressive-disclosure
 * default that makes a 10,000-node repository open in a comprehensible state.
 */
function GroupNodeImpl({ data, selected }: NodeProps) {
  const d = data as GroupNodeData;
  if (d.collapsed) {
    return (
      <div className="dm-group dm-group--collapsed" data-selected={selected || undefined}>
        <Handle type="target" position={Position.Top} className="dm-handle" />
        <span className="dm-group__glyph" aria-hidden="true">
          ▥
        </span>
        <span className="dm-group__body">
          <span className="dm-group__label">module.{d.label}</span>
          <span className="dm-group__count">{d.count} resources</span>
        </span>
        <Handle type="source" position={Position.Bottom} className="dm-handle" />
      </div>
    );
  }
  return (
    <div className="dm-group" data-selected={selected || undefined}>
      <span className="dm-group__header">
        <span className="dm-group__glyph" aria-hidden="true">
          ▥
        </span>
        module.{d.label}
        <span className="dm-group__count">{d.count}</span>
      </span>
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
