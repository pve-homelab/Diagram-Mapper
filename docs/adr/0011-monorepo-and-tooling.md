# ADR-0011: One pnpm monorepo with CI-enforced module boundaries

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (scaffolds it in AIS-8), Frontend Engineer and AI Engineer (both consume `packages/graph`) |
| **Affects** | `docs/TECH-SPEC.md` §2.3, §10, §11 |
| **Reversibility** | Moderate. Splitting a monorepo later is mostly mechanical; merging repositories back together after history has diverged is not. |

## Context

Six agents build this product, and three of them — Backend, Frontend, AI — all depend on
the **same** definition of the resource graph. `packages/graph` is the single source of
truth for the wire format (`TECH-SPEC` §2.3, ADR-0003): the Frontend renders what it
describes, the AI engine cites against it, the parser produces it, the database stores it.
If those three ever hold their own version of the resource list, the product's core claim —
the diagram matches the source — stops being checkable.

**Conway's Law** is the lens. The repository layout becomes the team's communication
structure, so the structure has to make one thing trivially easy (reusing the graph
contract) and one thing impossible (reaching across a boundary that the architecture says
is closed). The boundary table in `TECH-SPEC` §2.3 is the actual requirement:
`packages/graph` imports nothing but `zod`; `packages/parser` touches no network and no
database; `packages/ui` never imports `packages/db`; nothing in `packages/*` imports
pg-boss or Next.js.

A second requirement, which decides more than it looks like it does: **a single change must
be verifiable as one unit.** When `schemaVersion` moves, the parser, the graph types, the
database writer, the API contract, the golden fixtures and the canvas all change together.
That has to be one pull request with one CI run, or we get a window in which the pieces
disagree and no test can see it.

## Options considered

### Option A — One repository, pnpm workspaces, boundaries enforced in CI (chosen)

`apps/web`, `apps/worker` and seven packages in one repository, with TypeScript project
references, one lockfile, one CI pipeline, and a boundary test that fails the build on a
forbidden import.

**Cost:** £0 in money. Everybody's CI runs on everybody's change, so the pipeline must stay
fast enough not to be resented (the mitigation is scoping jobs by changed package, not
weakening gates). Nothing stops a casual cross-import *as you type* — only the CI gate
does, which is why the gate is non-negotiable rather than advisory.

### Option B — One repository, one package: a plain Next.js app with internal folders

The simplest thing. No workspace machinery, no project references, fastest possible
install.

**Cost:** £0, and it gives up the only structural property we actually need. With folders
instead of packages, "`packages/ui` must not import `packages/db`" degrades to a lint rule
about path prefixes, and `packages/graph`'s purity — no I/O, no Node built-ins — becomes
unverifiable, because a folder has no `package.json` whose dependency list can be asserted.
It also drags the parser's and the worker's dependencies into the web bundle's graph, which
is both a bundle-size problem and a security-surface problem: `@cdktf/hcl2json`'s WASM
payload has no business being reachable from client code.

Rejected. The boundaries are the architecture; a layout that cannot express them is the
wrong layout, however convenient.

### Option C — A repository per component (polyrepo)

`diagram-mapper-graph`, `-parser`, `-web`, and so on, with `packages/graph` published to a
private registry and consumed by version.

**Cost:** money (a private npm registry, or GitHub Packages) and, far worse, **latency on
every graph change**. A `schemaVersion` bump becomes: change graph, publish, bump in
parser, publish, bump in web, and three CI runs that each see a different slice of reality.
Cross-repository atomic change is impossible by construction, so the "one unit" requirement
fails. For six agents who all depend on one contract, this is the maximally wrong answer.

Rejected on cost of delay and on Conway's Law: it imposes a release-coordination ritual on
a team that fits in one pull request.

### Option D — Monorepo plus Nx or Turborepo

Option A plus a build orchestrator: task graphs, affected-project detection, local and
remote caching.

**Cost:** another tool, its config, and its failure modes — and the headline feature,
remote caching, is a **paid hosted service** on the usual path (Vercel's remote cache for
Turborepo), which needs an ADR and CEO approval under our rules. Self-hosting a cache
server is an additional component to operate for a CI pipeline that, at this size, is a few
minutes long.

Rejected **for now, with a named trigger**: when CI wall-clock on a trivial change exceeds
**10 minutes**, revisit Option D (local caching first, which is free). Adopting it is
additive — it sits on top of pnpm workspaces and changes no import path — which is exactly
why it can wait. **Boring technology**: the interesting option here is not yet measurably
better.

### Option E — npm or Yarn workspaces instead of pnpm

Functionally close. npm workspaces hoist by default, which makes *phantom dependencies*
possible: a package imports something it never declared, works locally because a sibling
hoisted it, and breaks when the sibling's dependency changes.

**Cost:** £0, and it undermines the boundary test — which reads each package's declared
dependencies. pnpm's strict, symlinked `node_modules` makes an undeclared import fail at
resolution time, so the boundary rule is enforced by the installer as well as by CI. Yarn
Berry's PnP is stricter still but adds a resolution model that tooling occasionally fights.

Rejected: pnpm's strictness is load-bearing for Option A, not a preference.

## Decision

**One repository, pnpm workspaces, Node 22 LTS, TypeScript project references, one CI
pipeline, boundaries enforced by a test.** Specifically:

