import { z } from "zod";

/**
 * The closed diagnostic-code enum (TECH-SPEC section 9.4). Shared by the worker, the API and
 * the client, so a new code cannot ship without client-side copy.
 */
export const HARD_FAILURE_CODES = [
  "NO_TERRAFORM_FOUND",
  "GITHUB_ACCESS_DENIED",
  "GITHUB_RATE_LIMITED",
  "REPO_TOO_LARGE",
  "TOO_MANY_FILES",
  "GRAPH_TOO_LARGE",
  "SCAN_TIMEOUT",
  "GRAPH_INVARIANT_VIOLATION",
  "PLAN_JSON_INVALID",
  "PLAN_JSON_MISMATCH",
  "INTERNAL_ERROR",
] as const;

export const SOFT_DIAGNOSTIC_CODES = [
  "FILE_PARSE_ERROR",
  "MODULE_SOURCE_UNSUPPORTED",
  "MODULE_PATH_NOT_FOUND",
  "LOCALS_CYCLE",
  "UNRESOLVED_REFERENCE",
  "FILE_TOO_LARGE",
  "BINARY_SKIPPED",
  "POSITION_INDEX_FALLBACK",
  "NODE_ATTRIBUTES_TRUNCATED",
  "SENSITIVE_VALUE_REDACTED",
] as const;

export const DiagnosticCode = z.enum([...HARD_FAILURE_CODES, ...SOFT_DIAGNOSTIC_CODES]);
export type DiagnosticCode = z.infer<typeof DiagnosticCode>;

export const Diagnostic = z
  .object({
    code: DiagnosticCode,
    severity: z.enum(["error", "warning", "info"]),
    message: z.string().min(1),
    path: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    hint: z.string().optional(),
    nodeAddress: z.string().optional(),
  })
  .strict();
export type Diagnostic = z.infer<typeof Diagnostic>;

export function isHardFailure(code: DiagnosticCode): boolean {
  return (HARD_FAILURE_CODES as readonly string[]).includes(code);
}
