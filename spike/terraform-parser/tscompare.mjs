// Spike quality. Throwaway.
//
// Compares tree-sitter-hcl (terraform grammar, WASM) with the Go HCL parser
// (via hcl2json): parse time, files with error nodes, and whether both see the
// same resource/data/module inventory per file.
//
// Usage: node tscompare.mjs <repo-dir>/

import { Parser, Language } from 'web-tree-sitter';
import { parse as hcl } from '@cdktf/hcl2json';
import fs from 'node:fs'; import { execSync } from 'node:child_process';
const root = process.argv[2];
const files = execSync(`find ${root} -name '*.tf' -not -path '*/.git/*'`).toString().trim().split('\n');
await Parser.init();
const lang = await Language.load(new URL('./node_modules/@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm', import.meta.url).pathname);
const p = new Parser(); p.setLanguage(lang);
let ms = 0, errFiles = 0, mismatch = 0, blocksTs = 0; const bad = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const t0 = performance.now(); const tree = p.parse(src); ms += performance.now() - t0;
  if (tree.rootNode.hasError) { errFiles++; bad.push(f.slice(root.length)); }
  const body = tree.rootNode.namedChildren.find((n) => n.type === 'body') ?? tree.rootNode;
  const n = { resource: 0, data: 0, module: 0 };
  for (const b of body.namedChildren) if (b.type === 'block') { const id = b.namedChildren[0]?.text; if (id in n) n[id]++; }
  blocksTs += n.resource + n.data + n.module;
  const j = await hcl('x.tf', src); const h = { resource: 0, data: 0, module: 0 };
  for (const k of ['resource', 'data']) for (const t of Object.values(j[k] ?? {})) for (const v of Object.values(t)) h[k] += Array.isArray(v) ? v.length : 1;
  for (const v of Object.values(j.module ?? {})) h.module += Array.isArray(v) ? v.length : 1;
  if (h.resource !== n.resource || h.data !== n.data || h.module !== n.module) mismatch++;
  tree.delete();
}
console.log(JSON.stringify({ files: files.length, treeSitterParseMs: Math.round(ms), filesWithErrorNodes: errFiles, inventoryMismatchVsGoHcl: mismatch, addressableBlocks: blocksTs, errorSample: bad.slice(0, 5) }));
