import { describe, expect, it } from "vitest";
import { sessionCookieAttributes } from "./cookies.ts";
import { contentSecurityPolicy, generateNonce, STATIC_SECURITY_HEADERS } from "./headers.ts";
import { type GuardRequest, guardRequest } from "./request-guard.ts";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((d) => {
      const [name = "", ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("contentSecurityPolicy", () => {
  const prod = directives(contentSecurityPolicy({ nonce: "abc123", dev: false }));

  it("nonce-based script-src with no unsafe-inline or unsafe-eval in production", () => {
    expect(prod.get("script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    const all = [...prod.values()].flat();
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
  });

  it("closes the F-06 exfiltration routes: images, connections, frames, forms, base", () => {
    expect(prod.get("default-src")).toEqual(["'self'"]);
    expect(prod.get("img-src")).toEqual(["'self'", "data:"]);
    expect(prod.get("connect-src")).toEqual(["'self'"]);
    expect(prod.get("object-src")).toEqual(["'none'"]);
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
    expect(prod.get("base-uri")).toEqual(["'none'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
  });

  it("allows eval only under next dev", () => {
    const dev = directives(contentSecurityPolicy({ nonce: "n", dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
  });
});

describe("generateNonce", () => {
  it("is 128 bits of base64 and differs per call", () => {
    const a = generateNonce();
    expect(atob(a)).toHaveLength(16);
    expect(generateNonce()).not.toBe(a);
  });
});

describe("STATIC_SECURITY_HEADERS", () => {
  it("has a long HSTS max-age with includeSubDomains", () => {
    const hsts = STATIC_SECURITY_HEADERS["Strict-Transport-Security"] ?? "";
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("denies the powerful features the threat model names", () => {
    const pp = STATIC_SECURITY_HEADERS["Permissions-Policy"] ?? "";
    for (const f of ["camera", "microphone", "geolocation", "payment"]) {
      expect(pp).toContain(`${f}=()`);
    }
  });
});

describe("guardRequest", () => {
  const base: GuardRequest = {
    method: "POST",
    pathname: "/api/v1/scans",
    ownOrigin: "https://app.example.com",
    origin: "https://app.example.com",
    secFetchSite: "same-origin",
    isPreflight: false,
  };

  it("allows a same-origin mutation", () => {
    expect(guardRequest(base).allow).toBe(true);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["a suffix lookalike", "https://app.example.com.evil.example"],
    ["the opaque null origin", "null"],
    ["a scheme downgrade", "http://app.example.com"],
  ])("refuses a mutation from %s", (_label, origin) => {
    expect(guardRequest({ ...base, origin })).toMatchObject({ allow: false, status: 403 });
  });

  it("refuses a cross-site mutation that carries no Origin", () => {
    const v = guardRequest({ ...base, origin: null, secFetchSite: "cross-site" });
    expect(v.allow).toBe(false);
  });

  it("refuses every CORS preflight", () => {
    const v = guardRequest({ ...base, method: "OPTIONS", isPreflight: true });
    expect(v).toMatchObject({ allow: false, code: "CORS_NOT_ALLOWED" });
  });

  it("lets safe methods and signed webhooks through", () => {
    expect(guardRequest({ ...base, method: "GET", origin: "https://evil.example" }).allow).toBe(
      true,
    );
    expect(
      guardRequest({ ...base, pathname: "/api/webhooks/stripe", origin: null, secFetchSite: null })
        .allow,
    ).toBe(true);
    // Exact match only: a sibling path is not exempt.
    expect(
      guardRequest({
        ...base,
        pathname: "/api/webhooks/stripe/../../v1/scans",
        origin: "https://evil.example",
      }).allow,
    ).toBe(false);
  });
});

describe("sessionCookieAttributes", () => {
  it("is Secure, HttpOnly and SameSite=Lax in production", () => {
    expect(sessionCookieAttributes(false)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
