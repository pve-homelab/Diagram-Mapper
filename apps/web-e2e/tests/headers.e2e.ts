import { expect, test } from "@playwright/test";
import { nonceOf, parseCsp, watch } from "./support.ts";

/**
 * Threat model F-14. Every assertion here runs against the deployed preview as well as the
 * local build (`@deployed`), because the failure mode is a header present in code and lost
 * from the real response. The expected values mirror apps/web/lib/security/headers.ts.
 */

const ONE_YEAR = 31_536_000;

test.describe("security headers", { tag: "@deployed" }, () => {
  test("HTML has a nonce CSP with no unsafe-inline and a locked-down fetch surface", async ({
    request,
  }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    const header = res.headers()["content-security-policy"];
    expect(header, "Content-Security-Policy missing").toBeTruthy();
    const csp = parseCsp(header as string);

    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(nonceOf(csp), "script-src needs exactly one nonce").not.toBeNull();
    for (const directive of ["script-src", "style-src", "default-src"]) {
      expect(csp.get(directive) ?? [], directive).not.toContain("'unsafe-inline'");
      expect(csp.get(directive) ?? [], directive).not.toContain("'unsafe-eval'");
      expect(csp.get(directive) ?? [], directive).not.toContain("*");
    }
    // img-src is what closes the pixel-exfiltration route (F-06 backstop).
    expect(csp.get("img-src")).toEqual(["'self'", "data:"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
  });

  test("the nonce is fresh per request and stamped on every script", async ({ request }) => {
    const [a, b] = await Promise.all([request.get("/"), request.get("/")]);
    const nonceA = nonceOf(parseCsp(a.headers()["content-security-policy"] ?? ""));
    const nonceB = nonceOf(parseCsp(b.headers()["content-security-policy"] ?? ""));
    expect(nonceA).not.toBeNull();
    expect(nonceA).not.toBe(nonceB);
    expect((nonceA as string).length).toBeGreaterThanOrEqual(22); // >= 128 bits, base64

    const html = await a.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonceA}"`);
  });

  for (const path of ["/", "/api/v1/health", "/does-not-exist"]) {
    test(`hardening headers on ${path}`, async ({ request }) => {
      const res = await request.get(path);
      const h = res.headers();
      const hsts = /max-age=(\d+)/.exec(h["strict-transport-security"] ?? "");
      expect(Number(hsts?.[1] ?? 0), "HSTS max-age").toBeGreaterThanOrEqual(ONE_YEAR);
      expect(h["strict-transport-security"]).toContain("includeSubDomains");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
        expect(h["permissions-policy"]).toContain(feature);
      }
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["cross-origin-opener-policy"]).toBe("same-origin");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["x-powered-by"]).toBeUndefined();
      expect(h["access-control-allow-origin"]).toBeUndefined();
    });
  }

  test("static assets carry nosniff", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const asset = /src="(\/_next\/static\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset, "no static chunk referenced from /").toBeTruthy();
    const res = await request.get(asset as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("CORS never reflects a foreign origin", async ({ request }) => {
    const res = await request.get("/api/v1/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers()["access-control-allow-credentials"]).toBeUndefined();
  });

  test("CORS preflights are refused", async ({ request }) => {
    const res = await request.fetch("/api/v1/health", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status()).toBe(403);
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("cross-site state-changing requests are refused (CSRF)", async ({ request }) => {
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const res = await request.post("/api/v1/health", { headers, data: {} });
      expect(res.status(), JSON.stringify(headers)).toBe(403);
      expect((await res.json()).error.code).toBe("CROSS_ORIGIN_REQUEST");
    }
  });

  test("any cookie set on page load is HttpOnly, SameSite and (over https) Secure", async ({
    page,
    baseURL,
  }) => {
    const res = await page.goto("/");
    const cookies = (await res?.headersArray())?.filter(
      (h) => h.name.toLowerCase() === "set-cookie",
    );
    for (const { value } of cookies ?? []) {
      expect(value).toMatch(/;\s*HttpOnly/i);
      expect(value).toMatch(/;\s*SameSite=(Lax|Strict)/i);
      if (baseURL?.startsWith("https:")) expect(value).toMatch(/;\s*Secure/i);
    }
  });

  test("the home page loads with no CSP violation and no console error", async ({
    page,
    baseURL,
  }) => {
    const w = await watch(page, new URL(baseURL as string).origin);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Diagram Mapper" })).toBeVisible();
    // Hydration is what would trip a missing nonce; wait for the app's scripts to settle.
    await page.waitForLoadState("networkidle");
    expect(await w.violations()).toEqual([]);
    expect(w.consoleErrors).toEqual([]);
    expect(w.foreign).toEqual([]);
  });

  test("test fixtures are not served outside the e2e harness", async ({ request }) => {
    test.skip(!process.env.E2E_BASE_URL, "the local harness enables fixtures on purpose");
    expect((await request.get("/e2e/explanation")).status()).toBe(404);
  });
});
