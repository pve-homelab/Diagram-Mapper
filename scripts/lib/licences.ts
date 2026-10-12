/**
 * Pure evaluation logic for the licence gate (docs/LICENCE-AND-DEPENDENCY-PLAN.md section 4.1).
 * Allow-list semantics: a licence that the policy does not name is prohibited.
 */

export type Surface = "server" | "client";

export interface Dependency {
  name: string;
  version: string;
  license: string | null;
}

export interface Exception {
  spdx: string;
  package: string;
  version: string;
  surface: string;
  reason: string;
  compensatingControl: string;
  approver: string;
  approved: string;
  reviewBy: string;
}

export interface Policy {
  permitted: { spdx: string[] };
  conditional: Record<string, unknown>;
  prohibited: { entries: { spdx: string[]; exceptionsAllowed: boolean }[] };
  unresolved: { values: (string | null)[] };
  assets: { permittedWithAttribution: string[] };
}

export type Verdict =
  | "permitted"
  | "attribution"
  | "conditional"
  | "excepted"
  | "prohibited"
  | "unknown"
  | "surface";

export interface Result {
  dep: Dependency;
  surface: Surface;
  verdict: Verdict;
  detail: string;
}

export const PASSING: ReadonlySet<Verdict> = new Set([
  "permitted",
  "attribution",
  "conditional",
  "excepted",
]);

interface ConditionalRule {
  surfaces: string[];
}

function conditionalRule(policy: Policy, id: string): ConditionalRule | undefined {
  if (id === "$comment") return undefined;
  const rule = policy.conditional[id];
  if (typeof rule !== "object" || rule === null || !("surfaces" in rule)) return undefined;
  return rule as ConditionalRule;
}

/** Classify a single SPDX identifier (no operators) on one surface. */
export function classifyId(policy: Policy, id: string, surface: Surface): [Verdict, string] {
  if (policy.permitted.spdx.includes(id)) return ["permitted", id];
  if (policy.assets.permittedWithAttribution.includes(id)) {
    return ["attribution", `${id}: attribution required in THIRD-PARTY-LICENCES.md`];
  }
  if (policy.prohibited.entries.some((e) => e.spdx.includes(id))) {
    return ["prohibited", `${id} is prohibited`];
  }
  const rule = conditionalRule(policy, id);
  if (rule) {
    return rule.surfaces.includes(surface)
      ? ["conditional", `${id} permitted on ${surface} with conditions`]
      : ["surface", `${id} is not permitted on the ${surface} surface`];
  }
  return ["unknown", `${id} is not classified by licence-policy.json`];
}

const RANK: Record<Verdict, number> = {
  permitted: 0,
  attribution: 1,
  conditional: 2,
  excepted: 3,
  surface: 4,
  unknown: 5,
  prohibited: 6,
};

/**
 * Classify an SPDX expression. `A OR B` passes if either side passes (we choose); `A AND B`
 * takes the worst of both. `WITH` exceptions are classified by their base licence.
 */
export function classifyExpression(
  policy: Policy,
  expression: string,
  surface: Surface,
): [Verdict, string] {
  const expr = expression.trim().replace(/^\((.*)\)$/, "$1");
  const alternatives = expr.split(/\s+OR\s+/i);
  if (alternatives.length > 1) {
    const results = alternatives.map((a) => classifyExpression(policy, a, surface));
    return results.reduce((best, r) => (RANK[r[0]] < RANK[best[0]] ? r : best));
  }
  const conjuncts = expr.split(/\s+AND\s+/i);
  if (conjuncts.length > 1) {
    const results = conjuncts.map((c) => classifyExpression(policy, c, surface));
    return results.reduce((worst, r) => (RANK[r[0]] > RANK[worst[0]] ? r : worst));
  }
  const base = expr.split(/\s+WITH\s+/i)[0]?.trim() ?? "";
  return classifyId(policy, base, surface);
}

function isUnresolved(policy: Policy, license: string | null): boolean {
  if (license === null || license.trim() === "") return true;
  return policy.unresolved.values.some(
    (v) => v !== null && v !== "" && license.toUpperCase().startsWith(v.toUpperCase()),
  );
}

const REQUIRED_EXCEPTION_FIELDS = [
  "spdx",
  "package",
  "version",
  "surface",
  "reason",
  "compensatingControl",
  "approver",
  "approved",
  "reviewBy",
] as const;

/** Validate licence-exceptions.json entries. Returns human-readable errors. */
export function validateExceptions(policy: Policy, exceptions: unknown[], today: string): string[] {
  const errors: string[] = [];
  exceptions.forEach((raw, i) => {
    const e = raw as Partial<Record<string, unknown>>;
    for (const f of REQUIRED_EXCEPTION_FIELDS) {
      if (typeof e[f] !== "string" || (e[f] as string).trim() === "") {
        errors.push(`exception #${i}: missing field "${f}"`);
      }
    }
    if (typeof e.reviewBy === "string" && e.reviewBy < today) {
      errors.push(`exception #${i} (${String(e.package)}): reviewBy ${e.reviewBy} has passed`);
    }
    const locked = policy.prohibited.entries.find(
      (p) => !p.exceptionsAllowed && typeof e.spdx === "string" && p.spdx.includes(e.spdx),
    );
    if (locked) errors.push(`exception #${i}: ${String(e.spdx)} can never be excepted`);
  });
  return errors;
}

export function evaluate(
  policy: Policy,
  exceptions: Exception[],
  deps: Dependency[],
  clientPackages: ReadonlySet<string>,
): Result[] {
  return deps.map((dep) => {
    const surface: Surface = clientPackages.has(dep.name) ? "client" : "server";
    const exception = exceptions.find(
      (e) =>
        e.package === dep.name &&
        e.version === dep.version &&
        e.spdx === dep.license &&
        e.surface === surface,
    );
    if (exception && !policy.prohibited.entries.some((p) => p.spdx.includes(exception.spdx))) {
      return {
        dep,
        surface,
        verdict: "excepted",
        detail: `exception approved by ${exception.approver}`,
      };
    }
    if (isUnresolved(policy, dep.license)) {
      return {
        dep,
        surface,
        verdict: "unknown",
        detail: `unresolved licence "${dep.license ?? ""}"`,
      };
    }
    const [verdict, detail] = classifyExpression(policy, dep.license as string, surface);
    return { dep, surface, verdict, detail };
  });
}
