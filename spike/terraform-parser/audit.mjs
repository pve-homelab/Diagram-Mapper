#!/usr/bin/env node
// Spike quality. Throwaway.
//
// Independent cross-check of the block indexer. For every .tf file, compare the
// lexer's top-level block inventory against two other sources that cannot share
// its bugs:
//
//   1. a naive line scan (any line starting with a block keyword), and
//   2. hcl2json's own output, which is produced by Go's real HCL parser.
//
// A block the lexer misses means a resource with no source position, or worse, a
// resource missing from the graph entirely. This is the check that caught the
// interpolation-inside-string desync.
//
// Usage: node audit.mjs <repo-dir> [<repo-dir> ...]

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@cdktf/hcl2json';
import { indexFile } from './src/locate.mjs';
import { findUnits } from './src/repo.mjs';

const NAIVE = /^(resource|data|module|variable|output|locals|provider|terraform|moved|import|check|removed)[ "{]/;

let totalFiles = 0;
let totalBlocks = 0;
const mismatches = [];

for (const repoArg of process.argv.slice(2)) {
  const root = path.resolve(repoArg);
  for (const dir of findUnits(root)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tf'))) {
      const abs = path.join(dir, f);
      const rel = path.relative(root, abs);
      const src = fs.readFileSync(abs, 'utf8');
      const { blocks } = indexFile(src);
      totalFiles++;
      totalBlocks += blocks.length;

      const naive = src.split('\n').filter((l) => NAIVE.test(l)).length;
      const unterminated = blocks.filter((b) => b.unterminated).length;

      // hcl2json's inventory of addressable blocks.
      let json;
      try {
        json = await parse(f, src);
      } catch {
        continue; // parse failures are reported by the main run, not here
      }
      const hcl = countAddressable(json);
      const mine = countMine(blocks);

      if (hcl.resource !== mine.resource || hcl.data !== mine.data || hcl.module !== mine.module) {
        mismatches.push({ repo: path.basename(root), file: rel, hcl, lexer: mine, naive, unterminated });
      } else if (naive > blocks.length) {
        mismatches.push({
          repo: path.basename(root),
          file: rel,
          note: 'naive-scan-sees-more (usually a keyword inside a heredoc)',
          naive,
          lexerBlocks: blocks.length,
        });
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      filesAudited: totalFiles,
      topLevelBlocksIndexed: totalBlocks,
      addressableInventoryMismatches: mismatches.filter((m) => !m.note).length,
      naiveScanNotes: mismatches.filter((m) => m.note).length,
      detail: mismatches.slice(0, 40),
    },
    null,
    2,
  ),
);
process.exit(mismatches.some((m) => !m.note) ? 1 : 0);

function countAddressable(json) {
  const n = { resource: 0, data: 0, module: 0 };
  for (const kind of ['resource', 'data']) {
    for (const byType of Object.values(json[kind] ?? {})) {
      for (const bodies of Object.values(byType ?? {})) {
        n[kind] += Array.isArray(bodies) ? bodies.length : 1;
      }
    }
  }
  for (const bodies of Object.values(json.module ?? {})) {
    n.module += Array.isArray(bodies) ? bodies.length : 1;
  }
  return n;
}

function countMine(blocks) {
  const n = { resource: 0, data: 0, module: 0 };
  for (const b of blocks) {
    if (b.kind === 'resource' && b.labels.length >= 2) n.resource++;
    else if (b.kind === 'data' && b.labels.length >= 2) n.data++;
    else if (b.kind === 'module' && b.labels.length >= 1) n.module++;
  }
  return n;
}
