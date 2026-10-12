// Spike quality. Throwaway.
//
// Builds a resource graph for one Terraform module unit (= one directory, which
// is Terraform's own unit of evaluation: all .tf files in a directory are merged
// into a single namespace).
//
// Invariants this code is written to hold, because they are the product's
// correctness bar:
//   1. An edge is only emitted when both endpoints resolve to a declared block.
//   2. Anything that does not resolve becomes an `unresolved` record carrying
//      file + line + the offending expression. Never a guessed edge.
//   3. Node ids are the Terraform address, so re-parsing the same commit yields
//      byte-identical output (idempotent ingestion).

import { parse } from '@cdktf/hcl2json';
import fs from 'node:fs';
import path from 'node:path';
import { indexFile, findAttributeLine, findTextLine } from './locate.mjs';
import { walkRefs, interpolations, traversalsIn } from './refs.mjs';

const LITERAL_INT = /^[0-9]+$/;

export async function parseUnit(dir, repoRoot) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tf'))
    .sort();

  const nodes = new Map();
  const edges = [];
  const unresolved = [];
  const diagnostics = [];
  const ignoredTraversals = new Map();

  /** per-file: { rel, lines, blocks, json } */
  const parsed = [];

  for (const f of files) {
    const abs = path.join(dir, f);
    const rel = path.relative(repoRoot, abs);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      diagnostics.push({ file: rel, line: null, severity: 'error', message: `unreadable: ${e.message}` });
      continue;
    }
    const { blocks, lines } = indexFile(source);
    annotateOccurrences(blocks);
    let json;
    try {
      json = await parse(f, source);
    } catch (e) {
      // A parse failure must name the file and, where the error carries it, the line.
      const loc = /:(\d+),(\d+)-/.exec(String(e.message ?? e));
      diagnostics.push({
        file: rel,
        line: loc ? Number(loc[1]) : null,
        severity: 'error',
        message: `HCL parse failed: ${String(e.message ?? e).split('\n')[0]}`,
      });
      continue;
    }
    parsed.push({ rel, lines, blocks, json });
  }

  // ---- Pass 1: declare every node, with its source position. -------------
  for (const pf of parsed) {
    const { rel, lines, blocks, json } = pf;
    const queue = (kind) => blocks.filter((b) => b.kind === kind);

    for (const b of queue('resource')) {
      const [type, name] = b.labels;
      if (!type || !name) continue;
      const body = pick(json, ['resource', type, name], b.occurrence);
      addNode(nodes, {
        id: `${type}.${name}`,
        kind: 'resource',
        type,
        name,
        provider: type.split('_')[0],
        file: rel,
        line: b.line,
        endLine: b.endLine,
        multiplicity: multiplicityOf(body, lines, b),
        dynamicBlocks: dynamicBlocksOf(body, lines, b),
      }, diagnostics);
    }

    for (const b of queue('data')) {
      const [type, name] = b.labels;
      if (!type || !name) continue;
      const body = pick(json, ['data', type, name], b.occurrence);
      addNode(nodes, {
        id: `data.${type}.${name}`,
        kind: 'data',
        type,
        name,
        provider: type.split('_')[0],
        file: rel,
        line: b.line,
        endLine: b.endLine,
        multiplicity: multiplicityOf(body, lines, b),
        dynamicBlocks: dynamicBlocksOf(body, lines, b),
      }, diagnostics);
    }

    for (const b of queue('module')) {
      const [name] = b.labels;
      if (!name) continue;
      const body = pick(json, ['module', name], b.occurrence);
      const source = firstString(body, 'source');
      addNode(nodes, {
        id: `module.${name}`,
        kind: 'module',
        name,
        file: rel,
        line: b.line,
        endLine: b.endLine,
        source,
        sourceKind: classifySource(source),
        version: firstString(body, 'version'),
        multiplicity: multiplicityOf(body, lines, b),
      }, diagnostics);
    }

    for (const b of queue('variable')) {
      const [name] = b.labels;
      if (!name) continue;
      const body = pick(json, ['variable', name], b.occurrence);
      addNode(nodes, {
        id: `var.${name}`,
        kind: 'variable',
        name,
        file: rel,
        line: b.line,
        endLine: b.endLine,
        hasDefault: !!body && Object.prototype.hasOwnProperty.call(body, 'default'),
      }, diagnostics);
    }

    for (const b of queue('output')) {
      const [name] = b.labels;
      if (!name) continue;
      addNode(nodes, {
        id: `output.${name}`,
        kind: 'output',
        name,
        file: rel,
        line: b.line,
        endLine: b.endLine,
      }, diagnostics);
    }

    for (const b of queue('provider')) {
      const [name] = b.labels;
      if (!name) continue;
      const body = pick(json, ['provider', name], b.occurrence);
      const alias = firstString(body, 'alias');
      addNode(nodes, {
        id: alias ? `provider.${name}.${alias}` : `provider.${name}`,
        kind: 'provider',
        name,
        alias: alias ?? null,
        file: rel,
        line: b.line,
        endLine: b.endLine,
      }, diagnostics);
    }

    // locals blocks: one node per declared local, positioned at its own line.
    const localBlocks = queue('locals');
    const localBodies = asArray(json.locals);
    for (let i = 0; i < localBlocks.length; i++) {
      const b = localBlocks[i];
      const body = localBodies[i];
      if (!body || typeof body !== 'object') continue;
      for (const key of Object.keys(body)) {
        addNode(nodes, {
          id: `local.${key}`,
          kind: 'local',
          name: key,
          file: rel,
          line: findAttributeLine(lines, b.line, b.endLine, key),
          endLine: b.endLine,
        }, diagnostics);
      }
    }
  }

  // ---- Pass 2: resolve references into edges or unresolved records. -------
  for (const pf of parsed) {
    const { rel, lines, blocks, json } = pf;

    const emit = (fromId, body, b) => {
      if (!body || typeof body !== 'object') return;
      const seen = new Set();
      for (const ref of walkRefs(body)) {
        if (ref.kind === 'scope') continue;
        if (ref.kind === 'ignored') {
          ignoredTraversals.set(ref.raw, (ignoredTraversals.get(ref.raw) ?? 0) + 1);
          continue;
        }
        const toId =
          ref.kind === 'var' ? `var.${ref.target}`
          : ref.kind === 'local' ? `local.${ref.target}`
          : ref.kind === 'module' ? `module.${ref.target}`
          : ref.target;

        const isDependsOn = ref.path[0] === 'depends_on';
        const line = findTextLine(lines, b.line, b.endLine, ref.raw.split('[')[0]);
        const key = `${fromId}|${toId}|${isDependsOn}|${ref.attr ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (!nodes.has(toId)) {
          unresolved.push({
            from: fromId,
            reference: ref.raw,
            expectedId: toId,
            reason:
              ref.kind === 'module'
                ? 'module-not-declared-in-unit'
                : ref.kind === 'var'
                  ? 'variable-not-declared-in-unit'
                  : ref.kind === 'local'
                    ? 'local-not-declared-in-unit'
                    : 'target-not-declared-in-unit',
            file: rel,
            line,
            attribute: ref.path.join('.') || null,
          });
          continue;
        }
        edges.push({
          from: fromId,
          to: toId,
          kind: isDependsOn ? 'depends_on' : 'reference',
          attribute: ref.path.join('.') || null,
          targetAttribute: ref.attr ?? null,
          file: rel,
          line,
        });
      }

      // provider = aws.secondary is an alias reference, not a resource traversal.
      const prov = firstString(body, 'provider');
      if (prov) {
        const inner = interpolations(prov)[0] ?? prov;
        const parts = inner.trim().split('.');
        const pid = parts.length > 1 ? `provider.${parts[0]}.${parts[1]}` : `provider.${parts[0]}`;
        const line = findAttributeLine(lines, b.line, b.endLine, 'provider');
        if (nodes.has(pid)) {
          edges.push({ from: fromId, to: pid, kind: 'provider', attribute: 'provider', file: rel, line });
        } else {
          unresolved.push({
            from: fromId,
            reference: inner.trim(),
            expectedId: pid,
            reason: 'provider-alias-not-declared-in-unit',
            file: rel,
            line,
            attribute: 'provider',
          });
        }
      }
    };

    for (const b of blocks) {
      if (b.kind === 'resource') {
        const [type, name] = b.labels;
        if (type && name) emit(`${type}.${name}`, pick(json, ['resource', type, name], b.occurrence), b);
      } else if (b.kind === 'data') {
        const [type, name] = b.labels;
        if (type && name) emit(`data.${type}.${name}`, pick(json, ['data', type, name], b.occurrence), b);
      } else if (b.kind === 'module') {
        const [name] = b.labels;
        if (name) emit(`module.${name}`, pick(json, ['module', name], b.occurrence), b);
      } else if (b.kind === 'output') {
        const [name] = b.labels;
        if (name) emit(`output.${name}`, pick(json, ['output', name], b.occurrence), b);
      } else if (b.kind === 'variable') {
        const [name] = b.labels;
        if (name) emit(`var.${name}`, pick(json, ['variable', name], b.occurrence), b);
      } else if (b.kind === 'provider') {
        const [name] = b.labels;
        if (name) {
          const body = pick(json, ['provider', name], b.occurrence);
          const alias = firstString(body, 'alias');
          emit(alias ? `provider.${name}.${alias}` : `provider.${name}`, body, b);
        }
      } else if (b.kind === 'locals') {
        const idx = blocks.filter((x) => x.kind === 'locals').indexOf(b);
        const body = asArray(json.locals)[idx];
        if (body && typeof body === 'object') {
          for (const [key, val] of Object.entries(body)) {
            emit(`local.${key}`, { [key]: val }, {
              ...b,
              line: findAttributeLine(lines, b.line, b.endLine, key),
            });
          }
        }
      }
    }
  }

  // Record every static-unknown as an explicit unresolved value, so the diagram
  // can render "cardinality unknown" instead of pretending it knows.
  for (const n of nodes.values()) {
    if (n.multiplicity && n.multiplicity.kind !== 'single' && n.multiplicity.count === null) {
      unresolved.push({
        from: n.id,
        reference: n.multiplicity.expression,
        expectedId: null,
        reason: `${n.multiplicity.kind}-not-statically-known`,
        file: n.file,
        line: n.multiplicity.line,
        attribute: n.multiplicity.kind,
      });
    }
    for (const d of n.dynamicBlocks ?? []) {
      unresolved.push({
        from: n.id,
        reference: d.forEach,
        expectedId: null,
        reason: 'dynamic-block-cardinality-unknown',
        file: n.file,
        line: d.line,
        attribute: `dynamic.${d.name}`,
      });
    }
    if (n.kind === 'module' && n.sourceKind && n.sourceKind !== 'local') {
      unresolved.push({
        from: n.id,
        reference: n.source,
        expectedId: null,
        reason: `module-source-external:${n.sourceKind}`,
        file: n.file,
        line: n.line,
        attribute: 'source',
      });
    }
    if (n.kind === 'data' && n.type === 'terraform_remote_state') {
      unresolved.push({
        from: n.id,
        reference: 'terraform_remote_state',
        expectedId: null,
        reason: 'remote-state-outside-repository',
        file: n.file,
        line: n.line,
        attribute: null,
      });
    }
  }

  return {
    dir: path.relative(repoRoot, dir) || '.',
    files: parsed.map((p) => p.rel),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.line - b.line,
    ),
    unresolved: unresolved.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line),
    diagnostics,
    ignoredTraversals: [...ignoredTraversals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([raw, n]) => ({ raw, n })),
  };
}

// ---- helpers ------------------------------------------------------------

function addNode(nodes, node, diagnostics) {
  if (nodes.has(node.id)) {
    const prev = nodes.get(node.id);
    diagnostics.push({
      file: node.file,
      line: node.line,
      severity: 'warning',
      message: `duplicate address ${node.id} (also ${prev.file}:${prev.line})`,
    });
    return;
  }
  nodes.set(node.id, node);
}

/**
 * Fetch a block body from the hcl2json tree.
 *
 * hcl2json groups blocks by label into an array, so two `provider "aws"` blocks
 * (a default and an aliased one) arrive as `provider.aws = [body0, body1]`.
 * Always reading `[0]` collapses them: the aliased provider loses its alias,
 * both get the id `provider.aws`, and every `provider = aws.replica` in the
 * module then dangles. `occurrence` selects the right one by declaration order.
 */
function pick(json, keys, occurrence = 0) {
  let cur = json;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  const arr = asArray(cur);
  return arr.length > occurrence ? arr[occurrence] : (arr[0] ?? null);
}

/**
 * Number each block by its declaration order among blocks with the same kind
 * and labels in the same file, so `pick` can select the matching hcl2json body.
 */
function annotateOccurrences(blocks) {
  const seen = new Map();
  for (const b of blocks) {
    const key = `${b.kind}\u0000${b.labels.join('\u0000')}`;
    b.occurrence = seen.get(key) ?? 0;
    seen.set(key, b.occurrence + 1);
  }
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function firstString(body, key) {
  if (!body || typeof body !== 'object') return undefined;
  const v = body[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function multiplicityOf(body, lines, b) {
  if (!body || typeof body !== 'object') return { kind: 'single', count: 1 };
  if (Object.prototype.hasOwnProperty.call(body, 'count')) {
    const raw = body.count;
    const str = typeof raw === 'string' ? raw : String(raw);
    const inner = interpolations(str)[0];
    const literal = inner === undefined && LITERAL_INT.test(str.trim()) ? Number(str.trim())
      : typeof raw === 'number' ? raw
      : null;
    return {
      kind: 'count',
      count: literal,
      expression: inner ?? str,
      line: findAttributeLine(lines, b.line, b.endLine, 'count'),
    };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'for_each')) {
    const raw = body.for_each;
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const inner = interpolations(str)[0];
    // A literal map/set written inline is the one for_each we can count.
    const count =
      inner === undefined && raw && typeof raw === 'object'
        ? Array.isArray(raw)
          ? raw.length
          : Object.keys(raw).length
        : null;
    return {
      kind: 'for_each',
      count,
      expression: inner ?? str,
      line: findAttributeLine(lines, b.line, b.endLine, 'for_each'),
    };
  }
  return { kind: 'single', count: 1 };
}

// `dynamic` blocks nest -- a dynamic "ingress" can contain a dynamic
// "cidr_blocks" -- and each nesting level multiplies an unknown cardinality, so
// every level has to be recorded, not just the outermost.
function dynamicBlocksOf(body, lines, b, out = []) {
  if (!body || typeof body !== 'object') return out;
  for (const [key, val] of Object.entries(body)) {
    if (key === 'dynamic') {
      for (const entry of asArray(val)) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [name, defs] of Object.entries(entry)) {
          for (const def of asArray(defs)) {
            const fe = def && typeof def === 'object' ? def.for_each : undefined;
            out.push({
              name,
              forEach:
                typeof fe === 'string' ? (interpolations(fe)[0] ?? fe) : JSON.stringify(fe ?? null),
              line: findTextLine(lines, b.line, b.endLine, `dynamic "${name}"`),
            });
            dynamicBlocksOf(def, lines, b, out);
          }
        }
      }
      continue;
    }
    for (const v of asArray(val)) dynamicBlocksOf(v, lines, b, out);
  }
  return out;
}

export function classifySource(source) {
  if (!source) return null;
  if (source.startsWith('./') || source.startsWith('../')) return 'local';
  if (/^(github\.com|git@|git::|bitbucket\.org)/.test(source)) return 'git';
  if (/^(https?|s3|gcs):\/\//.test(source)) return 'http';
  if (/^[0-9A-Za-z._-]+\/[0-9A-Za-z._-]+\/[0-9A-Za-z._-]+$/.test(source)) return 'registry';
  if (/^[0-9A-Za-z.-]+\/[^/]+\/[^/]+\/[^/]+$/.test(source)) return 'registry-private';
  return 'unknown';
}
