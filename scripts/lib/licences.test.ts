import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyExpression, evaluate, type Policy, validateExceptions } from "./licences.ts";

const policy = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../licence-policy.json"), "utf8"),
) as Policy;

const dep = (name: string, license: string | null) => ({ name, version: "1.0.0", license });

describe("classifyExpression against the committed policy", () => {
  it.each([
    ["MIT", "server", "permitted"],
    ["(MIT OR GPL-3.0-only)", "client", "permitted"],
    ["MIT AND GPL-3.0-only", "server", "prohibited"],
    ["AGPL-3.0-only", "server", "prohibited"],
    ["BUSL-1.1", "server", "prohibited"],
    ["LGPL-3.0-or-later", "server", "conditional"],
    ["LGPL-3.0-or-later", "client", "surface"],
    ["MPL-2.0", "client", "conditional"],
    ["CC-BY-4.0", "server", "attribution"],
    ["Made-Up-1.0", "server", "unknown"],
    ["WTFPL", "server", "surface"],
  ] as const)("%s on %s is %s", (expr, surface, verdict) => {
    expect(classifyExpression(policy, expr, surface)[0]).toBe(verdict);
  });
});

describe("evaluate", () => {
  it("treats missing and UNLICENSED as unknown, never permissive", () => {
    const r = evaluate(policy, [], [dep("a", null), dep("b", "UNLICENSED")], new Set());
    expect(r.map((x) => x.verdict)).toEqual(["unknown", "unknown"]);
  });

  it("uses the bundler client list for the surface", () => {
    const r = evaluate(policy, [], [dep("libvips", "LGPL-3.0-only")], new Set(["libvips"]));
    expect(r[0]?.surface).toBe("client");
    expect(r[0]?.verdict).toBe("surface");
  });

  it("honours a complete exception but never for a locked licence", () => {
    const base = {
      package: "x",
      version: "1.0.0",
      surface: "server",
      reason: "r",
      compensatingControl: "c",
      approver: "QA & Security Engineer",
      approved: "2026-10-01",
      reviewBy: "2027-01-01",
    };
    const ok = evaluate(policy, [{ ...base, spdx: "WTFPL" }], [dep("x", "WTFPL")], new Set());
    expect(ok[0]?.verdict).toBe("excepted");
    const gpl = evaluate(
      policy,
      [{ ...base, spdx: "GPL-3.0-only" }],
      [dep("x", "GPL-3.0-only")],
      new Set(),
    );
    expect(gpl[0]?.verdict).toBe("prohibited");
  });
});

describe("validateExceptions", () => {
  it("fails on missing fields, expiry and locked licences", () => {
    const errors = validateExceptions(
      policy,
      [{ spdx: "AGPL-3.0-only", package: "x", reviewBy: "2026-01-01" }],
      "2026-10-13",
    );
    expect(errors.some((e) => e.includes('missing field "approver"'))).toBe(true);
    expect(errors.some((e) => e.includes("has passed"))).toBe(true);
    expect(errors.some((e) => e.includes("can never be excepted"))).toBe(true);
  });
});
