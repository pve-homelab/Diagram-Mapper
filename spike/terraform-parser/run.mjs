#!/usr/bin/env node
// Spike quality. Throwaway.
//
// Usage: node run.mjs <repo-dir> [--json out.json]
//
// Prints a summary table for one repository and optionally writes the full
// graph as JSON for hand verification.

import fs from 'node:fs';
import path from 'node:path';
import { parseRepo, summarise } from './src/repo.mjs';

const root = process.argv[2];
if (!root) {
  console.error('usage: node run.mjs <repo-dir> [--json out.json]');
  process.exit(2);
}
const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx > 0 ? process.argv[jsonIdx + 1] : null;

const wall0 = Date.now();
let crashed = null;
let repo;
try {
  repo = await parseRepo(path.resolve(root));
} catch (e) {
  crashed = e;
}
const wallMs = Date.now() - wall0;

if (crashed) {
  console.error(`CRASH ${root}: ${crashed.stack}`);
  process.exit(1);
}

const s = summarise(repo);
console.log(JSON.stringify({ repo: path.basename(path.resolve(root)), wallMs, ...s }, null, 2));

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(repo, null, 2));
  console.error(`wrote ${jsonOut} (${(fs.statSync(jsonOut).size / 1e6).toFixed(1)} MB)`);
}
