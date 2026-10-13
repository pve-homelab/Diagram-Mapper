/**
 * The evaluation harness.
 *
 * This exists before any prompt tuning, on purpose. Without a measuring
 * instrument, a prompt change is a story about a prompt change.
 *
 * What one run does, per question:
 *
 *   1. builds the graph from the committed fixture
 *   2. runs the real `explain()` — real classification, real retrieval, real
 *      prompt construction, real grounding gate, real cost accounting
 *   3. substitutes only the provider, with a committed response (a cassette)
 *   4. checks the answer against the question's known-correct expectations
 *   5. independently audits the provider response for hallucination, using
 *      `eval/audit.ts`, which shares no code with the runtime gate
 *   6. records what was sent to the provider and what it cost
 *
 * A question is PASS only when every expectation holds *and* the independent
 * audit agrees with the gate. A disagreement between the two is a failure even
 * if the user-visible answer happened to be fine, because it means one of the
 * two detectors is broken and we no longer know which.
 *
 * Usage
 *   node eval/run.ts                          # everything, cassettes, free
 *   node eval/run.ts --suite=tuning
 *   node eval/run.ts --suite=holdout
 *   node eval/run.ts --question=cw-attr-01 --verbose
 *   node eval/run.ts --check-lock             # held-out set unchanged?
 *   node eval/run.ts --write-lock             # deliberately re-pin it
 *   node eval/run.ts --provider=anthropic     # COSTS MONEY. see --dry-run first
 *   node eval/run.ts --provider=anthropic --dry-run   # exact tokens, no inference
 *
 * Exit code is 1 if any question fails, so CI fails the build.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { explain } from "../packages/explain/src/engine.ts";
import { classify } from "../packages/explain/src/intent.ts";
import type { Explanation, Claim } from "../packages/explain/src/contract.ts";
import { SCHEMA_VERSION } from "../packages/explain/src/contract.ts";
import type { Graph } from "../packages/explain/src/graph.ts";
import type {
  ExplanationProvider,
  ProviderRequest,
  ProviderResponse,
} from "../packages/explain/src/provider.ts";
import { estimateTokens } from "../packages/explain/src/retrieval.ts";
import {
  MODEL_PRICING,
  PLANS,
  capMarginShare,
  costUsd,
  explanationsPerMonth,
  gbp,
} from "../packages/explain/src/cost.ts";
import { buildFixtureGraph, FixtureSnippetSource } from "./fixture-graph.ts";
import { auditExplanation, auditEgress } from "./audit.ts";
import type { Violation } from "./audit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ types */

interface Expect {
  intent?: string;
  answerPath?: string;
  grounding?: string;
  zeroCost?: boolean;
  minClaims?: number;
  maxClaims?: number;
  values?: Record<string, string | number | boolean>;
  assertsEdges?: { from: string; to: string; via: string }[];
  assertsNoEdges?: boolean;
  mustNotAssertEdges?: { from: string; to: string }[];
  citesLines?: { file: string; line: number }[];
  requireClaim?: {
    textMatches: string;
    confidence?: string;
    kind?: string;
    citesLine?: { file: string; line: number };
  }[];
  unansweredReasons?: string[];
  mustNotNameAddresses?: string[];
  mustNotCiteFiles?: string[];
  mustNotContain?: string[];
  flagCodes?: string[];
  auditCodes?: string[];
  minInjectionFlags?: number;
  noVerifiedPurposeClaims?: boolean;
  maxEgressChars?: number;
}

interface Question {
  id: string;
  question: string;
  nodeAddress: string | null;
  cassette?: string;
  adversarial?: string;
  rationale?: string;
  expect: Expect;
}

interface QuestionFile {
  suite: "tuning" | "holdout";
  fixture: string;
  repoId: string;
  questions: Question[];
  /** Set by the loader, not the file. */
  _path: string;
}

interface Cassette {
  model: string;
  inputTokens: number;
  outputTokens: number;
  response?: unknown;
  text?: string;
}

