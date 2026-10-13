/**
 * Answers produced from the parsed graph with no provider call.
 *
 * The graph is better than the text. If the parser knows that
 * `aws_instance.bastion` references `aws_security_group.bastion` via
 * `vpc_security_group_ids` at `main.tf:91`, then asking a language model to
 * re-derive that is strictly worse: it can be wrong, it costs money, and it
 * leaks configuration. These paths cost £0.00 and cannot hallucinate, because
 * every claim they emit is constructed from a graph edge or node that exists.
 *
 * `answerPath: "deterministic"` in the response means exactly this code ran.
 */

import type { Claim, Explanation, NarrativeBlock, Unanswered } from "./contract.ts";
import { SCHEMA_VERSION } from "./contract.ts";
import type { Graph, GraphEdge } from "./graph.ts";
import { blastRadius, incoming, nodeByAddress, outgoing } from "./graph.ts";
import type { Classification } from "./intent.ts";
import { snippetDigest } from "./validate.ts";
import type { SnippetSource } from "./retrieval.ts";

export interface DeterministicResult {
  claims: Claim[];
  narrative: NarrativeBlock[];
  unanswered: Unanswered[];
}

function cite(
  g: Graph,
  src: SnippetSource,
  ref: { file: string; startLine: number; endLine: number },
) {
  return {
    ...ref,
    commitSha: g.commitSha,
    snippetSha256: snippetDigest(src, ref),
  };
}

function edgeClaim(
  g: Graph,
  src: SnippetSource,
  id: string,
  e: GraphEdge,
  direction: "out" | "in",
): Claim {
  const subject = direction === "out" ? e.from : e.to;
  const other = direction === "out" ? e.to : e.from;
  const text =
    direction === "out"
      ? `${subject} references ${other} through its \`${e.via}\` attribute.`
      : `${other} references ${subject} through its \`${e.via}\` attribute.`;
  return {
    id,
    text,
    confidence: "verified",
    kind: "relationship",
    subjects: [e.from, e.to],
    edge: { from: e.from, to: e.to, via: e.via },
    citations: [cite(g, src, e.sourceRef)],
    source: "graph",
  };
}

/**
 * Returns null when the intent is not one this module owns, so the caller
 * falls through to the narrated path.
 */
