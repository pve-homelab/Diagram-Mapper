/**
 * Retrieval: choosing what the model is allowed to see.
 *
 * Most bad answers come from the wrong context, not the wrong model, so this
 * is the part of the engine that gets the most attention. Two rules govern it:
 *
 *  1. **Minimum necessary disclosure.** Every extra line is a privacy cost and
 *     a token cost. We send the focus node, a bounded neighbourhood, and at
 *     most 6 snippets of at most 40 lines.
 *  2. **Nothing enters the context that cannot be cited.** Each snippet is
 *     line-numbered and every node and edge carries a SourceRef, so a correct
 *     citation is always available and a wrong one is always detectable.
 */

import type { SourceRef } from "./contract.ts";
import type { Graph, GraphEdge, GraphNode } from "./graph.ts";
import { incoming, nodeByAddress, outgoing } from "./graph.ts";
import { isSecret, redactSpan, REDACTED } from "./redact.ts";
import type { Intent } from "./intent.ts";

export const LIMITS = {
  /** Peers described structurally in the context. */
  maxPeers: 25,
  /** Nodes whose source is actually re-fetched and transmitted. */
  maxSnippetNodes: 6,
  /** Lines per snippet. A Terraform block longer than this is head-truncated. */
  maxSnippetLines: 40,
  /** Hard input-token ceiling; peers are dropped by priority until it fits. */
  maxInputTokens: 12_000,
  /** Expression strings are truncated before egress. */
  maxExpressionChars: 512,
} as const;

const EDGE_PRIORITY: Record<GraphEdge["kind"], number> = {
  depends_on: 0,
  reference: 1,
  module_input: 2,
  provider: 3,
};

/**
 * Where source text comes from at answer time. We do not retain raw customer
 * IaC, so production re-fetches from GitHub with a short-lived installation
 * token; the evaluation harness reads the committed fixture directory. Both
 * satisfy this one interface, which is why the harness exercises the real path.
 */
export interface SnippetSource {
  /** 1-indexed inclusive. Returns null when the range is unavailable. */
  read(file: string, startLine: number, endLine: number): string | null;
}

export interface CompactAttribute {
  path: string;
  value: string | number | boolean | Array<string | number | boolean> | null;
  expression: string | null;
  redacted: boolean;
  sourceRef: SourceRef;
}

export interface CompactNode {
  address: string;
  kind: string;
  type: string | null;
  name: string;
  sourceRef: SourceRef;
  attributes: CompactAttribute[];
}

export interface NumberedSnippet {
  file: string;
  startLine: number;
  endLine: number;
  /** [lineNumber, text] pairs. Line numbers are explicit so citing is exact. */
  lines: [number, string][];
  /** Scrubber findings on this span (see `scrubSnippet`). */
  notes: string[];
}

export interface AssembledContext {
  /** Non-null for every intent except a pure existence refusal. */
  focus: CompactNode | null;
  peers: CompactNode[];
  edges: { from: string; to: string; kind: string; via: string; sourceRef: SourceRef }[];
  snippets: NumberedSnippet[];
  /** Repo-relative paths of files that exist. Bounds what may be cited. */
  fileManifest: string[];
  /**
   * Addresses present in this context. Deliberately NOT the whole repository:
   * the model must not conclude a resource is absent from a partial view.
   */
  visibleAddresses: string[];
  /** Parse problems touching these nodes. A partial parse is never presented as complete. */
  diagnostics: { file: string; line: number; message: string }[];
  /** Characters of customer source in `snippets` after scrubbing. */
  sourceCharsSent: number;
  strategy: string;
  scrubberFlags: { code: string; where: SourceRef }[];
}

/* ------------------------------------------------------------- scrubbing */

/**
 * Comments are stripped from snippets before egress (TECH-SPEC §8.4).
 *
 * Comments are not configuration — nothing in a comment can be a verified fact
 * about infrastructure — and they are where almost every prompt-injection
 * payload lives. Removing them costs nothing we are allowed to assert and
 * removes the attack surface. Line numbers are preserved so citations stay
 * valid; the comment body is replaced, the line is not deleted.
 */