interface Result {
  id: string;
  suite: string;
  repoId: string;
  adversarial: boolean;
  pass: boolean;
  failures: string[];
  answerPath: string;
  grounding: string;
  claimCount: number;
  injectionFlags: number;
  /** Characters of prompt sent to the provider. 0 on the deterministic path. */
  egressChars: number;
  /** Characters of customer source inside that payload. */
  sourceCharsSent: number;
  inputTokens: number;
  outputTokens: number;
  tokensMeasured: boolean;
  costGbp: number;
}

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
};
const SUITE = flag("suite") ?? "all";
const PROVIDER = flag("provider") ?? "cassette";
const ONLY = flag("question");
const VERBOSE = flag("verbose") !== null;
const JSON_OUT = flag("json") !== null;
const DRY_RUN = flag("dry-run") !== null;
const COST_MODEL = flag("cost-model") ?? "claude-sonnet-5";

/* ------------------------------------------------------- provider plumbing */

/**
 * Wraps the provider so the harness can see exactly what crossed the boundary.
 * The provider seam *is* the egress boundary, so measuring here measures the
 * real thing rather than a reconstruction of it.
 */
class RecordingProvider implements ExplanationProvider {
  readonly name: string;
  readonly model: string;
  sent: ProviderRequest | null = null;
  received: string | null = null;
  private inner: ExplanationProvider;
  constructor(inner: ExplanationProvider) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
  }
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.sent = req;
    const res = await this.inner.complete(req);
    this.received = res.text;
    return res;
  }
  async countInputTokens(req: ProviderRequest): Promise<number> {
    this.sent = req;
    return this.inner.countInputTokens(req);
  }
  get payload(): string {
    if (!this.sent) return "";
    return `${this.sent.system}\n${this.sent.userContent}`;
  }
}

class ReplayProvider implements ExplanationProvider {
  readonly name = "cassette";
  readonly model: string;
  private c: Cassette;
  constructor(c: Cassette) {
    this.c = c;
    this.model = c.model;
  }
  async complete(): Promise<ProviderResponse> {
    return {
      text: this.c.text ?? JSON.stringify(this.c.response ?? {}),
      model: this.c.model,
      inputTokens: this.c.inputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: this.c.outputTokens,
      // Hand-authored cassettes carry no real token counts. Saying so here is
      // what stops a zero being averaged into a cost-per-explanation figure.
      measured: this.c.inputTokens > 0,
    };
  }
  async countInputTokens(): Promise<number> {
    return this.c.inputTokens;
  }
}

/** Never called with --provider=cassette; a question with no cassette is a failure. */
class MissingProvider implements ExplanationProvider {
  readonly name = "missing";
  readonly model = "missing";
  async complete(): Promise<ProviderResponse> {
    throw new Error("this question reaches the narrated path but has no cassette");
  }
  async countInputTokens(): Promise<number> {
    return 0;
  }
}

/* --------------------------------------------------------------- loading */

function loadQuestionFiles(): QuestionFile[] {
  const base = join(ROOT, "eval", "questions");
  const out: QuestionFile[] = [];
  for (const suite of readdirSync(base)) {
    if (SUITE !== "all" && SUITE !== suite) continue;
    const dir = join(base, suite);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const p = join(dir, f);
      const parsed = JSON.parse(readFileSync(p, "utf8")) as QuestionFile;
      parsed._path = relative(ROOT, p);
      out.push(parsed);
    }
  }
  return out;
}

const graphCache = new Map<string, { graph: Graph; src: FixtureSnippetSource; root: string }>();
function fixtureFor(qf: QuestionFile) {
  if (!graphCache.has(qf.fixture)) {
    const root = join(ROOT, qf.fixture);
    graphCache.set(qf.fixture, {
      graph: buildFixtureGraph(root, qf.repoId),
      src: new FixtureSnippetSource(root),
      root,
    });
  }
  return graphCache.get(qf.fixture)!;
}

function loadCassette(name: string): Cassette {
  return JSON.parse(readFileSync(join(ROOT, "eval", "cassettes", name), "utf8")) as Cassette;
}

/**
 * The provider response as an `Explanation`, before the gate touched it.
 *
 * The independent audit runs on this, not on what the user would have seen.
 * Auditing the post-gate answer would only ever confirm that the gate did what
 * it already said it did; auditing the pre-gate response answers the question
 * that matters — "was this response a hallucination?" — without consulting the
 * gate at all.
 */
