/**
 * `explain()` — the one entry point.
 *
 * Order of operations, and why:
 *
 *   classify -> deterministic?           a model call we do not make cannot lie
 *            -> assemble context         minimum necessary disclosure
 *            -> build prompt             repository content fenced as data
 *            -> provider call            behind the seam
 *            -> grounding gate           reject before the user ever sees it
 *            -> cost accounting          measured, not estimated
 *
 * The gate runs on every path including the deterministic one. A bug in
 * `deterministic.ts` that emitted a non-existent edge would fail the gate the
 * same way a hallucination would, which is the point: there is one definition
 * of "grounded" and nothing is exempt from it.
 */

import type { Explanation, Flag } from "./contract.ts";
import { SCHEMA_VERSION } from "./contract.ts";
import type { Graph } from "./graph.ts";
import { classify } from "./intent.ts";
import { answerFromGraph } from "./deterministic.ts";
import { assembleContext, estimateTokens, LIMITS } from "./retrieval.ts";
import type { SnippetSource } from "./retrieval.ts";
import { buildPrompt } from "./prompt.ts";
import type { ExplanationProvider } from "./provider.ts";
import { costUsd, gbp, reservation } from "./cost.ts";
import { snippetDigest, validateExplanation } from "./validate.ts";
import type { GroundingReport } from "./validate.ts";

export const MAX_OUTPUT_TOKENS = 1500;

export interface ExplainRequest {
  questionId: string;
  question: string;
  /** The node the user had selected, if any. Always beats text matching. */
  nodeAddress?: string | null;
  history?: { role: "user" | "assistant"; text: string }[];
}

export interface ExplainResult {
  explanation: Explanation;
  grounding: GroundingReport;
  /** Tokens reserved against the plan cap before the call. */
  reservedTokens: number;
}