const INJECTION_SIGNALS: { code: string; re: RegExp }[] = [
  // Comment and quote markers are allowed before the forged role name, because
  // that is exactly how a payload appears inside a .tf file.
  { code: "role_impersonation", re: /^[\s#/*"-]*(system|assistant|human|user)\s*:/im },
  { code: "citation_steering", re: /\bcite (?:it|this|that|them) as\b/i },
  { code: "instruction_override", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,20}\b(instruction|rule|prompt|context)/i },
  { code: "forged_delimiter", re: /<\/?\s*(untrusted_source_snippet|repo_data|context|system)[^>]*>|\[\[\s*end of [^\]]*\]\]/i },
  { code: "prompt_exfiltration", re: /\b(reveal|repeat|print|output)\b[^.\n]{0,30}\bsystem prompt\b/i },
  { code: "confidence_steering", re: /\b(state|report|treat|mark)\b[^.\n]{0,40}\b(as (?:a )?verified|verified fact)\b/i },
  {
    code: "ai_addressed_instruction",
    re: /\b(instruction to the ai|ai assistant[:,]|note to (?:the )?(?:ai|assistant)|\bAI\s*:\s)/i,
  },
  { code: "maintenance_mode", re: /\b(maintenance mode|developer mode|unrestricted assistant|without citations)\b/i },
];

export function scrubSnippet(
  text: string,
  file: string,
  startLine: number,
): { lines: [number, string][]; notes: string[]; flags: { code: string; where: SourceRef }[] } {
  const notes: string[] = [];
  const flags: { code: string; where: SourceRef }[] = [];
  const out: [number, string][] = [];
  let inBlockComment = false;

  text.split("\n").forEach((raw, i) => {
    const lineNo = startLine + i;
    let line = raw;
    let commentBody = "";

    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        commentBody = line;
        line = "";
      } else {
        commentBody = line.slice(0, end + 2);
        line = " ".repeat(end + 2) + line.slice(end + 2);
        inBlockComment = false;
      }
    }
    const open = line.indexOf("/*");
    if (!inBlockComment && open !== -1 && line.indexOf("*/", open) === -1) {
      commentBody += line.slice(open);
      line = line.slice(0, open);
      inBlockComment = true;
    }
    const hash = findCommentStart(line);
    if (hash !== -1) {
      commentBody += line.slice(hash);
      line = line.slice(0, hash);
    }

    if (commentBody.trim().length > 0) {
      for (const sig of INJECTION_SIGNALS) {
        if (sig.re.test(commentBody)) {
          flags.push({ code: sig.code, where: { file, startLine: lineNo, endLine: lineNo } });
        }
      }
      notes.push(`line ${lineNo}: comment removed before egress`);
      line = line.trimEnd() + (line.trim().length > 0 ? " " : "") + "«comment removed»";
    }

    const red = redactSpan(line);
    if (red.hits.length > 0) {
      notes.push(`line ${lineNo}: redacted (${red.hits.join(", ")})`);
    }
    out.push([lineNo, red.text]);
  });

  // String values are data too; an injection payload can sit in a tag or a
  // variable default. Those we keep (they are configuration) but we flag them,
  // and the grounding gate treats a flagged request as suspect.
  for (const [lineNo, line] of out) {
    for (const sig of INJECTION_SIGNALS) {
      if (sig.re.test(line)) {
        flags.push({ code: sig.code, where: { file, startLine: lineNo, endLine: lineNo } });
      }
    }
  }
  return { lines: out, notes: [...new Set(notes)], flags: dedupeFlags(flags) };
}

