/**
 * Cookie attributes for every cookie this app sets (threat model F-14, TECH-SPEC 9.1).
 * Spread these into `cookies().set(...)` or Auth.js `cookies` options; do not hand-write
 * attributes per cookie.
 *
 * `secure` is false only under `next dev` on http://localhost, where a Secure cookie would
 * not be stored at all. Production builds always set it.
 */
export function sessionCookieAttributes(dev: boolean) {
  return {
    httpOnly: true,
    secure: !dev,
    sameSite: "lax",
    path: "/",
  } as const;
}
