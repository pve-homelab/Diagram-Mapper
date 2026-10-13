/**
 * The single definition of "secret" in the system (TECH-SPEC §8.5).
 *
 * Used at two boundaries: persistence (what the graph may store) and egress
 * (what may be sent to the AI provider). One module so the two cannot drift.
 *
 * False positives cost a displayed value. False negatives cost a leaked
 * credential. The asymmetry is deliberate — when in doubt, redact.
 */

export const REDACTED = "«redacted»";

/** Attribute keys whose value is never sent, whatever it looks like. */
export const SECRET_KEY_PATTERN =
  /(password|secret|token|private_key|credential|passwd|api[_-]?key)/i;

/** High-signal value patterns. Each has a positive and a negative unit test. */
export const SECRET_VALUE_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "pem_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { code: "slack_token", re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/ },
  { code: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { code: "stripe_key", re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
];

/** Paths that are never parsed at all, so never citable and never sent. */
export const NEVER_PARSED_PATH =
  /(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx|jks)$)/i;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY_TOKEN = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

/**
 * True when this looks like a credential. `key` is the attribute path, which
 * carries most of the signal — `password = var.db_password` is a secret key
 * even though the value is an innocuous expression.
 */
export function isSecret(key: string, value: unknown): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  if (typeof value !== "string") return false;
  for (const { re } of SECRET_VALUE_PATTERNS) if (re.test(value)) return true;
  for (const m of value.matchAll(HIGH_ENTROPY_TOKEN)) {
    if (entropy(m[0]) >= 4.0) return true;
  }
  return false;
}

/**
 * Redact credential-shaped runs inside a free-text span (a source snippet).
 * Line count is preserved so citation line numbers stay valid.
 */
export function redactSpan(text: string): { text: string; hits: string[] } {
  const hits: string[] = [];
  let out = text;
  for (const { code, re } of SECRET_VALUE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (g.test(out)) {
      hits.push(code);
      out = out.replace(g, REDACTED);
    }
  }
  out = out.replace(HIGH_ENTROPY_TOKEN, (m) => {
    if (entropy(m) >= 4.0) {
      hits.push("high_entropy");
      return REDACTED;
    }
    return m;
  });
  // Any line assigning to a secret-shaped key loses its right-hand side.
  out = out
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)([A-Za-z0-9_.\-\[\]"]+)(\s*=\s*)(.+)$/);
      if (m && SECRET_KEY_PATTERN.test(m[2]!)) {
        hits.push("secret_key_assignment");
        return `${m[1]}${m[2]}${m[3]}${REDACTED}`;
      }
      return line;
    })
    .join("\n");
  return { text: out, hits: [...new Set(hits)] };
}
