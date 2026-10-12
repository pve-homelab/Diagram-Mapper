/**
 * Module-boundary rules from TECH-SPEC section 2.3, asserted over each workspace package's
 * declared dependencies and the import specifiers in its non-test source.
 */

export interface SourceFile {
  path: string;
  text: string;
}

export interface WorkspacePackage {
  dir: string;
  name: string;
  dependencies: string[];
  files: SourceFile[];
}

export interface Rule {
  /** Workspace directory the rule applies to, e.g. "packages/graph". "packages/*" matches all. */
  dir: string;
  /** If present, the only bare packages that may be imported. */
  allowOnly?: string[];
  /** Bare packages (or prefixes ending in "/") that must not be imported. */
  forbid?: string[];
  /** Node built-ins allowed; undefined means any. */
  builtins?: string[];
  reason: string;
}

const ALL_PACKAGES = "packages/*";

export const RULES: Rule[] = [
  {
    dir: "packages/graph",
    allowOnly: ["zod"],
    builtins: ["crypto"],
    reason: "graph is pure: zod only, no I/O, no Node built-in except crypto",
  },
  {
    dir: "packages/parser",
    allowOnly: ["@diagram-mapper/graph", "@cdktf/hcl2json"],
    builtins: ["path", "crypto"],
    reason: "parser touches no network and no database",
  },
  {
    dir: "packages/db",
    allowOnly: ["@diagram-mapper/graph", "drizzle-orm", "pg"],
    reason: "db holds no business logic, HTTP or AI",
  },
  {
    dir: "packages/config",
    allowOnly: ["zod"],
    builtins: [],
    reason: "config depends on zod and nothing else",
  },
  {
    dir: "packages/ui",
    forbid: ["@diagram-mapper/db", "@diagram-mapper/parser", "pg", "drizzle-orm"],
    reason: "ui never reaches the database or the parser",
  },
  {
    dir: "packages/explain",
    forbid: ["pg", "drizzle-orm"],
    reason: "explain reads through packages/db read models only",
  },
  {
    dir: ALL_PACKAGES,
    forbid: ["pg-boss", "next", "next/"],
    reason: "nothing in packages/* imports pg-boss or Next.js",
  },
  {
    dir: "apps/worker",
    forbid: ["next", "next/", "express", "fastify", "hono"],
    reason: "the worker does not serve HTTP",
  },
];

/** Only packages/db may import the database driver or ORM (TECH-SPEC section 6.4). */
const DB_ONLY = ["pg", "drizzle-orm"];

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

export function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

/** "node:fs/promises" -> builtin "fs"; "@a/b/c" -> "@a/b"; "./x" -> undefined. */
export function classify(spec: string): { builtin?: string; pkg?: string } {
  if (spec.startsWith(".") || spec.startsWith("/")) return {};
  if (spec.startsWith("node:")) return { builtin: spec.slice(5).split("/")[0] ?? "" };
  const parts = spec.split("/");
  const pkg = spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? spec);
  return { pkg };
}

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

function matches(spec: string, pkg: string, entries: string[]): boolean {
  return entries.some((e) => (e.endsWith("/") ? spec.startsWith(e) : pkg === e));
}

export function check(pkgs: WorkspacePackage[], rules: Rule[] = RULES): string[] {
  const violations: string[] = [];
  for (const p of pkgs) {
    const applicable = rules.filter(
      (r) => r.dir === p.dir || (r.dir === ALL_PACKAGES && p.dir.startsWith("packages/")),
    );
    for (const dep of p.dependencies) {
      for (const r of applicable) {
        if (r.allowOnly && !r.allowOnly.includes(dep)) {
          violations.push(`${p.dir}/package.json: dependency "${dep}" not allowed (${r.reason})`);
        }
      }
    }
    for (const f of p.files) {
      if (p.dir !== "packages/config" && /\bprocess\.env\b/.test(f.text)) {
        violations.push(`${f.path}: process.env outside packages/config (TECH-SPEC 9.2)`);
      }
      for (const spec of importsOf(f.text)) {
        const { builtin, pkg } = classify(spec);
        const where = `${f.path}: import "${spec}"`;
        if (builtin !== undefined || (pkg && NODE_BUILTINS.has(pkg))) {
          const name = builtin ?? (pkg as string);
          for (const r of applicable) {
            if (r.builtins && !r.builtins.includes(name)) {
              violations.push(`${where} uses Node built-in "${name}" (${r.reason})`);
            }
          }
          continue;
        }
        if (!pkg) continue;
        if (!p.dependencies.includes(pkg)) {
          violations.push(`${where} is not declared in ${p.dir}/package.json dependencies`);
        }
        if (DB_ONLY.includes(pkg) && p.dir !== "packages/db") {
          violations.push(`${where}: only packages/db may import ${pkg} (TECH-SPEC 6.4)`);
        }
        for (const r of applicable) {
          if (r.allowOnly && !r.allowOnly.includes(pkg)) {
            violations.push(`${where} not allowed (${r.reason})`);
          }
          if (r.forbid && matches(spec, pkg, r.forbid)) {
            violations.push(`${where} is forbidden (${r.reason})`);
          }
        }
      }
    }
  }
  return [...new Set(violations)];
}
