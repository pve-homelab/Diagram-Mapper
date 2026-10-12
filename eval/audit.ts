/**
 * The independent grounding audit.
 *
 * `packages/explain/src/validate.ts` is the runtime gate: it decides whether a
 * user is shown an answer. This file is the *auditor* of that gate, and it is
 * deliberately NOT built from the same code.
 *
 * Why the duplication is the point: if the only hallucination check in the
 * system is the gate, then a bug in the gate is invisible. The gate passes the
 * bad answer, and a harness that asks the gate "was that answer grounded?"
 * cheerfully agrees. The suite would be green and the product would be lying.
 *
 * So this module re-derives everything from the two sources of truth the gate
 * does not own:
 *
 *   - the fixture `.tf` files, re-read from disk at audit time
 *   - the fixture graph, rebuilt from those files
 *
 * It imports nothing from `validate.ts` — no shared regex, no shared symbol
 * table, no shared notion of "address-shaped". Where the two disagree, the
 * build fails and a human looks. That is the intended behaviour: agreement
 * between two independent implementations is the evidence, not either one's
 * verdict on its own.
 *
 * Every violation this returns fails the build. None of them are quality notes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Explanation } from "../packages/explain/src/contract.ts";
import type { Graph } from "../packages/explain/src/graph.ts";

export interface Violation {
  /** Stable code so a regression can be asserted by name in a question file. */
  code: string;
  claimId: string | null;
  detail: string;
}

/**
 * Independent address matcher. Written from the Terraform address grammar
 * rather than copied from the engine, so the two can disagree.
 *
 * Matches `aws_instance.bastion`, `data.aws_ami.ubuntu`, `var.vpc_cidr`,
 * `module.network`, `local.prefix`, `output.alb_dns_name`.
 */
const ADDRESS_LIKE =
  /\b(?:data\.[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+|(?:var|local|module|output|provider)\.[A-Za-z0-9_-]+|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z0-9_-]+)\b/g;

/** Independent file matcher. */
const PATH_LIKE = /\b[A-Za-z0-9_./-]+\.(?:tf|tfvars|hcl|json)\b/g;

/**
 * Tokens that look like an address but are a provider value, not a reference.
 * These are real configuration strings in the fixtures (`db.t3.medium`,
 * `python3.12`), so treating them as addresses would produce false failures.
 * A false failure is as bad as a missed one: it trains people to ignore the
 * suite. Each entry is here because a fixture actually contains it.
 */
const NOT_AN_ADDRESS = new Set([
  "main.handler",
  "0.0.0.0",
  "s3.tables",
]);

function looksLikeAddress(token: string): boolean {
  if (NOT_AN_ADDRESS.has(token)) return false;
  // `db.t3.medium`, `t3.micro`, `python3.12`: the head has no underscore and
  // is not a Terraform namespace, so it cannot be a resource type.
  const head = token.split(".")[0]!;
  const isNamespace = ["var", "local", "module", "output", "provider", "data"].includes(head);
  return isNamespace || head.includes("_");
}

export interface AuditInput {
  explanation: Explanation;
  graph: Graph;
  /** Directory the fixture `.tf` files live in. Re-read, not cached. */
  fixtureRoot: string;
}