export function answerFromGraph(
  g: Graph,
  src: SnippetSource,
  c: Classification,
  question: string,
): DeterministicResult | null {
  const claims: Claim[] = [];
  const narrative: NarrativeBlock[] = [];
  const unanswered: Unanswered[] = [];
  let n = 0;
  const nextId = () => `c${++n}`;
  const push = (claim: Claim) => {
    claims.push(claim);
    narrative.push({ type: "claim", claimId: claim.id });
  };

  // An honest refusal is a deterministic answer. The symbol table is complete
  // after a successful parse, so absence IS knowable — but only from the graph,
  // never from a snippet, and never from a model.
  if (c.intent === "existence") {
    if (c.unknownSymbols.length > 0) {
      for (const s of c.unknownSymbols) {
        unanswered.push({
          reason: "not-in-repository",
          detail: `No resource with the address \`${s}\` exists in the analysed commit ${g.commitSha.slice(0, 7)}. ${g.nodes.length} resources were parsed from ${g.files.length} file(s).`,
        });
      }
      return { claims, narrative, unanswered };
    }
    if (c.focus) {
      const node = nodeByAddress(g, c.focus)!;
      push({
        id: nextId(),
        text: `${node.address} is declared in this repository as a \`${node.type ?? node.kind}\`.`,
        confidence: "verified",
        kind: "existence",
        subjects: [node.address],
        citations: [cite(g, src, node.sourceRef)],
        source: "graph",
      });
      return { claims, narrative, unanswered };
    }
    // Nothing address-shaped was named and nothing resolved: a type-level
    // existence question ("is there a CloudFront distribution?").
    const typeGuess = question.toLowerCase().match(/[a-z]+_[a-z_]+|cloudfront|dynamodb|step function|bucket named ['"`]?([a-z0-9-]+)/);
    unanswered.push({
      reason: "not-in-repository",
      detail: typeGuess
        ? `Nothing matching that description was parsed from this repository. The analysed commit ${g.commitSha.slice(0, 7)} contains ${g.nodes.length} declarations across ${g.files.length} file(s); none of them match.`
        : `I could not identify which resource you mean. Select a node in the diagram, or name it by its Terraform address.`,
      });
    return { claims, narrative, unanswered };
  }

  // Counting is repository-wide and needs no focus node. This branch sits
  // *above* the focus guard deliberately: "how many security groups are there?"
  // names no address, so a focus-first ordering would drop it to the narrated
  // path, where the system prompt forbids the model from counting at all. The
  // user would get a refusal for a question the graph can answer exactly.
  if (c.intent === "count") {
    const typeMatch = question.toLowerCase().match(/\b([a-z]+_[a-z0-9_]+)\b/);
    const resourceType = typeMatch?.[1];
    const matching = resourceType
      ? g.nodes.filter((x) => x.type === resourceType)
      : g.nodes.filter((x) => x.kind === "resource");
    push({
      id: nextId(),
      text: resourceType
        ? `This repository declares ${matching.length} \`${resourceType}\` resource${matching.length === 1 ? "" : "s"}.`
        : `This repository declares ${matching.length} resource${matching.length === 1 ? "" : "s"}.`,
      confidence: "verified",
      kind: "count",
      subjects: matching.map((x) => x.address).slice(0, 50),
      // `resourceType` travels with the count so the grounding gate can
      // recompute the same filter and reject a count that does not match.
      values: resourceType ? { count: matching.length, resourceType } : { count: matching.length },
      citations: matching.slice(0, 10).map((x) => cite(g, src, x.sourceRef)),
      source: "graph",
    });
    return { claims, narrative, unanswered };
  }

  if (!c.focus) return null;
  const node = nodeByAddress(g, c.focus);
  if (!node) return null;

  if (c.intent === "dependencies") {
    const out = outgoing(g, node.address);
    if (out.length === 0) {
      push({
        id: nextId(),
        text: `${node.address} references no other resource in this repository.`,
        confidence: "verified",
        kind: "count",
        subjects: [node.address],
        values: { outgoingEdges: 0 },
        citations: [cite(g, src, node.sourceRef)],
        source: "graph",
      });
    } else {
      push({
        id: nextId(),
        text: `${node.address} references ${out.length} other declaration${out.length === 1 ? "" : "s"} in this repository.`,
        confidence: "verified",
        kind: "count",
        subjects: [node.address],
        values: { outgoingEdges: out.length },
        citations: [cite(g, src, node.sourceRef)],
        source: "graph",
      });
      for (const e of out) push(edgeClaim(g, src, nextId(), e, "out"));
    }
    return { claims, narrative, unanswered };
  }

  if (c.intent === "dependents") {
    const inc = incoming(g, node.address);
    push({
      id: nextId(),
      text:
        inc.length === 0
          ? `Nothing in this repository references ${node.address}.`
          : `${inc.length} declaration${inc.length === 1 ? "" : "s"} in this repository reference ${node.address}.`,
      confidence: "verified",
      kind: "count",
      subjects: [node.address],
      values: { incomingEdges: inc.length },
      citations: [cite(g, src, node.sourceRef)],
      source: "graph",
    });
    for (const e of inc) push(edgeClaim(g, src, nextId(), e, "in"));
    if (inc.length === 0) {
      unanswered.push({
        reason: "needs-runtime-state",
        detail:
          "Nothing in the Terraform configuration references it. Something outside this repository (another state, a console change, an application) still could; I only read this repository.",
      });
    }
    return { claims, narrative, unanswered };
  }

  if (c.intent === "blast-radius") {
    const affected = blastRadius(g, node.address);
    push({
      id: nextId(),
      text: `Changing or destroying ${node.address} transitively affects ${affected.length} other declaration${affected.length === 1 ? "" : "s"} in this repository.`,
      confidence: "verified",
      kind: "count",
      subjects: [node.address],
      values: { affectedCount: affected.length },
      citations: [cite(g, src, node.sourceRef)],
      source: "graph",
    });
    for (const addr of affected) {
      const peer = nodeByAddress(g, addr);
      if (!peer) continue;
      push({
        id: nextId(),
        text: `${addr} is in the blast radius of ${node.address}.`,
        confidence: "verified",
        kind: "relationship",
        subjects: [addr, node.address],
        edge: { from: addr, to: node.address, via: "transitive-reference" },
        citations: [cite(g, src, peer.sourceRef)],
        source: "graph",
      });
    }
    return { claims, narrative, unanswered };
  }

  return null;
}

export function deterministicExplanation(
  g: Graph,
  questionId: string,
  c: Classification,
  r: DeterministicResult,
  spans: { file: string; startLine: number; endLine: number }[],
): Explanation {
  return {
    schemaVersion: SCHEMA_VERSION,
    questionId,
    nodeAddress: c.focus,
    answerPath: r.claims.length === 0 ? "refused" : "deterministic",
    narrative: r.narrative,
    claims: r.claims,
    unanswered: r.unanswered,
    retrieval: {
      strategy: `deterministic:${c.intent}`,
      nodeAddresses: c.focus ? [c.focus] : [],
      edgeCount: r.claims.filter((x) => x.kind === "relationship").length,
      spans,
      sourceCharsSent: 0,
    },
    flags: [],
    usage: {
      model: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costGbp: 0,
      measured: true,
    },
  };
}
