/**
 * The grounding gate.
 *
 * This is the product. Everything else is plumbing around it.
 *
 * An explanation is checked against the authority that produced each claim:
 *
 *   - `source: "graph"` claims are re-derived from the graph. A relationship
 *     claim must correspond to a real edge; a count must equal the recomputed
 *     count. The model cannot influence these at all.
 *   - `source: "model"` claims are checked against the **text that was actually
 *     sent**. Every literal value asserted by a `verified` claim must appear
 *     verbatim in one of its cited spans, and every cited span must have been
 *     in the context. A value the model did not see cannot be verified by it.
 *
 * On top of that, every claim's prose is scanned for resource addresses and
 * file paths that do not exist. This is the hallucinated-resource detector, and
 * it is a build failure, not a quality note.
 *
 * Outcome:
 *   grounded  — ship it
 *   partial   — uncited inferences removed, a visible notice added
 *   rejected  — not shown to the user at all
 *
 * We would rather return nothing than return a confident invention.
 */

import type { Claim, Explanation, Flag, SourceRef } from "./contract.ts";
import { checkShape, normaliseSnippet } from "./contract.ts";
import type { Graph } from "./graph.ts";
import { blastRadius, incoming, nodeByAddress, outgoing } from "./graph.ts";
import type { AssembledContext, SnippetSource } from "./retrieval.ts";
import { createHash } from "node:crypto";

export type GroundingStatus = "grounded" | "partial" | "rejected";

/** Codes that reject the whole answer. Codes not listed here degrade to `partial`. */
export const REJECTING_CODES = new Set([
  "SCHEMA_INVALID",
  "UNKNOWN_SUBJECT",
  "INVENTED_ADDRESS_IN_TEXT",
  "INVENTED_FILE_IN_TEXT",
  "CITATION_FILE_UNKNOWN",
  "CITATION_OUT_OF_RANGE",
  "CITATION_NOT_IN_CONTEXT",
  "CITATION_DIGEST_MISMATCH",
  "VALUE_NOT_IN_CITED_TEXT",
  "EDGE_NOT_IN_GRAPH",
  "COUNT_MISMATCH",
  "VERIFIED_WITHOUT_CITATION",
  "GENERAL_KNOWLEDGE_WITH_CITATION",
  "PURPOSE_CLAIM_VERIFIED",
  "MODEL_CLAIMED_COUNT",
  "FACT_IN_CONNECTIVE",
]);

export interface GroundingReport {
  status: GroundingStatus;
  flags: Flag[];
  /** Claims that survived. Empty when `rejected`. */
  claims: Claim[];
  /** Claim ids removed as uncited inference. */
  removedClaimIds: string[];
}

/* -------------------------------------------------------------- utilities */

export function snippetDigest(src: SnippetSource, ref: SourceRef): string {
  const text = src.read(ref.file, ref.startLine, ref.endLine) ?? "";
  return createHash("sha256").update(normaliseSnippet(text)).digest("hex");
}

const DOTTED_TOKEN = /\b((?:data\.)?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)\b/g;
const TF_NAMESPACES = new Set(["var", "local", "module", "data", "output", "each", "count", "path", "terraform", "self"]);

/**
 * Is this token shaped like a Terraform address rather than a version string,
 * an instance class or a file name? Resource *types* always contain an
 * underscore (`aws_instance`, `google_compute_instance`), which cleanly
 * separates `aws_instance.bastion` from `db.t3.medium` and `main.tf`.
 */
export function isAddressShaped(token: string): boolean {
  const head = token.startsWith("data.") ? token.slice(5) : token;
  const prefix = head.split(".")[0]!;
  if (TF_NAMESPACES.has(prefix)) return true;
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(prefix);
}

/** Addresses asserted anywhere in a claim's prose. */
export function addressesInText(text: string): string[] {
  return [...new Set([...text.matchAll(DOTTED_TOKEN)].map((m) => m[1]!).filter(isAddressShaped))];
}

const FILE_TOKEN = /\b([A-Za-z0-9_./-]+\.(?:tf|tfvars|tf\.json|hcl))\b/g;

export function filesInText(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN)].map((m) => m[1]!))];
}

/** Connective prose may not carry facts: no digits, no addresses, no paths. */
const DIGIT = /\d/;

function spanContains(outer: SourceRef, inner: SourceRef): boolean {
  return (
    outer.file === inner.file &&
    inner.startLine >= outer.startLine &&
    inner.endLine <= outer.endLine
  );
}

/* ---------------------------------------------------------------- the gate */

