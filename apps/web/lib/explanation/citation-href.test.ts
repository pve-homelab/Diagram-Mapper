import type { Citation } from "@diagram-mapper/explain/contract";
import { describe, expect, it } from "vitest";
import { citationHref, citationLabel, isSafeRepoPath } from "./citation-href.ts";

const ok: Citation = {
  file: "modules/network/main.tf",
  startLine: 14,
  endLine: 18,
  commitSha: "3bfcc34a1d",
  snippetSha256: "0".repeat(64),
};

describe("citationHref", () => {
  it("builds an internal source-viewer link", () => {
    expect(citationHref(ok)).toBe("/source/3bfcc34a1d/modules/network/main.tf#L14-L18");
  });

  it("percent-encodes path segments", () => {
    expect(citationHref({ ...ok, file: "envs/prod #1/main.tf" })).toBe(
      "/source/3bfcc34a1d/envs/prod%20%231/main.tf#L14-L18",
    );
  });

  it.each([
    "https://exfil.invalid/x?d=aws_iam_role.admin",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//exfil.invalid/x",
    "/etc/passwd",
    "../../etc/passwd",
    "modules/../../../secret.tf",
    "a\\b.tf",
    "main.tf\u0000.png",
    "",
  ])("refuses a link for file %j", (file) => {
    expect(isSafeRepoPath(file)).toBe(false);
    expect(citationHref({ ...ok, file })).toBeNull();
  });

  it.each([
    ["a non-hex commit", { commitSha: "../../api" }],
    ["line zero", { startLine: 0 }],
    ["a fractional line", { endLine: 18.5 }],
    ["a reversed range", { startLine: 20, endLine: 3 }],
  ])("refuses %s", (_label, patch) => {
    expect(citationHref({ ...ok, ...patch } as Citation)).toBeNull();
  });
});

describe("citationLabel", () => {
  it("shows a single line or a range", () => {
    expect(citationLabel(ok)).toBe("modules/network/main.tf:14-18");
    expect(citationLabel({ ...ok, endLine: 14 })).toBe("modules/network/main.tf:14");
  });
});