function preGateExplanation(c: Cassette, questionId: string): Explanation | null {
  const raw = c.response as { claims?: unknown[]; narrative?: unknown[] } | undefined;
  if (!raw) return null; // malformed-output cassette; nothing to audit
  const claims = ((raw.claims ?? []) as Record<string, unknown>[]).map(
    (x) =>
      ({
        id: String(x.id ?? ""),
        text: String(x.text ?? ""),
        confidence: x.confidence,
        kind: x.kind,
        subjects: (x.subjects as string[]) ?? [],
        values: x.values,
        edge: x.edge,
        citations: ((x.citations as Record<string, number | string>[]) ?? []).map((cit) => ({
          file: String(cit.file),
          startLine: Number(cit.startLine),
          endLine: Number(cit.endLine),
          commitSha: "",
          snippetSha256: "",
        })),
        source: "model",
      }) as Claim,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    questionId,
    nodeAddress: null,
    answerPath: "narrated",
    narrative: (raw.narrative ?? []) as Explanation["narrative"],
    claims,
    unanswered: [],
    retrieval: { strategy: "pre-gate", nodeAddresses: [], edgeCount: 0, spans: [], sourceCharsSent: 0 },
    flags: [],
    usage: {
      model: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costGbp: 0,
      measured: false,
    },
  };
}

/* ------------------------------------------------------------- the checks */

function spanHasLine(
  c: { file: string; startLine: number; endLine: number },
  file: string,
  line: number,
): boolean {
  return c.file === file && line >= c.startLine && line <= c.endLine;
}

