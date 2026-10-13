import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Threat model F-06: no raw-HTML sink anywhere in shipped code. Biome's
 * `noDangerouslySetInnerHtml` covers the JSX prop; this also covers the DOM APIs and the
 * markdown-renderer escape hatches Biome does not know about. The licence/CI plan names a
 * semgrep rule for this; until that job exists, this test is the gate.
 */
const ROOT = join(import.meta.dirname, "../../..");
const SCAN = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "test-results"]);
const EXTENSIONS = /\.(c|m)?[jt]sx?$/;
const SELF = relative(ROOT, import.meta.filename);

const SINKS: [string, RegExp][] = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML/outerHTML assignment", /\.(inner|outer)HTML\s*[+]?=/],
  ["insertAdjacentHTML", /insertAdjacentHTML\s*\(/],
  ["document.write", /document\.write(ln)?\s*\(/],
  ["createContextualFragment", /createContextualFragment\s*\(/],
  ["markdown raw-HTML opt-in", /allowDangerousHtml|rehype-raw|skipHtml\s*:\s*false/],
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name));
    } else if (EXTENSIONS.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

describe("no raw-HTML sinks (F-06)", () => {
  it("finds none in apps/ or packages/", () => {
    const hits: string[] = [];
    for (const top of SCAN) {
      for (const file of sourceFiles(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (rel === SELF) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          for (const [name, re] of SINKS) if (re.test(line)) hits.push(`${rel}:${i + 1} ${name}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
