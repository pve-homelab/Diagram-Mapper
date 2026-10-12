import { describe, expect, it } from "vitest";
import { check, classify, importsOf, type WorkspacePackage } from "./boundaries.ts";

const pkg = (dir: string, dependencies: string[], text: string): WorkspacePackage => ({
  dir,
  name: dir,
  dependencies,
  files: [{ path: `${dir}/src/index.ts`, text }],
});

describe("importsOf / classify", () => {
  it("finds static, side-effect, dynamic and require imports", () => {
    const text = `import { a } from "zod";\nimport "./x.ts";\nconst m = await import("pg");\nrequire("node:fs");\nexport * from "@diagram-mapper/graph/sub";`;
    expect(importsOf(text)).toEqual([
      "zod",
      "./x.ts",
      "pg",
      "node:fs",
      "@diagram-mapper/graph/sub",
    ]);
    expect(classify("@diagram-mapper/graph/sub")).toEqual({ pkg: "@diagram-mapper/graph" });
    expect(classify("node:fs/promises")).toEqual({ builtin: "fs" });
  });
});

describe("check", () => {
  it("passes a clean graph package", () => {
    expect(check([pkg("packages/graph", ["zod"], `import { z } from "zod";`)])).toEqual([]);
  });

  it("rejects I/O in packages/graph", () => {
    const v = check([pkg("packages/graph", ["zod"], `import { readFileSync } from "node:fs";`)]);
    expect(v.join("\n")).toContain('Node built-in "fs"');
  });

  it("rejects packages/ui importing packages/db", () => {
    const v = check([
      pkg("packages/ui", ["@diagram-mapper/db"], `import { x } from "@diagram-mapper/db";`),
    ]);
    expect(v.join("\n")).toContain("forbidden");
  });

  it("rejects pg outside packages/db and undeclared (phantom) imports", () => {
    const v = check([pkg("apps/worker", [], `import pg from "pg";`)]).join("\n");
    expect(v).toContain("only packages/db may import pg");
    expect(v).toContain("not declared");
  });

  it("rejects process.env outside packages/config", () => {
    const v = check([pkg("packages/db", [], "const u = process.env.DATABASE_URL;")]);
    expect(v.join("\n")).toContain("process.env outside packages/config");
  });

  it("rejects Next.js in any package", () => {
    const v = check([pkg("packages/explain", ["next"], `import { headers } from "next/headers";`)]);
    expect(v.join("\n")).toContain("pg-boss or Next.js");
  });
});
