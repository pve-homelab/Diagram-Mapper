import { isDevelopment } from "@diagram-mapper/config";
import { type NextRequest, NextResponse } from "next/server";
import {
  contentSecurityPolicy,
  generateNonce,
  STATIC_SECURITY_HEADERS,
} from "./lib/security/headers.ts";
import { guardRequest } from "./lib/security/request-guard.ts";

/**
 * Per-request CSP nonce, security headers, and the cross-origin request guard (F-14).
 *
 * Next.js reads the nonce from the *request* `Content-Security-Policy` header and stamps it
 * on its own scripts, which only works for dynamically rendered pages; the root layout opts
 * into that. The same policy is set on the response, which is what the browser enforces.
 */
export function middleware(request: NextRequest): NextResponse {
  const dev = isDevelopment();

  const verdict = guardRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    ownOrigin: request.nextUrl.origin,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    isPreflight:
      request.method === "OPTIONS" && request.headers.has("access-control-request-method"),
  });

  const nonce = generateNonce();
  const csp = contentSecurityPolicy({ nonce, dev });

  let response: NextResponse;
  if (verdict.allow) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    response = NextResponse.json(
      {
        error: {
          code: verdict.code,
          message: "This request must come from the Diagram Mapper app itself.",
          details: {},
          retryable: false,
        },
      },
      { status: verdict.status },
    );
  }

  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Every path, including static assets, so nosniff and friends are never missing.
  matcher: "/:path*",
};
