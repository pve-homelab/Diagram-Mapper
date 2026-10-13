import type { Page, Request } from "@playwright/test";

/** `Content-Security-Policy` as directive name -> source list. */
export function parseCsp(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** The single nonce in a policy's script-src, or null. */
export function nonceOf(csp: Map<string, string[]>): string | null {
  const nonces = (csp.get("script-src") ?? [])
    .map((v) => /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(v)?.[1])
    .filter((v): v is string => v !== undefined);
  return nonces.length === 1 ? (nonces[0] as string) : null;
}

export interface Watch {
  /** Requests whose origin is not the app's own. */
  foreign: string[];
  /** Console errors, including every CSP violation the browser reports. */
  consoleErrors: string[];
  /** `securitypolicyviolation` events, as "directive blocked-uri". */
  violations(): Promise<string[]>;
}

/**
 * Records, for one page: every request to another origin (and aborts it, so a leak in a test
 * never reaches the network), every console error, and every CSP violation event. The
 * violation listener is installed through the DevTools protocol, which CSP does not govern.
 */
export async function watch(page: Page, ownOrigin: string): Promise<Watch> {
  const foreign: string[] = [];
  const consoleErrors: string[] = [];

  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (isOwn(route.request(), ownOrigin)) return route.continue();
    foreign.push(url);
    return route.abort("blockedbyclient");
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });

  return {
    foreign,
    consoleErrors,
    violations: () =>
      page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  };
}

function isOwn(request: Request, ownOrigin: string): boolean {
  const url = new URL(request.url());
  // data: URLs carry no origin and make no network request.
  return url.protocol === "data:" || url.origin === ownOrigin;
}
