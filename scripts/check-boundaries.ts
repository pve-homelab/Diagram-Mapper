/** Boundary gate: node scripts/check-boundaries.ts. Rules live in scripts/lib/boundaries.ts. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { check, type SourceFile, type WorkspacePackage } from "./lib/boundaries.ts";

const root = join(import.meta.dirname, "..");
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "migrations"]);
const isTest = (f: string) => /\.(test|spec)\.[mc]?[jt]sx?$/.test(f);

function walk(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (SOURCE.test(entry) && !isTest(entry) && !entry.endsWith(".d.ts")) {
      out.push({ path: relative(root, full), text: readFileSync(full, "utf8") });
    }
  }
}

const pkgs: WorkspacePackage[] = [];
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, group))) {
    const dir = join(root, group, name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    const files: SourceFile[] = [];
    // Runtime source only. Tooling (scripts/, config files) may use dev dependencies.
    for (const src of ["src", "app", "lib"]) {
      if (existsSync(join(dir, src))) walk(join(dir, src), files);
    }
    pkgs.push({
      dir: `${group}/${name}`,
      name: json.name,
      dependencies: Object.keys(json.dependencies ?? {}),
      files,
    });
  }
}

const violations = check(pkgs);
for (const v of violations) console.error(v);
console.log(
  `boundaries: ${pkgs.length} workspace packages, ${pkgs.reduce((n, p) => n + p.files.length, 0)} source files, ${violations.length} violations`,
);
if (violations.length > 0) process.exit(1);
