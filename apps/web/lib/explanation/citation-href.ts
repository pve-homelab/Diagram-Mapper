import type { Citation } from "@diagram-mapper/explain/contract";

/**
 * Turns a citation into an internal link to our own source viewer (threat model F-06).
 *
 * Model output never supplies a URL. We build the href ourselves from the citation's parts,
 * and refuse anything that is not shaped like a repository-relative file and line range, so
 * a citation cannot become an external link, a `javascript:` URL, or a path traversal into
 * another route. The server's grounding gate already guarantees well-formed citations; this
 * is the second lock, for the day it does not.
 */

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
const MAX_PATH = 1024;

export const SOURCE_VIEWER_PREFIX = "/source/";

export function isSafeRepoPath(file: string): boolean {
  if (file.length === 0 || file.length > MAX_PATH) return false;
  if (file.startsWith("/") || file.includes("\\")) return false;
  // Any "scheme:" prefix ("https:", "javascript:", "data:") is rejected outright.
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return false;
  return file.split("/").every(isSafeSegment);
}

/** A path segment: non-empty, no slash or backslash, no C0 control characters or DEL. */
function isSafeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return false;
  for (let i = 0; i < seg.length; i++) {
    const code = seg.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || seg[i] === "/" || seg[i] === "\\") return false;
  }
  return true;
}

function isLine(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

/** The visible label: `main.tf:14` or `main.tf:14-18`. Rendered as text, never as markup. */
export function citationLabel(c: Pick<Citation, "file" | "startLine" | "endLine">): string {
  return c.endLine > c.startLine
    ? `${c.file}:${c.startLine}-${c.endLine}`
    : `${c.file}:${c.startLine}`;
}

/**
 * `/source/<commit>/<path…>#L<start>-L<end>`, or `null` if any part is not trustworthy.
 * A `null` citation renders as inert text with no link.
 */
export function citationHref(c: Citation): string | null {
  if (!COMMIT_SHA.test(c.commitSha)) return null;
  if (!isSafeRepoPath(c.file)) return null;
  if (!isLine(c.startLine) || !isLine(c.endLine) || c.endLine < c.startLine) return null;

  const path = c.file.split("/").map(encodeURIComponent).join("/");
  const href = `${SOURCE_VIEWER_PREFIX}${c.commitSha}/${path}#L${c.startLine}-L${c.endLine}`;

  // Belt and braces: whatever we built must resolve to our own origin and the viewer route.
  const resolved = new URL(href, "https://self.invalid");
  if (resolved.origin !== "https://self.invalid") return null;
  if (!resolved.pathname.startsWith(SOURCE_VIEWER_PREFIX)) return null;
  return href;
}