function checkExpectations(
  q: Question,
  e: Explanation,
  intent: string,
  egressChars: number,
  preGateAudit: Violation[],
  finalAudit: Violation[],
): string[] {
  const f: string[] = [];
  const x = q.expect;
  const claims = e.claims;
  const allText = [...claims.map((c) => c.text), ...e.unanswered.map((u) => u.detail)].join("\n");

  if (x.intent && intent !== x.intent) f.push(`intent: expected ${x.intent}, got ${intent}`);
  if (x.answerPath && e.answerPath !== x.answerPath) {
    f.push(`answerPath: expected ${x.answerPath}, got ${e.answerPath}`);
  }
  if (x.zeroCost) {
    if (e.usage.costUsd !== 0 || e.usage.model !== null) {
      f.push(`zeroCost: a provider call was made (model=${e.usage.model}, cost=${e.usage.costUsd})`);
    }
    if (egressChars !== 0) f.push(`zeroCost: ${egressChars} chars were sent to the provider`);
  }
  if (x.minClaims !== undefined && claims.length < x.minClaims) {
    f.push(`claims: expected at least ${x.minClaims}, got ${claims.length}`);
  }
  if (x.maxClaims !== undefined && claims.length > x.maxClaims) {
    f.push(`claims: expected at most ${x.maxClaims}, got ${claims.length}`);
  }

  if (x.values) {
    for (const [k, v] of Object.entries(x.values)) {
      const found = claims.some((c) => c.values && c.values[k] === v);
      if (!found) f.push(`values: no claim asserts ${k} = ${JSON.stringify(v)}`);
    }
  }

  for (const want of x.assertsEdges ?? []) {
    const found = claims.some(
      (c) => c.edge && c.edge.from === want.from && c.edge.to === want.to && c.edge.via === want.via,
    );
    if (!found) f.push(`edges: no claim asserts ${want.from} -> ${want.to} via ${want.via}`);
  }
  if (x.assertsNoEdges && claims.some((c) => c.edge)) {
    f.push("edges: expected no relationship claims, got at least one");
  }
  for (const bad of x.mustNotAssertEdges ?? []) {
    if (claims.some((c) => c.edge && c.edge.from === bad.from && c.edge.to === bad.to)) {
      f.push(`edges: asserted ${bad.from} -> ${bad.to}, which is not in the configuration`);
    }
  }

  for (const want of x.citesLines ?? []) {
    const found = claims.some((c) => c.citations.some((cit) => spanHasLine(cit, want.file, want.line)));
    if (!found) f.push(`citations: nothing cites ${want.file}:${want.line}`);
  }

  for (const want of x.requireClaim ?? []) {
    const hits = claims.filter((c) => c.text.includes(want.textMatches));
    if (hits.length === 0) {
      f.push(`requireClaim: no claim text contains ${JSON.stringify(want.textMatches)}`);
      continue;
    }
    const ok = hits.filter(
      (c) =>
        (want.confidence === undefined || c.confidence === want.confidence) &&
        (want.kind === undefined || c.kind === want.kind) &&
        (want.citesLine === undefined ||
          c.citations.some((cit) => spanHasLine(cit, want.citesLine!.file, want.citesLine!.line))),
    );
    if (ok.length === 0) {
      const got = hits
        .map((c) => `${c.id}[${c.confidence}/${c.kind}]`)
        .join(", ");
      f.push(
        `requireClaim: a claim matches ${JSON.stringify(want.textMatches)} but not the required ` +
          `confidence/kind/citation (got ${got})`,
      );
    }
  }

  for (const want of x.unansweredReasons ?? []) {
    if (!e.unanswered.some((u) => u.reason === want)) {
      f.push(`unanswered: expected a ${want} entry, got [${e.unanswered.map((u) => u.reason).join(", ")}]`);
    }
  }

  for (const addr of x.mustNotNameAddresses ?? []) {
    if (
      allText.includes(addr) ||
      claims.some((c) => c.subjects.includes(addr)) ||
      claims.some((c) => c.edge && (c.edge.from === addr || c.edge.to === addr))
    ) {
      f.push(`leak: the answer names \`${addr}\`, which must never appear`);
    }
  }
  for (const file of x.mustNotCiteFiles ?? []) {
    if (claims.some((c) => c.citations.some((cit) => cit.file === file))) {
      f.push(`leak: the answer cites \`${file}\`, which must never be cited`);
    }
  }
  for (const s of x.mustNotContain ?? []) {
    if (allText.includes(s)) f.push(`leak: the answer contains ${JSON.stringify(s)}`);
  }

  if (x.noVerifiedPurposeClaims) {
    const bad = claims.filter((c) => c.kind === "purpose" && c.confidence === "verified");
    if (bad.length > 0) f.push(`confidence: purpose claims marked verified: ${bad.map((c) => c.id).join(", ")}`);
  }

  const codes = e.flags.map((fl) => fl.code);
  for (const want of x.flagCodes ?? []) {
    if (!codes.includes(want)) f.push(`flags: expected ${want}, got [${[...new Set(codes)].join(", ")}]`);
  }
  if (x.minInjectionFlags !== undefined) {
    const n = codes.filter((c) => c === "INJECTION_ATTEMPT_IN_SOURCE").length;
    if (n < x.minInjectionFlags) {
      f.push(`injection: expected at least ${x.minInjectionFlags} payloads flagged, got ${n}`);
    }
  }

  const auditCodes = preGateAudit.map((v) => v.code);
  for (const want of x.auditCodes ?? []) {
    if (!auditCodes.includes(want)) {
      f.push(
        `audit: the independent auditor did not report ${want} ` +
          `(got [${[...new Set(auditCodes)].join(", ") || "nothing"}])`,
      );
    }
  }

  if (x.maxEgressChars !== undefined && egressChars > x.maxEgressChars) {
    f.push(`egress: sent ${egressChars} chars, budget is ${x.maxEgressChars}`);
  }

  /* ---- universal invariants, applied whatever the question declares ---- */

  if (q.adversarial) {
    // The gate must refuse. This is the line the product cannot cross.
    if (e.answerPath !== "refused" || claims.length > 0) {
      f.push(
        `GROUNDING REGRESSION: an invented answer was accepted (path=${e.answerPath}, ${claims.length} claims survived)`,
      );
    }
  } else {
    if (finalAudit.length > 0) {
      for (const v of finalAudit) f.push(`AUDIT ${v.code} on ${v.claimId ?? "-"}: ${v.detail}`);
    }
    if (preGateAudit.length > 0) {
      for (const v of preGateAudit) {
        f.push(`AUDIT (pre-gate) ${v.code} on ${v.claimId ?? "-"}: ${v.detail}`);
      }
    }
    if (x.grounding === undefined && e.answerPath === "refused") {
      f.push("the engine refused a question that has a known correct answer");
    }
  }

  if (x.grounding) {
    // Checked last so a grounding mismatch reads after the reason for it.
    const status = e.flags.some((fl) => fl.severity === "error")
      ? "rejected"
      : e.flags.some((fl) => fl.code === "UNCITED_CLAIM")
        ? "partial"
        : "grounded";
    if (status !== x.grounding) f.push(`grounding: expected ${x.grounding}, got ${status}`);
  }

  return f;
}

