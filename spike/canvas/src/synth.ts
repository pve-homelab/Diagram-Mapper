/**
 * Synthetic graph generator for the AIS-5 canvas spike.
 *
 * Shapes match the `GraphNode` / `GraphEdge` contract in docs/TECH-SPEC.md §4.5-4.6 so
 * that the measurements transfer to the real payload: same field count, same `contains`
 * tree, same edge kinds, same `from depends on to` direction.
 *
 * Realism targets, taken from the shape of public Terraform repositories:
 *   - ~62% resource, ~9% data, ~11% variable, ~7% output, ~6% module_call,
 *     ~3% local, ~1% provider, ~1% unknown_reference
 *   - one `contains` edge per non-root node (the tree the canvas groups by)
 *   - ~1.6 reference edges per node, ~85% of them inside the same module
 *   - module sizes cluster around 12-40 nodes, with a long tail
 */

export type NodeKind =
  | 'resource'
  | 'data'
  | 'variable'
  | 'output'
  | 'module_call'
  | 'local'
  | 'provider'
  | 'unknown_reference';

export type EdgeKind =
  | 'reference'
  | 'explicit_dependency'
  | 'contains'
  | 'module_input'
  | 'module_output'
  | 'provider_assignment'
  | 'iteration';

export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
}

export interface SynthNode {
  id: string;
  stableKey: string;
  kind: NodeKind;
  address: string;
  type: string | null;
  name: string;
  modulePath: string[];
  provider: string | null;
  multiplicity: { kind: 'single' | 'count' | 'for_each'; resolved: number | null };
  source: SourceRef;
  display: { label: string; group: string; icon: string };
  diagnostics: number;
}

export interface SynthEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  provenance: 'static_hcl' | 'plan_json';
  confidence: 'exact';
  attributePath: string[];
  source: SourceRef | null;
  label: string | null;
}

export interface SynthGraph {
  schemaVersion: 1;
  parserVersion: string;
  nodes: SynthNode[];
  edges: SynthEdge[];
  /** Module name -> ids of nodes contained directly in it. Drives group nodes. */
  modules: { path: string[]; label: string; nodeIds: string[] }[];
  stats: { nodeCount: number; edgeCount: number; moduleCount: number; generateMs: number };
}

/** Deterministic PRNG so every benchmark run gets byte-identical input. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RESOURCE_TYPES = [
  ['aws_instance', 'compute'],
  ['aws_security_group', 'network'],
  ['aws_subnet', 'network'],
  ['aws_vpc', 'network'],
  ['aws_s3_bucket', 'storage'],
  ['aws_db_instance', 'database'],
  ['aws_iam_role', 'identity'],
  ['aws_iam_policy', 'identity'],
  ['aws_lb', 'network'],
  ['aws_lb_target_group', 'network'],
  ['aws_autoscaling_group', 'compute'],
  ['aws_lambda_function', 'compute'],
  ['aws_cloudwatch_log_group', 'observability'],
  ['aws_kms_key', 'security'],
  ['aws_route53_record', 'network'],
  ['aws_ecs_service', 'compute'],
  ['aws_ecs_task_definition', 'compute'],
  ['aws_sqs_queue', 'messaging'],
  ['aws_sns_topic', 'messaging'],
  ['aws_dynamodb_table', 'database'],
] as const;

const DATA_TYPES = [
  'aws_ami',
  'aws_availability_zones',
  'aws_caller_identity',
  'aws_iam_policy_document',
  'aws_region',
] as const;

const MODULE_NAMES = [
  'networking', 'compute', 'database', 'observability', 'identity', 'edge', 'secrets',
  'queueing', 'storage', 'cdn', 'bastion', 'eks', 'rds_cluster', 'alb', 'vpc_peering',
  'logging', 'alerting', 'backup', 'dns', 'waf',
];

const KIND_WEIGHTS: [NodeKind, number][] = [
  ['resource', 0.62],
  ['variable', 0.11],
  ['data', 0.09],
  ['output', 0.07],
  ['module_call', 0.06],
  ['local', 0.03],
  ['provider', 0.01],
  ['unknown_reference', 0.01],
];

function pickKind(r: number): NodeKind {
  let acc = 0;
  for (const [kind, w] of KIND_WEIGHTS) {
    acc += w;
    if (r < acc) return kind;
  }
  return 'resource';
}

export interface SynthOptions {
  nodeCount: number;
  seed?: number;
  /** Reference edges per node, before `contains` edges are added. */
  edgeFactor?: number;
  /** Share of reference edges that stay inside one module. */
  intraModuleShare?: number;
}

