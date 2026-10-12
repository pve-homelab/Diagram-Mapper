import fs from 'node:fs';
import { indexFile } from './src/locate.mjs';
const f = process.argv[2];
const src = fs.readFileSync(f, 'utf8');
const { blocks } = indexFile(src);
const grepped = src.split('\n')
  .map((l, i) => ({ l, n: i + 1 }))
  .filter(({ l }) => /^(resource|data|module|variable|output|locals|provider|terraform)[ "{]/.test(l));
console.log('lexer found', blocks.length, 'top-level blocks; naive grep found', grepped.length);
const have = new Set(blocks.map((b) => b.line));
const missed = grepped.filter(({ n }) => !have.has(n));
console.log('MISSED:', missed.map(({ n, l }) => `${n}: ${l.slice(0, 70)}`));