export async function explain(
  g: Graph,
  src: SnippetSource,
  provider: ExplanationProvider,
  req: ExplainRequest,
): Promise<ExplainResult> {
  const c = classify(g, req.question, req.nodeAddress ?? null);

  /* ---------------------------------------------- deterministic path ---- */
  const fromGraph = c.deterministic ? answerFromGraph(g, src, c, req.question) : null;
  if (fromGraph) {
    const spans = fromGraph.claims.flatMap((cl) =>
      cl.citations.map((x) => ({ file: x.file, startLine: x.startLine, endLine: x.endLine })),
    );
    const explanation: Explanation = {
      schemaVersion: SCHEMA_VERSION,
      questionId: req.questionId,
      nodeAddress: c.focus,
      answerPath: fromGraph.claims.length === 0 ? "refused" : "deterministic",
      narrative: fromGraph.narrative,
      claims: fromGraph.claims,
      unanswered: fromGraph.unanswered,
      retrieval: {
        strategy: `deterministic:${c.intent}`,
        nodeAddresses: c.focus ? [c.focus] : [],
        edgeCount: fromGraph.claims.filter((x) => x.kind === "relationship").length,
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
    // Nothing was sent, so there is no context to check citations against; the
    // graph is the authority for every claim on this path.
    const emptyCtx = {
      focus: null,
      peers: [],
      edges: [],
      snippets: [],
      fileManifest: g.files.map((f) => f.path),
      visibleAddresses: [],
      diagnostics: [],
      sourceCharsSent: 0,
      strategy: "deterministic",
      scrubberFlags: [],
    };
    const grounding = validateExplanation(explanation, g, emptyCtx, src);
    explanation.flags = grounding.flags;
    if (grounding.status === "rejected") explanation.claims = [];
    return { explanation, grounding, reservedTokens: 0 };
  }

  /* ---------------------------------------------- narrated path --------- */
  const ctx = assembleContext(g, src, c.intent, c.focus);
  const prompt = buildPrompt(req.question, ctx, c, req.history);
  const providerReq = {
    system: prompt.system,
    userContent: prompt.userContent,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  const reserved = reservation(estimateTokens(prompt.userContent) + 1200, MAX_OUTPUT_TOKENS);

  const res = await provider.complete(providerReq);

  let parsed: { claims?: unknown[]; narrative?: unknown[]; unanswered?: unknown[] };
  const parseFlags: Flag[] = [];
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = { claims: [], narrative: [], unanswered: [] };
    parseFlags.push({
      code: "RESPONSE_NOT_JSON",
      severity: "error",
      message: "the provider returned output that is not valid JSON against the response schema",
    });
  }

  // The engine, not the model, asserts facts about our own system: the commit,
  // the snippet digest and who produced the claim.
  const claims = (parsed.claims ?? []).map((raw) => {
    const c0 = raw as Record<string, unknown>;
    const citations = ((c0.citations as unknown[]) ?? []).map((x) => {
      const cit = x as { file: string; startLine: number; endLine: number };
      return {
        file: cit.file,
        startLine: cit.startLine,
        endLine: cit.endLine,
        commitSha: g.commitSha,
        snippetSha256: snippetDigest(src, cit),
      };
    });
    return {
      id: String(c0.id ?? ""),
      text: String(c0.text ?? ""),
      confidence: c0.confidence as Explanation["claims"][number]["confidence"],
      kind: c0.kind as Explanation["claims"][number]["kind"],
      subjects: (c0.subjects as string[]) ?? [],
      values: c0.values as Record<string, string | number | boolean> | undefined,
      edge: c0.edge as { from: string; to: string; via: string } | undefined,
      citations,
      source: "model" as const,
    };
  });

  const explanation: Explanation = {
    schemaVersion: SCHEMA_VERSION,
    questionId: req.questionId,
    nodeAddress: c.focus,
    answerPath: "narrated",
    narrative: (parsed.narrative ?? []) as Explanation["narrative"],
    claims,
    unanswered: (parsed.unanswered ?? []) as Explanation["unanswered"],
    retrieval: {
      strategy: ctx.strategy,
      nodeAddresses: ctx.visibleAddresses,
      edgeCount: ctx.edges.length,
      spans: prompt.spans,
      sourceCharsSent: ctx.sourceCharsSent,
    },
    flags: [],
    usage: {
      model: res.model,
      inputTokens: res.inputTokens,
      cachedInputTokens: res.cachedInputTokens,
      outputTokens: res.outputTokens,
      costUsd: 0,
      costGbp: 0,
      measured: res.measured,
    },
  };

  try {
    const usd = costUsd(res.model, {
      inputTokens: res.inputTokens,
      cachedInputTokens: res.cachedInputTokens,
      cacheWriteTokens: res.cacheWriteTokens,
      outputTokens: res.outputTokens,
    });
    explanation.usage.costUsd = usd;
    explanation.usage.costGbp = gbp(usd);
  } catch {
    // Unknown model: report zero and flag rather than invent a price.
    parseFlags.push({
      code: "COST_UNKNOWN",
      severity: "warn",
      message: `no committed pricing for model ${res.model}; cost not reported`,
    });
  }

  const grounding = validateExplanation(explanation, g, ctx, src);
  const flags = [...parseFlags, ...grounding.flags];
  const rejected = flags.some((f) => f.severity === "error");
  explanation.flags = flags;
  explanation.claims = rejected ? [] : grounding.claims;
  if (rejected) {
    explanation.answerPath = "refused";
    explanation.narrative = [];
    explanation.unanswered = [
      {
        reason: "out-of-scope",
        detail:
          "I could not answer that from your configuration with enough confidence to show you. Nothing was shown rather than something possibly wrong.",
      },
    ];
  }

  return {
    explanation,
    grounding: {
      ...grounding,
      status: rejected ? "rejected" : grounding.status,
      claims: explanation.claims,
    },
    reservedTokens: reserved,
  };
}

export { LIMITS };
