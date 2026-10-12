// Spike quality. Throwaway.
//
// Golden-fixture test: the extractor's graph for fixtures/hard-cases must equal
// the hand-written expectation exactly -- no missing edges, no extra edges.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepo } from '../src/repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../fixtures/hard-cases');
const expected = JSON.parse(
  fs.readFileSync(path.join(here, '../fixtures/hard-cases.expected.json'), 'utf8'),
);

const repo = await parseRepo(root);
const unit = (dir) => repo.units.find((u) => u.dir === dir);
const sorted = (xs) => [...xs].sort();

for (const dir of Object.keys(expected.edges)) {
  test(`edges in ${dir} match the hand-written graph exactly`, () => {
    const got = unit(dir).edges.map((e) => `${e.from} -> ${e.to} ${e.kind} ${e.file}:${e.line}`);
    assert.deepEqual(sorted(got), sorted(expected.edges[dir]));
  });

  test(`unresolved in ${dir} match the hand-written list exactly`, () => {
    const got = unit(dir).unresolved.map((x) => `${x.from} ${x.reason} ${x.file}:${x.line}`);
    assert.deepEqual(sorted(got), sorted(expected.unresolved[dir]));
  });
}

test('cross-module edges', () => {
  const got = repo.crossModuleEdges.map((e) =>
    e.kind === 'module_source'
      ? `${e.from} -> ${e.toUnit} ${e.kind} ${e.file}:${e.line}`
      : `${e.from} -> ${e.toUnit}:${e.to} ${e.kind} ${e.file}:${e.line}`,
  );
  assert.deepEqual(sorted(got), sorted(expected.crossModuleEdges));
});

test('decoys, comments, heredocs and loop variables never become nodes or edges', () => {
  const ids = repo.units.flatMap((u) => [
    ...u.nodes.map((n) => n.id),
    ...u.edges.flatMap((e) => [e.from, e.to]),
  ]);
  for (const bad of expected.mustNotAppear) {
    assert.ok(!ids.some((id) => id.includes(bad)), `${bad} leaked into the graph`);
  }
});

test('re-parsing the same input is byte-identical (idempotent ingestion)', async () => {
  const again = await parseRepo(root);
  const strip = (r) => JSON.stringify(r, (k, v) => (k === 'parseMs' ? undefined : v));
  assert.equal(strip(again), strip(repo));
});

test('a parse failure names the file and line', async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'hcl-bad-'));
  fs.writeFileSync(path.join(tmp, 'broken.tf'), 'resource "a_b" "c" {\n  x = \n}\n');
  const bad = await parseRepo(tmp);
  const d = bad.units[0].diagnostics.find((x) => x.severity === 'error');
  assert.ok(d, 'expected an error diagnostic');
  assert.equal(d.file, 'broken.tf');
  assert.equal(typeof d.line, 'number');
});
