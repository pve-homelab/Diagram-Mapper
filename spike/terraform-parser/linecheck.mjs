#!/usr/bin/env node
// Spike quality. Throwaway.
//
// Citation check over a whole repository: for every edge, the line it cites
// must contain the reference text. The explanation engine quotes these lines,
// so a wrong line is a wrong citation even when the edge itself is right.
//
// Usage: node linecheck.mjs <repo-dir>

import fs from 'node:fs';
import path from 'node:path';
import { parseRepo } from './src/repo.mjs';

const root = path.resolve(process.argv[2]);
const repo = await parseRepo(root);
const cache = new Map();
const lineOf = (file, n) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n'));
  return cache.get(file)[n - 1] ?? '';
};

let total = 0;
let ok = 0;
const bad = [];
for (const u of repo.units) {
  for (const e of u.edges) {
    total++;
    const needle =
      e.kind === 'provider' ? 'provider'
      : e.to.startsWith('output.') ? e.to
      : e.to.replace(/^provider\./, '');
    const text = lineOf(e.file, e.line);
    if (text.includes(needle)) ok++;
    else bad.push(`${e.file}:${e.line} ${e.from} -> ${e.to} | ${text.trim().slice(0, 90)}`);
  }
}
console.log(JSON.stringify({ repo: path.basename(root), edges: total, citedLineContainsReference: ok, misses: bad.length, sample: bad.slice(0, 8) }, null, 2));