export function auditExplanation({ explanation, graph, fixtureRoot }: AuditInput): Violation[] {
  const v: Violation[] = [];
  const add = (code: string, claimId: string | null, detail: string) =>
    v.push({ code, claimId, detail });

  // Rebuilt from the graph rather than taken from the engine's own view.
  const realAddresses = new Set(graph.nodes.map((n) => n.address));

  // Re-read from disk. If the engine cited a file that does not exist, this
  // throws nothing — the file simply is not in the map, which is a violation.
  const fileText = new Map<string, string[]>();
  for (const f of graph.files) {
    try {
      fileText.set(f.path, readFileSync(join(fixtureRoot, f.path), "utf8").split("\n"));
    } catch {
      add("FIXTURE_FILE_UNREADABLE", null, `${f.path} is in the graph manifest but not on disk`);
    }
  }

  const readSpan = (file: string, from: number, to: number): string | null => {
    const lines = fileText.get(file);
    if (!lines) return null;
    if (from < 1 || from > lines.length) return null;
    return lines.slice(from - 1, Math.min(to, lines.length)).join("\n");
  };

  for (const c of explanation.claims) {
    // An attribute path like `s3_target.0.path` is address-shaped. It is exempt
    // only when it is this claim's own via AND that edge independently exists.
    const via =
      c.edge && graph.edges.some((e) => e.from === c.edge!.from && e.to === c.edge!.to && e.via === c.edge!.via)
        ? c.edge.via
        : null;
    /* --- 1. invented resource ------------------------------------------- */
    for (const m of c.text.matchAll(ADDRESS_LIKE)) {
      const token = m[0];
      if (!looksLikeAddress(token)) continue;
      if (via && (via === token || via.startsWith(`${token}.`))) continue;
      if (!realAddresses.has(token)) {
        add(
          "HALLUCINATED_RESOURCE",
          c.id,
          `claim text names \`${token}\`, which is not declared anywhere in the fixture`,
        );
      }
    }
    for (const s of c.subjects) {
      if (!realAddresses.has(s)) {
        add("HALLUCINATED_RESOURCE", c.id, `claim subject \`${s}\` is not declared in the fixture`);
      }
    }

    /* --- 2. invented file ----------------------------------------------- */
    for (const m of c.text.matchAll(PATH_LIKE)) {
      if (!fileText.has(m[0])) {
        add("HALLUCINATED_FILE", c.id, `claim text names file \`${m[0]}\`, which is not in the fixture`);
      }
    }

    /* --- 3. invented dependency ----------------------------------------- */
    if (c.kind === "relationship" && c.edge) {
      const { from, to, via } = c.edge;
      const direct = graph.edges.some((e) => e.from === from && e.to === to && e.via === via);
      const transitive = via === "transitive-reference" && reaches(graph, from, to);
      if (!direct && !transitive) {
        add(
          "HALLUCINATED_DEPENDENCY",
          c.id,
          `claim asserts ${from} -> ${to} via \`${via}\`, which is not a reference in the fixture`,
        );
      }
    }

    /* --- 4. citation does not resolve ----------------------------------- */
    for (const cit of c.citations) {
      const lines = fileText.get(cit.file);
      if (!lines) {
        add("CITATION_UNRESOLVABLE", c.id, `cites \`${cit.file}\`, which is not a fixture file`);
        continue;
      }
      if (cit.startLine < 1 || cit.endLine > lines.length || cit.endLine < cit.startLine) {
        add(
          "CITATION_UNRESOLVABLE",
          c.id,
          `cites ${cit.file}:${cit.startLine}-${cit.endLine}; the file has ${lines.length} lines`,
        );
      }
    }

    /* --- 5a. invented count --------------------------------------------- */
    // A count is derived, not quoted, so it is checked by recomputing it —
    // from `graph.edges` directly rather than through the engine's own graph
    // helpers, so a bug in those helpers cannot make a wrong count look right.
    if (c.kind === "count" && c.values) {
      const subject = c.subjects[0];
      const type = typeof c.values.resourceType === "string" ? c.values.resourceType : null;
      for (const [path, value] of Object.entries(c.values)) {
        if (typeof value !== "number") continue;
        let expected: number | null = null;
        if (path === "incomingEdges" && subject) {
          expected = graph.edges.filter((e) => e.to === subject).length;
        } else if (path === "outgoingEdges" && subject) {
          expected = graph.edges.filter((e) => e.from === subject).length;
        } else if (path === "affectedCount" && subject) {
          expected = countReachingInto(graph, subject);
        } else if (path === "count") {
          expected = type
            ? graph.nodes.filter((n) => n.type === type).length
            : graph.nodes.filter((n) => n.kind === "resource").length;
        }
        if (expected !== null && expected !== value) {
          add(
            "HALLUCINATED_COUNT",
            c.id,
            `claim asserts ${path} = ${value}; recomputing from the fixture gives ${expected}`,
          );
        }
      }
    }

    /* --- 5b. invented attribute value ----------------------------------- */
    // The strictest check, and the one that catches the subtle lie: a claim
    // marked `verified` whose literal value is not in the text it points at.
    // Counts are exempt because they were just re-derived above; a derived
    // number has no reason to appear verbatim in the lines it cites.
    if (c.confidence === "verified" && c.values && c.kind !== "count") {
      const cited = c.citations
        .map((cit) => readSpan(cit.file, cit.startLine, cit.endLine) ?? "")
        .join("\n");
      for (const [path, value] of Object.entries(c.values)) {
        if (path === "resourceType") continue; // engine metadata, not a config value
        if (typeof value === "number" || typeof value === "string") {
          if (!cited.includes(String(value))) {
            add(
              "HALLUCINATED_VALUE",
              c.id,
              `verified claim asserts ${path} = ${JSON.stringify(value)}, which does not appear in the lines it cites`,
            );
          }
        }
      }
    }

    /* --- 6. confidence-class integrity --------------------------------- */
    if (c.confidence === "verified" && c.citations.length === 0) {
      add("UNCITED_VERIFIED_CLAIM", c.id, "claim is verified but points at nothing");
    }
    if (c.kind === "purpose" && c.confidence === "verified") {
      add("PURPOSE_AS_VERIFIED", c.id, "a purpose is an inference and can never be verified");
    }
    if (c.confidence === "general-knowledge" && c.citations.length > 0) {
      add(
        "GENERAL_KNOWLEDGE_CITES_REPO",
        c.id,
        "a claim about how the provider behaves cites the customer's configuration as its evidence",
      );
    }
  }

  /* --- 7. facts smuggled into connective prose ------------------------- */
  for (const b of explanation.narrative) {
    if (b.type !== "connective") continue;
    if (/\d/.test(b.text)) {
      add("FACT_OUTSIDE_CLAIM", null, `connective text contains a number: ${JSON.stringify(b.text)}`);
    }
    for (const m of b.text.matchAll(ADDRESS_LIKE)) {
      if (looksLikeAddress(m[0])) {
        add("FACT_OUTSIDE_CLAIM", null, `connective text names \`${m[0]}\``);
      }
    }
  }

  /* --- 8. every narrative claim reference resolves --------------------- */
  const claimIds = new Set(explanation.claims.map((c) => c.id));
  for (const b of explanation.narrative) {
    if (b.type === "claim" && !claimIds.has(b.claimId)) {
      add("DANGLING_CLAIM_REFERENCE", b.claimId, "narrative references a claim that is not present");
    }
  }

  return v;
}