export function generateGraph(opts: SynthOptions): SynthGraph {
  const t0 = performance.now();
  const { nodeCount, seed = 1337, edgeFactor = 1.6, intraModuleShare = 0.85 } = opts;
  const rand = mulberry32(seed);

  // --- partition nodes into modules ------------------------------------------------
  // Target ~24 nodes per module with a long tail, and a root module that keeps ~12%.
  const rootShare = Math.max(1, Math.round(nodeCount * 0.12));
  const modules: SynthGraph['modules'] = [
    { path: [], label: 'root', nodeIds: [] },
  ];
  let remaining = nodeCount - rootShare;
  let m = 0;
  while (remaining > 0) {
    // 8..56 nodes, long-tailed
    const size = Math.min(remaining, 8 + Math.floor(rand() * rand() * 48));
    const base = MODULE_NAMES[m % MODULE_NAMES.length];
    const label = m < MODULE_NAMES.length ? base : `${base}_${Math.floor(m / MODULE_NAMES.length) + 1}`;
    modules.push({ path: [label], label, nodeIds: [] });
    remaining -= size;
    (modules[modules.length - 1] as { size?: number }).size = size;
    m++;
  }

  const nodes: SynthNode[] = [];
  const nodesByModule: string[][] = modules.map(() => []);
  const perTypeCounter = new Map<string, number>();

  const emit = (moduleIdx: number) => {
    const mod = modules[moduleIdx];
    const i = nodes.length;
    const kind = moduleIdx === 0 && i % 17 === 0 ? 'module_call' : pickKind(rand());

    let type: string | null = null;
    let group = 'config';
    let icon = 'cog';
    if (kind === 'resource') {
      const [t, g] = RESOURCE_TYPES[Math.floor(rand() * RESOURCE_TYPES.length)];
      type = t;
      group = g;
      icon = g;
    } else if (kind === 'data') {
      type = DATA_TYPES[Math.floor(rand() * DATA_TYPES.length)];
      group = 'lookup';
      icon = 'search';
    } else if (kind === 'module_call') {
      group = 'module';
      icon = 'package';
    } else if (kind === 'unknown_reference') {
      group = 'unknown';
      icon = 'question';
    }

    const typeKey = type ?? kind;
    const n = (perTypeCounter.get(typeKey) ?? 0) + 1;
    perTypeCounter.set(typeKey, n);
    const name = `${['web', 'api', 'worker', 'core', 'edge', 'main', 'primary', 'replica'][n % 8]}_${n}`;
    const prefix = mod.path.length ? `module.${mod.path.join('.module.')}.` : '';
    const address =
      kind === 'resource' ? `${prefix}${type}.${name}`
      : kind === 'data' ? `${prefix}data.${type}.${name}`
      : kind === 'module_call' ? `${prefix}module.${name}`
      : `${prefix}${kind === 'local' ? 'local' : kind}.${name}`;

    const mult =
      rand() < 0.12
        ? { kind: 'count' as const, resolved: rand() < 0.7 ? 1 + Math.floor(rand() * 5) : null }
        : rand() < 0.06
          ? { kind: 'for_each' as const, resolved: null }
          : { kind: 'single' as const, resolved: 1 };

    const file = mod.path.length ? `modules/${mod.label}/${group}.tf` : `${group}.tf`;
    const startLine = 1 + ((i * 13) % 400);

    nodes.push({
      id: `n${i}`,
      stableKey: `${address}@${mod.path.join('/')}`,
      kind,
      address,
      type,
      name,
      modulePath: mod.path,
      provider: kind === 'resource' || kind === 'data' ? 'aws' : null,
      multiplicity: mult,
      source: { path: file, startLine, endLine: startLine + 6 },
      display: { label: type ? `${type}.${name}` : `${kind}.${name}`, group, icon },
      // ~4% of nodes carry a soft diagnostic, matching TECH-SPEC §9.4 partial-success
      diagnostics: rand() < 0.04 ? 1 : 0,
    });
    nodesByModule[moduleIdx].push(`n${i}`);
    mod.nodeIds.push(`n${i}`);
  };

  for (let i = 0; i < rootShare; i++) emit(0);
  for (let mi = 1; mi < modules.length; mi++) {
    const size = (modules[mi] as { size?: number }).size ?? 0;
    for (let i = 0; i < size && nodes.length < nodeCount; i++) emit(mi);
  }
  while (nodes.length < nodeCount) emit(0);

  // --- edges ----------------------------------------------------------------------
  const edges: SynthEdge[] = [];
  const seen = new Set<string>();
  const idToModule = new Map<string, number>();
  nodesByModule.forEach((ids, mi) => ids.forEach((id) => idToModule.set(id, mi)));

  const addEdge = (from: string, to: string, kind: EdgeKind, attr: string[]) => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}|${attr.join('.')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fromNode = nodes[Number(from.slice(1))];
    edges.push({
      id: `e${edges.length}`,
      fromNodeId: from,
      toNodeId: to,
      kind,
      provenance: 'static_hcl',
      confidence: 'exact',
      attributePath: attr,
      source: kind === 'contains' ? null : fromNode.source,
      label: null,
    });
  };

  // `contains` tree: every non-root node hangs off its module's group.
  // Group nodes are synthesised at render time, so `contains` is recorded module-wise.

  const refTarget = Math.round(nodeCount * edgeFactor);
  const ATTRS = [
    ['subnet_id'], ['vpc_id'], ['security_group_ids'], ['role'], ['kms_key_id'],
    ['tags', 'Environment'], ['target_group_arn'], ['bucket'], ['policy'], ['log_group_name'],
  ];
  let guard = 0;
  while (edges.length < refTarget && guard < refTarget * 12) {
    guard++;
    const fromIdx = Math.floor(rand() * nodes.length);
    const from = nodes[fromIdx];
    // variables/providers are dependencies, not dependents — they rarely reference out
    if (from.kind === 'variable' || from.kind === 'provider' || from.kind === 'unknown_reference') continue;

    const mi = idToModule.get(from.id)!;
    let candidates: string[];
    if (rand() < intraModuleShare) {
      candidates = nodesByModule[mi];
    } else {
      // cross-module references in real Terraform go through module inputs/outputs
      const otherMi = Math.floor(rand() * modules.length);
      candidates = nodesByModule[otherMi];
    }
    if (!candidates.length) continue;
    const to = candidates[Math.floor(rand() * candidates.length)];
    if (to === from.id) continue;

    const roll = rand();
    const kind: EdgeKind =
      roll < 0.8 ? 'reference'
      : roll < 0.87 ? 'explicit_dependency'
      : roll < 0.92 ? 'module_input'
      : roll < 0.96 ? 'module_output'
      : roll < 0.99 ? 'provider_assignment'
      : 'iteration';
    addEdge(from.id, to, kind, ATTRS[Math.floor(rand() * ATTRS.length)]);
  }

  const generateMs = performance.now() - t0;
  return {
    schemaVersion: 1,
    parserVersion: 'spike-0.1.0',
    nodes,
    edges,
    modules: modules.filter((mod) => mod.nodeIds.length > 0),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      moduleCount: modules.filter((mod) => mod.nodeIds.length > 0).length,
      generateMs,
    },
  };
}
