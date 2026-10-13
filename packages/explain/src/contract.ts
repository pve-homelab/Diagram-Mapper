/**
 * Diagram Mapper — explanation response contract, v1.0.
 *
 * This file is the single source of truth for the shape the explanation engine
 * returns and the UI renders. Frontend builds against these types; the grounding
 * validator in `validate.ts` enforces them.
 *
 * Design rule that makes grounding checkable: **no fact may appear outside a
 * Claim.** The narrative is not free prose — it is an ordered list of blocks that
 * are either a reference to a Claim or a short connective phrase that is
 * structurally forbidden from containing facts (no digits, no identifiers).
 */

export const SCHEMA_VERSION = "1.0" as const;

/** 1-indexed, inclusive line range in a repo-relative POSIX path. */
export interface SourceRef {
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * A citation is a SourceRef pinned to the analysed commit, plus a digest of the
 * cited text. We do not retain raw customer IaC, so the digest is how we detect
 * that a citation no longer matches what is at that location.
 */
export interface Citation extends SourceRef {
  commitSha: string;
  /** sha256 of the normalised cited text (see `normaliseSnippet`). */
  snippetSha256: string;
}

export type Confidence = "verified" | "inferred" | "general-knowledge";

export type ClaimKind =
  /** "this resource exists / is of type X" */
  | "existence"
  /** "attribute A of X is V" */
  | "attribute"
  /** "X references / depends on Y" */
  | "relationship"
  /** "N things reference X" */
  | "count"
  /** "this is probably a bastion host" — may never be `verified` */
  | "purpose"
  /** "an ALB is a layer-7 load balancer" — must be `general-knowledge` */
  | "provider-doc";

export interface Claim {
  /** Stable within one response: "c1", "c2", ... */
  id: string;
  /** One sentence. No markdown. Max 320 characters. */
  text: string;
  confidence: Confidence;
  kind: ClaimKind;
  /**
   * Graph node addresses this claim is about (e.g. "aws_instance.bastion").
   * Must be empty for `general-knowledge`.
   */
  subjects: string[];
  /**
   * Literal values the claim asserts, keyed by attribute path. Every value here
   * must appear verbatim in at least one cited span for a `verified` claim.
   */
  values?: Record<string, string | number | boolean>;
  /** Required for `relationship` claims; must match a graph edge. */
  edge?: { from: string; to: string; via: string };
  /**
   * Required non-empty for `verified` and `inferred`. Must be empty for
   * `general-knowledge` — general knowledge is not in the customer's repository
   * and must not pretend to be.
   */
  citations: Citation[];
  /** `graph` = produced deterministically; `model` = narrated by the LLM. */
  source: "graph" | "model";
}

/**
 * Connective text is the only prose the model may emit outside a claim. The
 * validator rejects digits and identifier-shaped tokens inside it, so a fact
 * cannot hide here.
 */
export interface ConnectiveBlock {
  type: "connective";
  text: string;
}

export interface ClaimBlock {
  type: "claim";
  claimId: string;
}

export type NarrativeBlock = ClaimBlock | ConnectiveBlock;

export type UnansweredReason =
  /** Nothing in the connected repository answers this. */
  | "not-in-repository"
  /** Would require live cloud state, which we do not read. */
  | "needs-runtime-state"
  /** Outside what the product claims to do. */
  | "out-of-scope";

export interface Unanswered {
  reason: UnansweredReason;
  /** Shown to the user. Must not name a resource absent from the symbol table. */
  detail: string;
}

export interface RetrievalTrace {
  strategy: string;
  nodeAddresses: string[];
  edgeCount: number;
  /** Exactly the spans that were sent to the provider. */
  spans: SourceRef[];
  /** Characters of customer source actually transmitted. */
  sourceCharsSent: number;
}

export interface Flag {
  code: string;
  severity: "error" | "warn";
  message: string;
  where?: SourceRef;
  claimId?: string;
}

export interface Usage {
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  costGbp: number;
  /** false = estimated by `cost.ts`; true = read from provider `usage`. */
  measured: boolean;
}

export interface Explanation {
  schemaVersion: typeof SCHEMA_VERSION;
  questionId: string;
  /** The node the question is about, if any. */
  nodeAddress: string | null;
  /** Answer path taken. `deterministic` means no model call was made. */
  answerPath: "deterministic" | "narrated" | "refused";
  narrative: NarrativeBlock[];
  claims: Claim[];
  unanswered: Unanswered[];
  retrieval: RetrievalTrace;
  flags: Flag[];
  usage: Usage;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Normalisation used before hashing a cited span. Trailing whitespace and line
 * endings are not semantic; everything else is.
 */
export function normaliseSnippet(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

export const MAX_CLAIM_TEXT = 320;
export const MAX_CONNECTIVE_TEXT = 120;

/** Shape-only validation. Grounding checks live in `validate.ts`. */
export function checkShape(e: unknown): string[] {
  const errs: string[] = [];
  const obj = e as Record<string, unknown>;
  if (!obj || typeof obj !== "object") return ["response is not an object"];
  if (obj.schemaVersion !== SCHEMA_VERSION) errs.push(`schemaVersion must be "${SCHEMA_VERSION}"`);
  if (!Array.isArray(obj.claims)) errs.push("claims must be an array");
  if (!Array.isArray(obj.narrative)) errs.push("narrative must be an array");
  if (!Array.isArray(obj.unanswered)) errs.push("unanswered must be an array");

  const claims = Array.isArray(obj.claims) ? (obj.claims as Claim[]) : [];
  const ids = new Set<string>();
  for (const c of claims) {
    if (!c.id) errs.push("claim without id");
    if (ids.has(c.id)) errs.push(`duplicate claim id ${c.id}`);
    ids.add(c.id);
    if (typeof c.text !== "string" || c.text.length === 0) errs.push(`${c.id}: empty text`);
    if (typeof c.text === "string" && c.text.length > MAX_CLAIM_TEXT) {
      errs.push(`${c.id}: text exceeds ${MAX_CLAIM_TEXT} chars`);
    }
    if (!["verified", "inferred", "general-knowledge"].includes(c.confidence)) {
      errs.push(`${c.id}: bad confidence ${String(c.confidence)}`);
    }
    if (!Array.isArray(c.citations)) errs.push(`${c.id}: citations must be an array`);
    if (!Array.isArray(c.subjects)) errs.push(`${c.id}: subjects must be an array`);
  }

  const narrative = Array.isArray(obj.narrative) ? (obj.narrative as NarrativeBlock[]) : [];
  for (const b of narrative) {
    if (b.type === "claim") {
      if (!ids.has(b.claimId)) errs.push(`narrative references unknown claim ${b.claimId}`);
    } else if (b.type === "connective") {
      if (b.text.length > MAX_CONNECTIVE_TEXT) errs.push("connective block too long");
    } else {
      errs.push(`unknown narrative block type ${String((b as { type: string }).type)}`);
    }
  }
  return errs;
}