1. **Layout is `TECH-SPEC` §10**, unchanged by this ADR. Two apps, seven packages.
2. **`packages/graph` is implemented first** and has exactly one dependency, `zod`. Every
   other package and both test suites depend on its types. A pull request that adds a
   dependency to `packages/graph` requires CTO review (ADR-0003).
3. **`pnpm test:boundaries` is a required CI job.** It reads each package's `package.json`
   dependencies and its resolved import graph, and asserts the `MUST NOT` column of
   `TECH-SPEC` §2.3. A violation fails the build. If a dependency-graph tool is used
   (`dependency-cruiser`, MIT) it is a dev dependency only and never ships.
4. **`--frozen-lockfile` in CI**, one committed `pnpm-lock.yaml`, and a single pinned Node
   and pnpm version via `engines` plus `packageManager`. "Works on my machine" is not a
   debugging mode we can afford with six agents.
5. **No independent versioning and no publishing.** Internal packages are
   `"version": "0.0.0"`, `"private": true`, referenced by `workspace:*`. The repository has
   one version: its commit. `schemaVersion` and `parserVersion` are values *inside*
   `packages/graph`, deliberately decoupled from any package version, because they describe
   data compatibility rather than code releases.
6. **Shared base configuration, one layer deep.** `tsconfig.base.json`, `biome.json`,
   `vitest.workspace.ts` at the root; each package extends and overrides. No config
   inheritance chains three deep.
7. **One pipeline, all gates required, never bypassed** (`TECH-SPEC` §11). Jobs may be
   scoped to changed packages for speed; the `fixtures`, `db`, `boundaries`, `licences` and
   `secrets` gates always run, because they are the ones that protect the graph, the tenancy
   model and the licence position.
8. **One owner per package** (`TECH-SPEC` §2.3). Ownership is advisory in Git and binding in
   review: changes to `packages/graph` or `fixtures/terraform` require CTO review.
9. **Revisit Option D when CI exceeds 10 minutes** on a trivial change — a measurement, not
   a feeling.

## Cost

- **Money:** £0. pnpm (MIT), TypeScript (Apache-2.0), Vitest (MIT), Playwright (Apache-2.0),
  Biome (MIT ∪ Apache-2.0), `dependency-cruiser` if used (MIT). All dev-only; none reaches
  the client bundle. The automated licence gate verifies this rather than taking my word
  (`TECH-SPEC` §11).
- **Engineering:** ~2 days in M1 for the scaffold, CI pipeline, boundary test and licence
  gate — the AIS-8 line item — most of it CI rather than workspace wiring.
- **Operational:** every change runs the shared pipeline, so pipeline time is a shared cost
  that must be watched. One repository also means one branch-protection and one review
  configuration, which is a simplification.
- **What this makes harder:** open-sourcing or selling a single component; giving an
  external contributor access to one part only; per-component release cadences. None of
  these is a launch requirement, and the first two are reachable by extracting a package
  later.

## Consequences

- A `schemaVersion` change is **one pull request** touching the parser, the graph types, the
  database writer, the fixtures and the canvas, verified by one CI run. The "pieces
  disagree" window does not exist. This is the main benefit and it is why the other options
  lose.
- The Frontend can build the entire canvas against `packages/graph`'s zod schemas and the
  golden fixtures **before any backend endpoint exists** (`TECH-SPEC` §14). That overlap is
  worth roughly two weeks of serialised work and it only exists because the contract is a
  shared package rather than an API artefact.
- The architecture's boundaries are machine-checked. An engineer who imports
  `packages/db` from `packages/ui` learns it from a red build in minutes, not from me in
  review. **Make the invariant checkable.**
- **Blast radius:** a broken `main` blocks all six agents at once. Mitigated by required
  checks on protected `main`, so a failure is caught on the pull request; the residual risk
  is a flaky gate, which is treated as a build break and fixed rather than retried.
- One place to look. For a six-agent team, "where does this live" having a single answer is
  worth more than any per-repository independence we are giving up.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| CI staying fast enough | Every trivial change waits on the whole pipeline; agents start wanting to skip gates | Add Turborepo/Nx local caching and scope jobs by package — **1–2 days**, additive, no import changes | Wall-clock on a one-line change crossing the 10-minute trigger |
| The boundary test covering real violations | A forbidden import slips through — e.g. parser code reachable from the client bundle | Hours to fix the import, plus hardening the test. Worst case, a WASM payload in the client bundle | Bundle-size analysis; a reviewer spotting it; the gap found while writing a new rule |
| Seven packages being the right granularity | Packages that always change together generate pull-request friction for no benefit | Merge two packages — hours | Repeated pull requests touching the same pair and nothing else |
| Not needing independent versioning | An external consumer or a second product wants `packages/graph` alone | Extract to its own repository and publish — days, because it already has no internal dependencies | A real external consumer appearing — none exists today |
| One repository suiting the team | Agents collide on the same files and serialise on review | Clearer ownership, or split — days | Merge-conflict rate; review queue depth |
| pnpm | Tooling incompatibility with some dependency | Switch to npm workspaces and lose strictness — a day, plus re-hardening the boundary test | Install or resolution failures that only pnpm exhibits |

Every row is hours or days, which is the point: this is a **cheap-to-reverse** decision and
it got exactly as much design effort as that deserves. The expensive decisions in this
product are the graph model (ADR-0003), the tenancy model (ADR-0004) and the retention
boundary (ADR-0007) — not the build layout.