function dedupeFlags(f: { code: string; where: SourceRef }[]) {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.code}@${x.where.file}:${x.where.startLine}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `#` or `//` outside a double-quoted string. */
function findCommentStart(line: string): number {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (inStr) continue;
    if (c === "#") return i;
    if (c === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

/* ------------------------------------------------------------- selection */

function compact(n: GraphNode): CompactNode {
  return {
    address: n.address,
    kind: n.kind,
    type: n.type,
    name: n.name,
    sourceRef: n.sourceRef,
    attributes: n.attributes.map((a) => {
      const secret = a.sensitive || isSecret(a.path, a.literal ?? a.expression);
      return {
        path: a.path,
        value: secret ? REDACTED : a.literal,
        expression: secret
          ? null
          : a.expression
            ? a.expression.slice(0, LIMITS.maxExpressionChars)
            : null,
        redacted: secret,
        sourceRef: a.sourceRef,
      };
    }),
  };
}

/** 1-hop neighbourhood, ordered by edge-kind priority then address. */
export function neighbourhood(g: Graph, address: string): { peers: GraphNode[]; edges: GraphEdge[] } {
  const edges = [...outgoing(g, address), ...incoming(g, address)].sort(
    (a, b) => EDGE_PRIORITY[a.kind] - EDGE_PRIORITY[b.kind] || a.to.localeCompare(b.to),
  );
  const seen = new Set<string>([address]);
  const peers: GraphNode[] = [];
  for (const e of edges) {
    for (const addr of [e.from, e.to]) {
      if (seen.has(addr)) continue;
      seen.add(addr);
      const n = nodeByAddress(g, addr);
      if (n) peers.push(n);
    }
  }
  return { peers: peers.slice(0, LIMITS.maxPeers), edges };
}

/** Rough token estimate used only to decide what to drop; the provider's own
 * `count_tokens` is the measurement of record (see `cost.ts`). */
export function estimateTokens(json: string): number {
  return Math.ceil(json.length / 3.5);
}

export function assembleContext(
  g: Graph,
  src: SnippetSource,
  intent: Intent,
  focusAddress: string | null,
): AssembledContext {
  const manifest = g.files.map((f) => f.path).sort();
  const focusNode = focusAddress ? nodeByAddress(g, focusAddress) : undefined;

  if (!focusNode) {
    return {
      focus: null,
      peers: [],
      edges: [],
      snippets: [],
      fileManifest: manifest,
      visibleAddresses: [],
      diagnostics: [],
      sourceCharsSent: 0,
      strategy: "no-focus",
      scrubberFlags: [],
    };
  }

  const { peers, edges } = neighbourhood(g, focusNode.address);

  // Which nodes' source we actually transmit: the focus always, then peers in
  // priority order. Purpose questions get more peers (context is the evidence
  // for an inference); attribute questions need the focus block and little else.
  const snippetBudget = intent === "purpose" ? LIMITS.maxSnippetNodes : 3;
  const snippetNodes = [focusNode, ...peers].slice(0, Math.min(snippetBudget, LIMITS.maxSnippetNodes));

  const snippets: NumberedSnippet[] = [];
  const scrubberFlags: { code: string; where: SourceRef }[] = [];
  let chars = 0;
  for (const n of snippetNodes) {
    const start = n.sourceRef.startLine;
    const end = Math.min(n.sourceRef.endLine, start + LIMITS.maxSnippetLines - 1);
    const text = src.read(n.sourceRef.file, start, end);
    if (text === null) continue;
    const { lines, notes, flags } = scrubSnippet(text, n.sourceRef.file, start);
    scrubberFlags.push(...flags);
    snippets.push({ file: n.sourceRef.file, startLine: start, endLine: end, lines, notes });
    chars += lines.reduce((a, [, t]) => a + t.length + 1, 0);
  }

  // Each fact goes out once. An attribute inside a transmitted snippet is
  // already there as scrubbed, numbered, citable text, so it is not repeated
  // as JSON; one outside it (a head-truncated block) still is. A peer whose
  // source is not transmitted at all goes out as a structural stub: its values
  // could not be cited (the gate rejects citations outside the sent spans), so
  // sending them would be disclosure with no grounding value.
  const covered = (r: SourceRef) =>
    snippets.some((sn) => sn.file === r.file && r.startLine >= sn.startLine && r.endLine <= sn.endLine);
  const once = (n: GraphNode): CompactNode => {
    const full = compact(n);
    return { ...full, attributes: full.attributes.filter((a) => !covered(a.sourceRef)) };
  };

  const diagnostics = g.diagnostics
    .filter((d) => snippetNodes.some((n) => n.sourceRef.file === d.file))
    .map((d) => ({ file: d.file, line: d.line, message: d.message }));

  const ctx: AssembledContext = {
    focus: once(focusNode),
    peers: peers.map((p) => (snippetNodes.includes(p) ? once(p) : { ...compact(p), attributes: [] })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      via: e.via,
      sourceRef: e.sourceRef,
    })),
    snippets,
    fileManifest: manifest,
    visibleAddresses: [focusNode.address, ...peers.map((p) => p.address)],
    diagnostics,
    sourceCharsSent: chars,
    strategy: `focus+1hop(peers=${peers.length},snippets=${snippets.length})`,
    scrubberFlags: dedupeFlags(scrubberFlags),
  };

  // The cap is enforced by measurement, not by hope: drop the lowest-priority
  // peers until the serialised context fits.
  while (estimateTokens(JSON.stringify(ctx)) > LIMITS.maxInputTokens && ctx.peers.length > 0) {
    const dropped = ctx.peers.pop()!;
    ctx.edges = ctx.edges.filter((e) => e.from !== dropped.address && e.to !== dropped.address);
    ctx.visibleAddresses = ctx.visibleAddresses.filter((a) => a !== dropped.address);
    ctx.strategy += "+trimmed";
  }
  return ctx;
}
