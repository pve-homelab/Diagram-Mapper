/**
 * Cross-origin request policy (threat model F-14): CSRF and CORS.
 *
 * At launch `/api/v1` is same-origin only. We never emit `Access-Control-Allow-Origin`, so a
 * browser on another origin cannot read any response, and we refuse any state-changing
 * request the browser marks as cross-site. This sits in front of, not instead of, Auth.js
 * CSRF tokens on mutations (TECH-SPEC section 7.1): an origin check costs nothing and still
 * holds for routes that forget the token.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Server-to-server endpoints that authenticate by signature, not by cookie (TECH-SPEC 7.7).
 * Providers send no `Origin`, so the origin check does not apply; signature verification in
 * the handler is the control. Keep this list exact: a prefix here is a CSRF hole.
 */
export const SIGNED_WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  "/api/webhooks/stripe",
  "/api/webhooks/github",
]);

export type GuardVerdict =
  | { allow: true }
  | { allow: false; status: 403; code: "CROSS_ORIGIN_REQUEST" | "CORS_NOT_ALLOWED" };

export interface GuardRequest {
  method: string;
  pathname: string;
  /** Our own origin as seen by this request, e.g. "https://app.example.com". */
  ownOrigin: string;
  /** The `Origin` request header, if any. */
  origin: string | null;
  /** The `Sec-Fetch-Site` request header, if any. */
  secFetchSite: string | null;
  /** True if the request is a CORS preflight (`OPTIONS` with `Access-Control-Request-Method`). */
  isPreflight: boolean;
}

export function guardRequest(req: GuardRequest): GuardVerdict {
  // A preflight only happens when another origin wants a non-simple request. We do not allow
  // any, so refuse it outright rather than let a handler answer it.
  if (req.isPreflight) return { allow: false, status: 403, code: "CORS_NOT_ALLOWED" };

  if (SAFE_METHODS.has(req.method.toUpperCase())) return { allow: true };
  if (SIGNED_WEBHOOK_PATHS.has(req.pathname)) return { allow: true };

  // Browsers send Origin on every non-GET fetch and form post. If it is present it must be
  // exactly ours: never a suffix match, never "null".
  if (req.origin !== null) {
    return req.origin === req.ownOrigin
      ? { allow: true }
      : { allow: false, status: 403, code: "CROSS_ORIGIN_REQUEST" };
  }
  // No Origin: fall back to Fetch Metadata. A browser always sends it; "same-origin" is the
  // only acceptable value. Non-browser clients (curl, scripts) send neither header and carry
  // no ambient cookies, so CSRF does not apply to them; they are allowed through to normal
  // authentication.
  if (req.secFetchSite !== null && req.secFetchSite !== "same-origin") {
    return { allow: false, status: 403, code: "CROSS_ORIGIN_REQUEST" };
  }
  return { allow: true };
}
