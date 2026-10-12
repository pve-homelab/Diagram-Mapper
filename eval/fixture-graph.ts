/**
 * EVALUATION SCAFFOLDING — NOT PRODUCTION CODE.
 *
 * The real parser is `packages/graph`, owned by the Backend Engineer (AIS-4).
 * The explanation engine consumes a `Graph`; it does not build one. But the
 * evaluation harness has to exist before the parser does, or prompt work starts
 * without a measuring instrument, so this file builds a `Graph` from the
 * committed fixture `.tf` files with a brace-counting block scanner.
 *
 * It is deliberately dumb and deliberately quarantined:
 *
 *   - It lives under `eval/`, is never imported by `packages/explain`, and is
 *     excluded from the application build.
 *   - It is replaced by `packages/graph` the moment that package lands. The
 *     harness changes one import and nothing else, because both satisfy the
 *     same `Graph` type.
 *   - It cannot mask a grounding bug. The grounding gate re-reads the fixture
 *     files from disk to check citations, so if this scanner gets a line number
 *     wrong, the gate fails the claim rather than agreeing with it.
 *
 * If a question's expected answer depends on something this scanner cannot see,
 * that is a signal to ask the Backend Engineer for the field, not to make the
 * scanner cleverer.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Attribute, Graph, GraphEdge, GraphNode, NodeKind } from "../packages/explain/src/graph.ts";
import type { SnippetSource } from "../packages/explain/src/retrieval.ts";

export class FixtureSnippetSource implements SnippetSource {
  cache = new Map<string, string[]>();
  root: string;
  constructor(root: string) {
    this.root = root;
  }

  private lines(file: string): string[] | null {
    if (!this.cache.has(file)) {
      try {
        this.cache.set(file, readFileSync(join(this.root, file), "utf8").split("\n"));
      } catch {
        return null;
      }
    }
    return this.cache.get(file) ?? null;
  }

  read(file: string, startLine: number, endLine: number): string | null {
    const l = this.lines(file);
    if (!l) return null;
    if (startLine < 1 || startLine > l.length) return null;
    return l.slice(startLine - 1, Math.min(endLine, l.length)).join("\n");
  }
}

function tfFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) {
      out.push(...tfFiles(p).map((x) => join(entry, x)));
    } else if (entry.endsWith(".tf")) {
      out.push(entry);
    }
  }
  return out.sort();
}

const BLOCK_HEADER =
  /^(resource|data|variable|output|module|provider|locals|terraform)\b([^{]*)\{\s*$/;

function headerToNode(keyword: string, rest: string): { address: string; kind: NodeKind; type: string | null; name: string } | null {
  const labels = [...rest.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  switch (keyword) {
    case "resource":
      if (labels.length < 2) return null;
      return { address: `${labels[0]}.${labels[1]}`, kind: "resource", type: labels[0]!, name: labels[1]! };
    case "data":
      if (labels.length < 2) return null;
      return { address: `data.${labels[0]}.${labels[1]}`, kind: "data", type: labels[0]!, name: labels[1]! };
    case "variable":
      return labels[0] ? { address: `var.${labels[0]}`, kind: "variable", type: null, name: labels[0] } : null;
    case "output":
      return labels[0] ? { address: `output.${labels[0]}`, kind: "output", type: null, name: labels[0] } : null;
    case "module":
      return labels[0] ? { address: `module.${labels[0]}`, kind: "module", type: null, name: labels[0] } : null;
    case "provider":
      return labels[0] ? { address: `provider.${labels[0]}`, kind: "provider", type: null, name: labels[0] } : null;
    default:
      return null; // `locals` and `terraform` are handled separately.
  }
}

function parseLiteral(rhs: string): Attribute["literal"] {
  const s = rhs.trim().replace(/,$/, "");
  if (/^"[^"]*"$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  const arr = s.match(/^\[(.*)\]$/);
  if (arr) {
    const parts = arr[1]!.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    const vals = parts.map((p) => parseLiteral(p));
    if (vals.every((v) => v !== null && !Array.isArray(v))) return vals as Array<string | number | boolean>;
  }
  return null;
}

/** Longest known address referenced by an expression, e.g. `aws_vpc.main.id` -> `aws_vpc.main`. */
function referencedAddresses(expr: string, known: Set<string>): string[] {
  const hits = new Set<string>();
  for (const m of expr.matchAll(/\b((?:data\.)?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)\b/g)) {
    const token = m[1]!;
    const parts = token.split(".");
    for (let take = parts.length; take >= 2; take--) {
      const cand = parts.slice(0, take).join(".");
      if (known.has(cand)) {
        hits.add(cand);
        break;
      }
    }
  }
  return [...hits];
}

interface RawBlock {
  node: { address: string; kind: NodeKind; type: string | null; name: string };
  file: string;
  startLine: number;
  endLine: number;
  attributes: Attribute[];
}

function scanFile(file: string, text: string): { blocks: RawBlock[]; locals: RawBlock[] } {
  const lines = text.split("\n");
  const blocks: RawBlock[] = [];
  const locals: RawBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.match(BLOCK_HEADER);
    if (!header) continue;
    const keyword = header[1]!;
    const startLine = i + 1;

    // Find the matching close brace.
    let depth = 0;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      depth += countBraces(lines[j]!);
      if (depth === 0 && j > i) {
        end = j;
        break;
      }
      end = j;
    }
    const body = lines.slice(i + 1, end);
    const attributes = scanAttributes(body, file, startLine + 1);

    if (keyword === "locals") {
      for (const a of attributes) {
        if (a.path.includes(".")) continue;
        locals.push({
          node: { address: `local.${a.path}`, kind: "local", type: null, name: a.path },
          file,
          startLine: a.sourceRef.startLine,
          endLine: a.sourceRef.endLine,
          attributes: [{ ...a, path: "value" }],
        });
      }
      i = end;
      continue;
    }
    if (keyword === "terraform") {
      i = end;
      continue;
    }
    const node = headerToNode(keyword, header[2]!);
    if (node) blocks.push({ node, file, startLine, endLine: end + 1, attributes });
    i = end;
  }
  return { blocks, locals };
}

