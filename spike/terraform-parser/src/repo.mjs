// Spike quality. Throwaway.
//
// Repo-level driver. A repository is a set of Terraform "module units" (one per
// directory containing .tf files). Each unit is parsed independently, then local
// `module` calls are linked unit-to-unit and the referenced output is checked
// against the target unit's declared outputs.

import fs from 'node:fs';
import path from 'node:path';
import { parseUnit, isTerraformFile } from './build.mjs';

const SKIP_DIRS = new Set(['.git', '.terraform', 'node_modules', '.github', 'vendor']);

export function findUnits(root) {
  const units = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && isTerraformFile(e.name))) units.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return units.sort();
}

export async function parseRepo(root, { onUnit } = {}) {
  const units = findUnits(root);
  const results = [];
  for (const dir of units) {
    const t0 = process.hrtime.bigint();
    const unit = await parseUnit(dir, root);
    unit.parseMs = Number(process.hrtime.bigint() - t0) / 1e6;
    results.push(unit);
    onUnit?.(unit);
  }

  // Link local module sources. An edge is only created when the target
  // directory actually exists and parsed; otherwise it stays unresolved.
  const byDir = new Map(results.map((u) => [u.dir, u]));
  const crossModuleEdges = [];
  for (const unit of results) {
    for (const node of unit.nodes) {
      if (node.kind !== 'module' || node.sourceKind !== 'local') continue;
      // `source = "../../"` has a trailing slash, which path.normalize keeps
      // ("./"), so strip it before looking the unit up by its relative dir.
      const joined = path.normalize(path.join(unit.dir === '.' ? '' : unit.dir, node.source));
      const targetDir = joined.replace(/\/+$/, '') || '.';
      const target = byDir.get(targetDir);
      if (!target) {
        unit.unresolved.push({
          from: node.id,
          reference: node.source,
          expectedId: null,
          reason: 'local-module-source-path-not-found',
          file: node.file,
          line: node.line,
          attribute: 'source',
        });
        continue;
      }
      node.resolvedUnit = target.dir;
      crossModuleEdges.push({
        fromUnit: unit.dir,
        from: node.id,
        toUnit: target.dir,
        kind: 'module_source',
        file: node.file,
        line: node.line,
      });

      // Check every module.<name>.<output> reference against the target's outputs.
      const outputs = new Set(
        target.nodes.filter((n) => n.kind === 'output').map((n) => n.name),
      );
      // Iterate a copy: a reference to an output the child does not declare is
      // removed from the unit's edges -- Terraform would reject it, so drawing
      // it would be an invented edge.
      for (const e of [...unit.edges]) {
        if (e.to !== node.id || !e.targetAttribute) continue;
        if (outputs.has(e.targetAttribute)) {
          crossModuleEdges.push({
            fromUnit: unit.dir,
            from: e.from,
            toUnit: target.dir,
            to: `output.${e.targetAttribute}`,
            kind: 'module_output',
            file: e.file,
            line: e.line,
          });
        } else {
          unit.edges.splice(unit.edges.indexOf(e), 1);
          unit.unresolved.push({
            from: e.from,
            reference: `${node.id}.${e.targetAttribute}`,
            expectedId: `${target.dir}:output.${e.targetAttribute}`,
            reason: 'module-output-not-declared-in-target-unit',
            file: e.file,
            line: e.line,
            attribute: e.attribute,
          });
        }
      }
    }
  }

  return { root, units: results, crossModuleEdges };
}

export function summarise(repo) {
  const all = repo.units;
  const count = (pred) => all.reduce((n, u) => n + u.nodes.filter(pred).length, 0);
  const reasons = {};
  for (const u of all) {
    for (const x of u.unresolved) {
      const key = x.reason.split(':')[0];
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }
  return {
    units: all.length,
    files: all.reduce((n, u) => n + u.files.length, 0),
    resources: count((n) => n.kind === 'resource'),
    dataSources: count((n) => n.kind === 'data'),
    moduleCalls: count((n) => n.kind === 'module'),
    variables: count((n) => n.kind === 'variable'),
    locals: count((n) => n.kind === 'local'),
    outputs: count((n) => n.kind === 'output'),
    providers: count((n) => n.kind === 'provider'),
    edges: all.reduce((n, u) => n + u.edges.length, 0),
    resourceToResourceEdges: all.reduce(
      (n, u) =>
        n +
        u.edges.filter((e) => {
          const from = u.nodes.find((x) => x.id === e.from);
          const to = u.nodes.find((x) => x.id === e.to);
          return (
            from && to &&
            (from.kind === 'resource' || from.kind === 'data') &&
            (to.kind === 'resource' || to.kind === 'data')
          );
        }).length,
      0,
    ),
    crossModuleEdges: repo.crossModuleEdges.length,
    unresolved: all.reduce((n, u) => n + u.unresolved.length, 0),
    unresolvedByReason: reasons,
    parseErrors: all.reduce(
      (n, u) => n + u.diagnostics.filter((d) => d.severity === 'error').length,
      0,
    ),
    warnings: all.reduce(
      (n, u) => n + u.diagnostics.filter((d) => d.severity === 'warning').length,
      0,
    ),
    totalParseMs: Math.round(all.reduce((n, u) => n + u.parseMs, 0)),
  };
}
