import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/** Package name from a resolved module path, or undefined for our own source. */
function packageName(resource: string): string | undefined {
  const idx = resource.lastIndexOf("/node_modules/");
  if (idx < 0) return undefined;
  const parts = resource.slice(idx + "/node_modules/".length).split("/");
  const [first, second] = parts;
  if (!first) return undefined;
  return first.startsWith("@") && second ? `${first}/${second}` : first;
}

/** The slice of webpack's Compiler this plugin touches; webpack is not a direct dependency. */
interface Compiler {
  hooks: {
    done: {
      tap(name: string, fn: (stats: { compilation: { modules: Iterable<unknown> } }) => void): void;
    };
  };
}

interface ModuleLike {
  resource?: string;
  modules?: Iterable<ModuleLike>;
}

/**
 * Records every npm package that the bundler puts into browser JavaScript. The licence gate
 * (scripts/check-licences.ts) reads this list to decide which dependencies are distributed
 * to visitors: classification comes from the bundler, not from package.json position.
 */
class ClientPackagesPlugin {
  constructor(private readonly outFile: string) {}

  apply(compiler: Compiler): void {
    compiler.hooks.done.tap("ClientPackagesPlugin", (stats) => {
      const names = new Set<string>();
      const visit = (m: ModuleLike) => {
        const name = m.resource ? packageName(m.resource) : undefined;
        if (name) names.add(name);
        for (const inner of m.modules ?? []) visit(inner);
      };
      for (const m of stats.compilation.modules) visit(m as ModuleLike);
      mkdirSync(join(this.outFile, ".."), { recursive: true });
      writeFileSync(this.outFile, `${JSON.stringify([...names].sort(), null, 2)}\n`);
    });
  }
}

const config: NextConfig = {
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@diagram-mapper/config", "@diagram-mapper/explain", "@diagram-mapper/graph"],
  poweredByHeader: false,
  webpack(webpackConfig: { context: string; plugins: unknown[] }, { isServer, dev }) {
    if (!isServer && !dev) {
      webpackConfig.plugins.push(
        new ClientPackagesPlugin(
          join(webpackConfig.context, ".next/diagram-mapper-client-packages.json"),
        ),
      );
    }
    return webpackConfig;
  },
};

export default config;