function countBraces(line: string): number {
  let n = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "#" || (c === "/" && line[i + 1] === "/")) break;
    if (c === "{") n++;
    if (c === "}") n--;
  }
  return n;
}

function scanAttributes(body: string[], file: string, firstLineNo: number): Attribute[] {
  const out: Attribute[] = [];
  const prefix: string[] = [];
  const repeatCount = new Map<string, number>();

  for (let i = 0; i < body.length; i++) {
    const lineNo = firstLineNo + i;
    const raw = body[i]!;
    const line = stripComment(raw);
    if (line.trim().length === 0) continue;

    if (/^\s*\}/.test(line)) {
      prefix.pop();
      continue;
    }

    // `name = {` — an object-valued attribute.
    const objAttr = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*\{\s*$/);
    if (objAttr) {
      prefix.push(objAttr[1]!);
      continue;
    }
    // `name {` — a repeated nested block.
    const nested = line.match(/^\s*([A-Za-z0-9_]+)\s*\{\s*$/);
    if (nested) {
      const key = [...prefix, nested[1]!].join(".");
      const idx = repeatCount.get(key) ?? 0;
      repeatCount.set(key, idx + 1);
      prefix.push(`${nested[1]}.${idx}`);
      continue;
    }
    // Heredoc.
    const heredoc = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*<<-?([A-Za-z0-9_]+)\s*$/);
    if (heredoc) {
      const term = heredoc[2]!;
      let j = i + 1;
      while (j < body.length && body[j]!.trim() !== term) j++;
      out.push({
        path: [...prefix, heredoc[1]!].join("."),
        literal: body.slice(i + 1, j).join("\n"),
        expression: null,
        sensitive: false,
        sourceRef: { file, startLine: lineNo, endLine: firstLineNo + j },
      });
      i = j;
      continue;
    }
    // Multi-line list.
    const listOpen = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*\[\s*$/);
    if (listOpen) {
      let j = i + 1;
      const parts: string[] = [];
      while (j < body.length && !/^\s*\]/.test(body[j]!)) {
        parts.push(stripComment(body[j]!).trim());
        j++;
      }
      const joined = `[${parts.join(" ")}]`;
      out.push({
        path: [...prefix, listOpen[1]!].join("."),
        literal: parseLiteral(joined),
        expression: parseLiteral(joined) === null ? joined : null,
        sensitive: false,
        sourceRef: { file, startLine: lineNo, endLine: firstLineNo + j },
      });
      i = j;
      continue;
    }

    const attr = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (attr) {
      const literal = parseLiteral(attr[2]!);
      out.push({
        path: [...prefix, attr[1]!].join("."),
        literal,
        expression: literal === null ? attr[2]!.trim() : null,
        sensitive: false,
        sourceRef: { file, startLine: lineNo, endLine: lineNo },
      });
    }
  }
  return out;
}

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "#") return line.slice(0, i);
    if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

export function buildFixtureGraph(root: string, repoId: string): Graph {
  const files = tfFiles(root);
  const texts = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

  const raw: RawBlock[] = [];
  for (const f of files) {
    const { blocks, locals } = scanFile(f, texts.get(f)!);
    raw.push(...blocks, ...locals);
  }

  const nodes: GraphNode[] = raw.map((b) => ({
    address: b.node.address,
    kind: b.node.kind,
    type: b.node.type,
    name: b.node.name,
    provider: b.node.type ? (b.node.type.split("_")[0] ?? null) : null,
    sourceRef: { file: b.file, startLine: b.startLine, endLine: b.endLine },
    attributes: b.attributes.map((a) => ({
      ...a,
      sensitive:
        a.path === "sensitive" ? false : b.attributes.some((x) => x.path === "sensitive" && x.literal === true),
    })),
  }));

  const known = new Set(nodes.map((n) => n.address));
  const edges: GraphEdge[] = [];
  for (const b of raw) {
    for (const a of b.attributes) {
      const expr = a.expression ?? (typeof a.literal === "string" ? a.literal : "");
      if (!expr) continue;
      for (const target of referencedAddresses(expr, known)) {
        if (target === b.node.address) continue;
        edges.push({
          from: b.node.address,
          to: target,
          kind: a.path === "depends_on" ? "depends_on" : "reference",
          via: a.path,
          sourceRef: a.sourceRef,
        });
      }
    }
  }

  const fileRecords = files.map((f) => ({
    path: f,
    lineCount: texts.get(f)!.split("\n").length,
    sha256: createHash("sha256").update(texts.get(f)!).digest("hex"),
  }));

  const commitSha = createHash("sha256")
    .update(fileRecords.map((f) => `${f.path}:${f.sha256}`).join("\n"))
    .digest("hex")
    .slice(0, 40);

  return {
    commitSha,
    repoId,
    nodes: nodes.sort((a, b) => a.address.localeCompare(b.address)),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.via.localeCompare(b.via)),
    files: fileRecords,
    diagnostics: [],
  };
}

export function fixtureRelative(root: string, abs: string): string {
  return relative(root, abs);
}