/**
 * How many distinct nodes transitively reference `target`. Independent
 * re-implementation of the blast-radius count, by reverse breadth-first walk.
 */
function countReachingInto(g: Graph, target: string): number {
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of g.edges) {
      if (e.to !== cur) continue;
      if (e.from === target || seen.has(e.from)) continue;
      seen.add(e.from);
      queue.push(e.from);
    }
  }
  return seen.size;
}

/** Independent transitive-reachability check for blast-radius claims. */
function reaches(g: Graph, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of g.edges) {
      if (e.from !== cur) continue;
      if (e.to === to) return true;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

/**
 * Egress audit: what actually left the process.
 *
 * Separate from the claim audit because it checks a different promise. The
 * grounding promise is "nothing we tell you is invented"; this is "nothing we
 * did not need to send was sent". Both are testable and neither implies the
 * other.
 */
export interface EgressViolation {
  code: string;
  detail: string;
}

const CREDENTIAL_SHAPES: { code: string; re: RegExp }[] = [
  { code: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { code: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
];

export function auditEgress(
  payload: string,
  opts: { maxChars: number; fixtureRoot: string; graph: Graph },
): EgressViolation[] {
  const v: EgressViolation[] = [];
  for (const { code, re } of CREDENTIAL_SHAPES) {
    if (re.test(payload)) v.push({ code: "CREDENTIAL_IN_EGRESS", detail: `payload matches ${code}` });
  }
  if (payload.length > opts.maxChars) {
    v.push({
      code: "EGRESS_OVER_BUDGET",
      detail: `payload is ${payload.length} chars; the budget for this question is ${opts.maxChars}`,
    });
  }
  // A comment that survived scrubbing is both a privacy leak and the delivery
  // vehicle for every injection payload in the fixtures.
  for (const line of payload.split("\\n")) {
    if (/#\s*(SYSTEM|IMPORTANT INSTRUCTION|AI:)/i.test(line)) {
      v.push({ code: "COMMENT_IN_EGRESS", detail: `an unscrubbed comment reached the payload: ${line.slice(0, 80)}` });
    }
  }
  return v;
}
