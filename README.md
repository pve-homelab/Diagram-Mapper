# Diagram Mapper

Diagram Mapper turns an Infrastructure-as-Code repository into an interactive, explainable
diagram. You connect a Terraform repository through a read-only GitHub App; we parse it,
build an accurate resource graph, render it as a canvas, and answer questions about any
resource with explanations grounded in the real source files and line numbers.

It is built to be sold as a subscription SaaS. Launch scope is **Terraform / HCL only**, plus
`terraform plan` JSON when you can supply it.

| Read this | For |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | What we are building and for whom |
| [`docs/TECH-SPEC.md`](docs/TECH-SPEC.md) | Architecture, graph schema, API, CI |
| [`docs/adr/`](docs/adr/) | Every architecture decision and why |
| [`docs/LICENCE-AND-DEPENDENCY-PLAN.md`](docs/LICENCE-AND-DEPENDENCY-PLAN.md) | Dependency licence policy and the CI gates |
| [`docs/TEST-STRATEGY.md`](docs/TEST-STRATEGY.md), [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | How we prove it works and is safe |
| `PROMPT.md`, `First_Team_outcome.md`, `commercial launch ready product.md`, `pricinples and contraints.md` | The original requirements source. Do not delete or rename |

## Repository layout

```
apps/web          Next.js 15 App Router: UI and /api/v1 route handlers
apps/worker       queue worker (scan.ingest, retention.sweep) — M1
packages/graph    the resource-graph wire format: schema, diagnostics, invariants (zod only)
packages/parser   Terraform files -> ParseResult. No network, no database
packages/db       Drizzle schema, SQL migrations, withTenant() (M1)
packages/config   the environment schema; the only code that reads process.env
scripts/          CI gates: module boundaries, licences
fixtures/         golden Terraform corpus with hand-verified expected graphs (M1)
spike/            throwaway spikes; not part of the workspace, not linted
```

`packages/explain` (AI Engineer) and `packages/ui` (Frontend Engineer) are added by their
owners. Boundary rules for them already exist in `scripts/lib/boundaries.ts`.

## Setup from a clean machine

You need: `git`, **Node 22** (we use [nvm](https://github.com/nvm-sh/nvm)), **Docker** (for
PostgreSQL 16), and **Go** (to install `gitleaks`; or download a gitleaks release binary). No
cloud account and no API key is needed to build and test.

```sh
git clone https://github.com/pve-homelab/Diagram-Mapper.git
cd Diagram-Mapper

nvm install                 # reads .nvmrc (Node 22)
corepack enable pnpm        # pnpm version comes from package.json "packageManager"
pnpm install --frozen-lockfile

# Secret-scanning pre-commit hook (gitleaks). The hook refuses to commit without it.
go install github.com/zricethezav/gitleaks/v8@v8.30.1   # puts gitleaks in $(go env GOPATH)/bin; make sure that is on PATH
git config core.hooksPath .githooks
```

`.npmrc` sets `ignore-scripts=true`: dependency install scripts do not run. If a new
dependency genuinely needs one, add it to `onlyBuiltDependencies` in `pnpm-workspace.yaml`
in the same pull request and say why.

## Database

```sh
docker compose up -d --wait postgres
export DATABASE_URL=postgres://diagram_mapper:diagram_mapper@127.0.0.1:5432/diagram_mapper
pnpm db:migrate
```

If port 5432 is already in use, pick another: `DM_PG_PORT=55433 docker compose up -d --wait
postgres` and use that port in `DATABASE_URL`. The compose credentials are fixed, local and
throwaway; never reuse them anywhere else.

## Run the app

```sh
pnpm dev                                 # http://localhost:3000
curl http://localhost:3000/api/v1/health # {"status":"ok","schemaVersion":1}
```

The full environment for later milestones is listed in `.env.example` (names only).

## Tests and checks

These are the same commands CI runs. All of them must pass before a pull request is merged.

| Command | What it checks |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` in every package, `strict` + `noUncheckedIndexedAccess` |
| `pnpm lint` | Biome lint and format (`pnpm format` fixes formatting) |
| `pnpm test` | Vitest across all packages and the gate scripts |
| `pnpm test:coverage` | the same, with the 85% threshold on `packages/graph` and `packages/parser` |
| `pnpm test:boundaries` | the module rules of TECH-SPEC §2.3 |
| `pnpm build` then `pnpm licences` | the licence gate; the build records which packages reach the browser |
| `pnpm audit --prod --audit-level=high` | known vulnerabilities in production dependencies |

The database test is skipped when `DATABASE_URL` is unset. Set `REQUIRE_DB=1` to make a
missing database a failure instead, as CI does.

## Conventions

- **Package manager:** pnpm only, version pinned by `packageManager`. Commit `pnpm-lock.yaml`.
  Shared dependency versions live in the `catalog:` in `pnpm-workspace.yaml`; packages refer
  to them as `"catalog:"`. Internal packages are `0.0.0`, private, and referenced as
  `workspace:*`.
- **New dependency:** say in the pull request why it is needed and what its licence is. The
  licence gate is an allow-list; anything it does not recognise fails. Never edit
  `licence-policy.json` or `licence-exceptions.json` yourself — QA & Security owns them.
- **TypeScript:** ESM everywhere, relative imports carry the `.ts` extension, packages are
  consumed as source (`exports` points at `src/index.ts`). Gate scripts run directly with
  Node's type stripping (`node scripts/x.ts`), so they use erasable syntax only.
- **Tests:** next to the code as `*.test.ts`. A change ships with a test that fails without
  it. Parser work is not finished without a golden fixture under `fixtures/terraform/`.
- **Boundaries:** `process.env` only in `packages/config`; `pg` and `drizzle-orm` only in
  `packages/db`; `packages/graph` imports nothing but `zod`. The boundary gate enforces this.
- **Migrations:** `pnpm db:generate` after changing `packages/db/src/schema.ts`, then read
  and hand-extend the generated SQL (roles, grants, RLS). Forward-only. Every migration
  file starts with a comment giving its manual rollback.
- **Diagnostics:** a failure tells the user the file and line that caused it. Codes come from
  the closed enum in `packages/graph/src/errors.ts`.
- **Secrets:** never in the repository, a log line, or a comment. `.env` is git-ignored;
  `.env.example` holds names only. A secret that reaches any branch is rotated, not just
  deleted.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/). Every change
  reaches `main` by pull request with CTO review and green CI. Gates are never bypassed.

## Licence

The licence for this repository is being confirmed by the product owner. Until a `LICENSE`
file is committed, no licence is granted.
