/**
 * The graph contract the explanation engine consumes.
 *
 * The explanation engine does not parse Terraform. It consumes this structure
 * from the parser (owned by the Backend Engineer, see AIS-4). Everything the
 * engine can cite must be reachable from here, because raw customer IaC is not
 * retained after parsing.
 *
 * Fields the engine depends on and cannot work without are marked REQUIRED-BY-AI.
 */

import type { SourceRef } from "./contract.ts";

export type NodeKind =
  | "resource"
  | "data"
  | "module"
  | "variable"
  | "output"
  | "local"
  | "provider";

export interface Attribute {
  /** Dotted path within the block, e.g. "ingress.0.cidr_blocks" or "instance_type". */
  path: string;
  /** The resolved literal when the value is static; null when it is an expression. */
  literal: string | number | boolean | Array<string | number | boolean> | null;
  /** Verbatim right-hand side as written, when not a literal. */
  expression: string | null;
  /** True when the value derives from a `sensitive = true` variable or a secret-shaped key. */
  sensitive: boolean;
  /** REQUIRED-BY-AI: attribute-level citation target. */
  sourceRef: SourceRef;
}

export interface GraphNode {
  /** Terraform address, e.g. "aws_instance.bastion", "module.network", "var.vpc_cidr". */
  address: string;
  kind: NodeKind;
  /** Resource/data type, e.g. "aws_instance". Null for variables/outputs/locals. */
  type: string | null;
  name: string;
  provider: string | null;
  /** REQUIRED-BY-AI: the whole block, for node-level citation. */
  sourceRef: SourceRef;
  attributes: Attribute[];
}

export type EdgeKind = "reference" | "depends_on" | "module_input" | "provider";

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The attribute path on `from` that creates the edge, e.g. "vpc_security_group_ids". */
  via: string;
  /** REQUIRED-BY-AI: where the reference is written, so relationships can be cited. */
  sourceRef: SourceRef;
}

export interface FileRecord {
  path: string;
  lineCount: number;
  /** sha256 of the file at `commitSha`. Lets us detect drift without keeping the file. */
  sha256: string;
}

export interface Graph {
  /** REQUIRED-BY-AI: citations are only meaningful against a pinned commit. */
  commitSha: string;
  repoId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: FileRecord[];
  /** Parse problems. The engine must never present a partially parsed repo as complete. */
  diagnostics: { file: string; line: number; message: string; severity: "error" | "warn" }[];
}

/* ---------------------------------------------------------------- accessors */

export function nodeByAddress(g: Graph, address: string): GraphNode | undefined {
  return g.nodes.find((n) => n.address === address);
}

/** Edges where `address` is the source: what this resource references. */
export function outgoing(g: Graph, address: string): GraphEdge[] {
  return g.edges.filter((e) => e.from === address);
}

/** Edges where `address` is the target: what references this resource. */
export function incoming(g: Graph, address: string): GraphEdge[] {
  return g.edges.filter((e) => e.to === address);
}

/**
 * Transitive set of nodes that would be affected if `address` changed or was
 * destroyed — everything that references it, recursively. Deterministic; never
 * asked of the model.
 */
export function blastRadius(g: Graph, address: string, maxDepth = 6): string[] {
  const seen = new Set<string>();
  let frontier = [address];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const a of frontier) {
      for (const e of incoming(g, a)) {
        if (!seen.has(e.from) && e.from !== address) {
          seen.add(e.from);
          next.push(e.from);
        }
      }
    }
    frontier = next;
  }
  return [...seen].sort();
}

export function attributeByPath(n: GraphNode, path: string): Attribute | undefined {
  return n.attributes.find((a) => a.path === path);
}