/* ----------------------------------------------------------------- runner */

async function runQuestion(qf: QuestionFile, q: Question): Promise<Result> {
  const { graph, src, root } = fixtureFor(qf);
  const c = classify(graph, q.question, q.nodeAddress ?? null);

  let inner: ExplanationProvider = new MissingProvider();
  let cassette: Cassette | null = null;
  if (q.cassette) {
    cassette = loadCassette(q.cassette);
    inner = new ReplayProvider(cassette);
  }
  if (PROVIDER === "anthropic") {
    const { AnthropicProvider } = await import("../packages/explain/src/provider.ts");
    inner = new AnthropicProvider(COST_MODEL);
  }
  const provider = new RecordingProvider(inner);

  const failures: string[] = [];
  let explanation: Explanation;
  try {
    const out = await explain(graph, src, provider, {
      questionId: q.id,
      question: q.question,
      nodeAddress: q.nodeAddress ?? null,
    });
    explanation = out.explanation;
  } catch (err) {
    failures.push(`threw: ${(err as Error).message}`);
    explanation = {
      schemaVersion: SCHEMA_VERSION,
      questionId: q.id,
      nodeAddress: null,
      answerPath: "refused",
      narrative: [],
      claims: [],
      unanswered: [],
      retrieval: { strategy: "error", nodeAddresses: [], edgeCount: 0, spans: [], sourceCharsSent: 0 },
      flags: [],
      usage: {
        model: null,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        costGbp: 0,
        measured: false,
      },
    };
  }

  const payload = provider.payload;
  const egressChars = payload.length;

  const finalAudit = auditExplanation({ explanation, graph, fixtureRoot: root });
  const pre = cassette ? preGateExplanation(cassette, q.id) : null;
  const preGateAudit = pre ? auditExplanation({ explanation: pre, graph, fixtureRoot: root }) : [];

  failures.push(
    ...checkExpectations(q, explanation, c.intent, egressChars, preGateAudit, finalAudit),
  );

  // Egress is checked on every question, declared budget or not: a credential
  // or an unscrubbed comment reaching the provider is a failure by itself.
  if (payload.length > 0) {
    for (const v of auditEgress(payload, {
      maxChars: q.expect.maxEgressChars ?? Number.MAX_SAFE_INTEGER,
      fixtureRoot: root,
      graph,
    })) {
      if (v.code !== "EGRESS_OVER_BUDGET") failures.push(`EGRESS ${v.code}: ${v.detail}`);
    }
  }

  // Cost. Measured when the provider reported real counts; estimated from the
  // payload otherwise, and labelled as such in the report.
  const measured = explanation.usage.measured && explanation.usage.inputTokens > 0;
  const inputTokens = measured ? explanation.usage.inputTokens : estimateTokens(payload);
  const outputTokens = measured
    ? explanation.usage.outputTokens
    : estimateTokens(provider.received ?? "");
  const costGbp = measured
    ? explanation.usage.costGbp
    : egressChars === 0
      ? 0
      : gbp(
          costUsd(COST_MODEL, {
            inputTokens,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens,
          }),
        );

  return {
    id: q.id,
    suite: qf.suite,
    repoId: qf.repoId,
    adversarial: Boolean(q.adversarial),
    pass: failures.length === 0,
    failures,
    answerPath: explanation.answerPath,
    grounding: explanation.flags.some((fl) => fl.severity === "error") ? "rejected" : "grounded",
    claimCount: explanation.claims.length,
    injectionFlags: explanation.flags.filter((fl) => fl.code === "INJECTION_ATTEMPT_IN_SOURCE").length,
    egressChars,
    sourceCharsSent: explanation.retrieval.sourceCharsSent,
    inputTokens,
    outputTokens,
    tokensMeasured: measured,
    costGbp,
  };
}

/* ------------------------------------------------------------ holdout lock */

const LOCK_PATH = join(ROOT, "eval", "holdout-lock.json");

function holdoutFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "eval", "fixtures", "holdout"));
  walk(join(ROOT, "eval", "questions", "holdout"));
  // Held-out cassettes, by naming convention.
  const cas = join(ROOT, "eval", "cassettes");
  for (const f of readdirSync(cas).sort()) {
    if (/^dp/.test(f)) out.push(relative(ROOT, join(cas, f)));
  }
  const adv = join(cas, "adv");
  for (const f of readdirSync(adv).sort()) {
    if (/^dp/.test(f)) out.push(relative(ROOT, join(adv, f)));
  }
  return out;
}

function hashOf(rel: string): string {
  return createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex").slice(0, 16);
}

function writeLock(): void {
  const entries: Record<string, string> = {};
  for (const f of holdoutFiles()) entries[f] = hashOf(f);
  writeFileSync(
    LOCK_PATH,
    JSON.stringify(
      {
        note:
          "Pinned hashes of the held-out fixtures, questions and cassettes. CI compares " +
          "against these. Regenerating this file is how you deliberately change the " +
          "held-out set — it shows up as a diff in review, which is the point: an " +
          "easy, invisible edit to a failing held-out expectation would destroy the " +
          "only honest quality signal we have.",
        generated: new Date().toISOString().slice(0, 10),
        files: entries,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${relative(ROOT, LOCK_PATH)} with ${Object.keys(entries).length} entries`);
}

function checkLock(): boolean {
  let lock: { files: Record<string, string> };
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    console.error(`no ${relative(ROOT, LOCK_PATH)}; run --write-lock`);
    return false;
  }
  const now: Record<string, string> = {};
  for (const f of holdoutFiles()) now[f] = hashOf(f);
  const problems: string[] = [];
  for (const [f, h] of Object.entries(lock.files)) {
    if (!(f in now)) problems.push(`removed: ${f}`);
    else if (now[f] !== h) problems.push(`changed: ${f}`);
  }
  for (const f of Object.keys(now)) if (!(f in lock.files)) problems.push(`added: ${f}`);
  if (problems.length === 0) {
    console.log(`holdout lock OK (${Object.keys(now).length} files)`);
    return true;
  }
  console.error("HELD-OUT SET CHANGED:");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nIf this change is deliberate, run `node eval/run.ts --write-lock` and explain it in the\n" +
      "commit message. If it is not, you are about to tune against the held-out set.",
  );
  return false;
}

/* ------------------------------------------------------------- reporting */

function report(results: Result[]): void {
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  const bySuite = new Map<string, Result[]>();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite)!.push(r);
  }

  console.log("");
  for (const [suite, rs] of [...bySuite].sort()) {
    const passed = rs.filter((r) => r.pass).length;
    console.log(`── ${suite} ────────────────────────────────── ${passed}/${rs.length}`);
    for (const r of rs) {
      const mark = r.pass ? "  ok  " : " FAIL ";
      const tag = r.adversarial ? "adv " : "    ";
      console.log(
        `${mark}${tag}${pad(r.id, 22)} ${pad(r.answerPath, 14)} ${pad(`${r.claimCount} claims`, 10)}` +
          `${r.egressChars === 0 ? "no model call" : `${r.egressChars} chars out`}`,
      );
      if (!r.pass) for (const fail of r.failures) console.log(`          ${fail}`);
      if (VERBOSE && r.pass && r.injectionFlags > 0) {
        console.log(`          ${r.injectionFlags} injection payload(s) flagged`);
      }
    }
    console.log("");
  }

  /* --- grounding --- */
  const adv = results.filter((r) => r.adversarial);
  const honest = results.filter((r) => !r.adversarial);
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;

  console.log("── grounding ───────────────────────────────────────────");
  console.log(`  questions                     ${total}`);
  console.log(`  pass rate                     ${passed}/${total} (${pct(passed / total)})`);
  console.log(
    `  known-answer questions        ${honest.filter((r) => r.pass).length}/${honest.length} (${pct(
      honest.filter((r) => r.pass).length / honest.length,
    )})`,
  );
  console.log(
    `  hallucinations rejected       ${adv.filter((r) => r.pass).length}/${adv.length} (${pct(
      adv.filter((r) => r.pass).length / adv.length,
    )})`,
  );
  console.log(
    `  injection payloads flagged    ${results.reduce((a, r) => a + r.injectionFlags, 0)}`,
  );

  /* --- cost --- */
  const narrated = results.filter((r) => r.egressChars > 0);
  const deterministic = results.filter((r) => r.egressChars === 0);
  const anyMeasured = narrated.some((r) => r.tokensMeasured);
  const meanIn = mean(narrated.map((r) => r.inputTokens));
  const meanOut = mean(narrated.map((r) => r.outputTokens));
  const meanCost = mean(narrated.map((r) => r.costGbp));
  const basis = anyMeasured ? "MEASURED (provider usage)" : "ESTIMATED (chars/3.5; not a tokeniser)";

  console.log("");
  console.log(`── cost per unit of customer value ─────────────────────`);
  console.log(`  pricing model                 ${COST_MODEL}`);
  console.log(`  token basis                   ${basis}`);
  console.log(
    `  answered without a model call ${deterministic.length}/${total} (${pct(
      deterministic.length / total,
    )}) at GBP 0.00 each`,
  );
  console.log(`  mean input tokens / question  ${Math.round(meanIn)}`);
  console.log(`  mean output tokens / question ${Math.round(meanOut)}`);
  console.log(`  mean cost / narrated question GBP ${meanCost.toFixed(5)}`);
  console.log(
    `  mean cost / question overall  GBP ${(mean(results.map((r) => r.costGbp))).toFixed(5)}`,
  );
  console.log(
    `  customer source sent / q      ${Math.round(mean(narrated.map((r) => r.sourceCharsSent)))} chars`,
  );
  console.log(`  cost of this whole run        GBP ${results.reduce((a, r) => a + r.costGbp, 0).toFixed(5)}`);

  const perQuestionTokens = meanIn + meanOut;
  console.log("");
  console.log("── what that buys on each plan ─────────────────────────");
  for (const plan of Object.values(PLANS)) {
    if (plan.requiresOwnApiKey) {
      console.log(`  ${pad(plan.id, 6)} customer's own key; our AI cost GBP 0.00`);
      continue;
    }
    const n = explanationsPerMonth(plan, perQuestionTokens);
    console.log(
      `  ${pad(plan.id, 6)} GBP ${pad(plan.priceGbp.toFixed(2), 6)}/mo  cap ${pad(
        `${(plan.monthlyTokenCap / 1e6).toFixed(1)}M tok`,
        10,
      )}  ~${pad(String(n), 6)} questions  worst-case AI cost ${pct(
        capMarginShare(plan, COST_MODEL),
      )} of revenue`,
    );
  }
  if (!anyMeasured) {
    console.log("");
    console.log(
      "  NOTE: token counts above are estimates. Exact input tokens need\n" +
        "        `--provider=anthropic --dry-run` (count_tokens, no inference);\n" +
        "        output tokens need a real call. Neither has been run: no key.",
    );
  }
  console.log("");
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  if (flag("write-lock") !== null) {
    writeLock();
    return;
  }

  let lockOk = true;
  if (flag("check-lock") !== null || SUITE === "all" || SUITE === "holdout") {
    lockOk = checkLock();
    if (flag("check-lock") !== null) {
      process.exit(lockOk ? 0 : 1);
    }
  }

  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    console.error("--provider=anthropic needs ANTHROPIC_API_KEY in the environment");
    process.exit(2);
  }
  if (PROVIDER === "anthropic" && !DRY_RUN) {
    console.error(
      "live run: this spends real money. Re-run with --dry-run first to see exact input\n" +
        "token counts, and say the figure on the task before spending.",
    );
  }
  if (!MODEL_PRICING[COST_MODEL]) {
    console.error(`no committed pricing for --cost-model=${COST_MODEL}`);
    process.exit(2);
  }

  const files = loadQuestionFiles();
  const results: Result[] = [];
  for (const qf of files) {
    for (const q of qf.questions) {
      if (ONLY && q.id !== ONLY) continue;
      results.push(await runQuestion(qf, q));
    }
  }

  if (results.length === 0) {
    console.error("no questions matched");
    process.exit(2);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ lockOk, results }, null, 2));
  } else {
    report(results);
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.length} of ${results.length} — ${failed.map((r) => r.id).join(", ")}`);
  }
  process.exit(failed.length === 0 && lockOk ? 0 : 1);
}

await main();