export function validateExplanation(
  e: Explanation,
  g: Graph,
  ctx: AssembledContext,
  src: SnippetSource,
): GroundingReport {
  const flags: Flag[] = [];
  const removed: string[] = [];
  const fail = (code: string, message: string, extra: Partial<Flag> = {}) =>
    flags.push({ code, severity: REJECTING_CODES.has(code) ? "error" : "warn", message, ...extra });

  for (const err of checkShape(e)) fail("SCHEMA_INVALID", err);

  const symbols = new Set(g.nodes.map((n) => n.address));
  const fileLines = new Map(g.files.map((f) => [f.path, f.lineCount]));
  const sentSpans: SourceRef[] = ctx.snippets.map((s) => ({
    file: s.file,
    startLine: s.startLine,
    endLine: s.endLine,
  }));
  const sentText = new Map<string, string>();
  for (const s of ctx.snippets) {
    sentText.set(`${s.file}`, (sentText.get(s.file) ?? "") + s.lines.map(([, t]) => t).join("\n") + "\n");
  }

  const surviving: Claim[] = [];

  for (const c of e.claims ?? []) {
    let rejectedClaim = false;
    const flag = (code: string, message: string) => {
      fail(code, message, { claimId: c.id });
      if (REJECTING_CODES.has(code)) rejectedClaim = true;
    };

    /* --- confidence-class invariants ------------------------------------ */
    if (c.confidence === "verified" && c.citations.length === 0) {
      flag("VERIFIED_WITHOUT_CITATION", `claim ${c.id} is verified but cites nothing`);
    }
    if (c.confidence === "general-knowledge" && c.citations.length > 0) {
      flag(
        "GENERAL_KNOWLEDGE_WITH_CITATION",
        `claim ${c.id} is general provider knowledge but cites the customer's repository`,
      );
    }
    if (c.confidence === "general-knowledge" && c.subjects.length > 0) {
      flag("GENERAL_KNOWLEDGE_WITH_CITATION", `claim ${c.id} is general knowledge but names repository subjects`);
    }
    if (c.kind === "purpose" && c.confidence === "verified") {
      flag("PURPOSE_CLAIM_VERIFIED", `claim ${c.id} asserts a purpose as verified; purpose is always an inference`);
    }
    if (c.kind === "count" && c.source === "model") {
      flag("MODEL_CLAIMED_COUNT", `claim ${c.id} is a count produced by the model; counts come from the graph`);
    }

    /* --- subjects must exist -------------------------------------------- */
    for (const s of c.subjects) {
      if (!symbols.has(s)) flag("UNKNOWN_SUBJECT", `claim ${c.id} is about \`${s}\`, which is not in the graph`);
    }

    /* --- the hallucinated-resource detector ----------------------------- */
    // An attribute path such as `s3_target.0.path` is address-shaped. The one
    // that may appear is the claim's own `edge.via`, and only because the edge
    // check below re-derives it from the graph: an invented via still rejects.
    const realVia =
      c.kind === "relationship" &&
      c.edge &&
      g.edges.some((x) => x.from === c.edge!.from && x.to === c.edge!.to && x.via === c.edge!.via)
        ? c.edge.via
        : null;
    for (const addr of addressesInText(c.text)) {
      if (addr === realVia) continue;
      if (!symbols.has(addr)) {
        flag("INVENTED_ADDRESS_IN_TEXT", `claim ${c.id} names \`${addr}\`, which does not exist in the analysed commit`);
      }
    }
    for (const f of filesInText(c.text)) {
      if (!fileLines.has(f)) {
        flag("INVENTED_FILE_IN_TEXT", `claim ${c.id} names file \`${f}\`, which does not exist in the analysed commit`);
      }
    }

    /* --- citations resolve ---------------------------------------------- */
    for (const cit of c.citations) {
      const lineCount = fileLines.get(cit.file);
      if (lineCount === undefined) {
        flag("CITATION_FILE_UNKNOWN", `claim ${c.id} cites \`${cit.file}\`, which is not in the file manifest`);
        continue;
      }
      if (cit.startLine < 1 || cit.endLine > lineCount || cit.endLine < cit.startLine) {
        flag(
          "CITATION_OUT_OF_RANGE",
          `claim ${c.id} cites ${cit.file}:${cit.startLine}-${cit.endLine}; the file has ${lineCount} lines`,
        );
        continue;
      }
      if (cit.commitSha !== g.commitSha) {
        flag("CITATION_DIGEST_MISMATCH", `claim ${c.id} cites commit ${cit.commitSha}, not the analysed commit`);
        continue;
      }
      const actual = snippetDigest(src, cit);
      if (cit.snippetSha256 && cit.snippetSha256 !== actual) {
        flag("CITATION_DIGEST_MISMATCH", `claim ${c.id} cites ${cit.file}:${cit.startLine} but the text there has changed`);
      }
      // A model may only cite what it was shown. The graph may cite anything
      // in the graph, because it did not need to read the text to know it.
      if (c.source === "model" && !sentSpans.some((s) => spanContains(s, cit))) {
        flag(
          "CITATION_NOT_IN_CONTEXT",
          `claim ${c.id} cites ${cit.file}:${cit.startLine}-${cit.endLine}, which was not in the context sent`,
        );
      }
    }

    /* --- values are in the text that was sent --------------------------- */
    if (c.source === "model" && c.confidence === "verified" && c.values) {
      const cited = c.citations
        .map((cit) => src.read(cit.file, cit.startLine, cit.endLine) ?? "")
        .join("\n");
      for (const [path, v] of Object.entries(c.values)) {
        if (!String(cited).includes(String(v))) {
          flag(
            "VALUE_NOT_IN_CITED_TEXT",
            `claim ${c.id} asserts ${path} = ${JSON.stringify(v)} as verified, but that value does not appear in its cited source`,
          );
        }
      }
    }

    /* --- every relationship claim is re-derived from the graph ---------- */
    // Checked for `model` claims as well as `graph` ones. The graph is the only
    // authority on what references what, so a dependency the model asserts is
    // either in the graph or it is invented — there is no third case, and no
    // amount of correctly-cited source text makes an absent edge real.
    if (c.kind === "relationship" && c.edge) {
      const isTransitive = c.edge.via === "transitive-reference";
      const real = isTransitive
        ? blastRadius(g, c.edge.to).includes(c.edge.from)
        : g.edges.some((x) => x.from === c.edge!.from && x.to === c.edge!.to && x.via === c.edge!.via);
      if (!real) {
        flag(
          "EDGE_NOT_IN_GRAPH",
          `claim ${c.id} asserts ${c.edge.from} -> ${c.edge.to} via ${c.edge.via}, which is not an edge in the graph`,
        );
      }
    }

    /* --- graph claims are re-derived ------------------------------------ */
    if (c.source === "graph") {
      if (c.kind === "count" && c.values) {
        const subject = c.subjects[0];
        // A repository-wide count carries the filter it used (`resourceType`)
        // so the same filter can be reapplied here. Without that the count
        // would be the one graph-sourced number nothing re-derives.
        const resourceType =
          typeof c.values.resourceType === "string" ? c.values.resourceType : null;
        for (const [path, v] of Object.entries(c.values)) {
          const expected =
            path === "incomingEdges" && subject
              ? incoming(g, subject).length
              : path === "outgoingEdges" && subject
                ? outgoing(g, subject).length
                : path === "affectedCount" && subject
                  ? blastRadius(g, subject).length
                  : path === "count"
                    ? resourceType
                      ? g.nodes.filter((x) => x.type === resourceType).length
                      : g.nodes.filter((x) => x.kind === "resource").length
                    : null;
          if (expected !== null && expected !== v) {
            flag("COUNT_MISMATCH", `claim ${c.id} says ${path} = ${v}; the graph says ${expected}`);
          }
        }
      }
    }

    /* --- uncited inference degrades, it does not reject ----------------- */
    if (c.confidence === "inferred" && c.citations.length === 0) {
      fail("UNCITED_CLAIM", `claim ${c.id} is an inference with no supporting citation; removed`, {
        claimId: c.id,
      });
      removed.push(c.id);
      continue;
    }

    if (!rejectedClaim) surviving.push(c);
  }

  /* --- connective prose may not carry facts ----------------------------- */
  for (const b of e.narrative ?? []) {
    if (b.type !== "connective") continue;
    if (DIGIT.test(b.text) || addressesInText(b.text).length > 0 || filesInText(b.text).length > 0) {
      fail("FACT_IN_CONNECTIVE", `connective text carries a fact outside a claim: ${JSON.stringify(b.text)}`);
    }
  }

  /* --- refusal text must not invent either ------------------------------ */
  for (const u of e.unanswered ?? []) {
    for (const addr of addressesInText(u.detail)) {
      // A refusal is allowed to name the thing it is refusing about, and that
      // thing is by definition absent. Only a *claim* of existence is a fault.
      if (!symbols.has(addr) && !/\b(no|not|does not|absent|nothing)\b/i.test(u.detail)) {
        fail("INVENTED_ADDRESS_IN_TEXT", `refusal text asserts \`${addr}\`, which does not exist`);
      }
    }
  }

  /* --- injection: a steered answer is never shown as verified ----------- */
  if (ctx.scrubberFlags.length > 0) {
    for (const f of ctx.scrubberFlags) {
      flags.push({
        code: "INJECTION_ATTEMPT_IN_SOURCE",
        severity: "warn",
        message: `repository content at ${f.where.file}:${f.where.startLine} attempts to instruct the assistant (${f.code}); treated as data`,
        where: f.where,
      });
    }
  }

  const hasError = flags.some((f) => f.severity === "error");
  const status: GroundingStatus = hasError ? "rejected" : removed.length > 0 ? "partial" : "grounded";
  return { status, flags, claims: hasError ? [] : surviving, removedClaimIds: removed };
}
