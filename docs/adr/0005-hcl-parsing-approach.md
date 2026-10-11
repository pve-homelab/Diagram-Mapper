# ADR-0005: HCL parsing — `@cdktf/hcl2json` (WASM) plus an in-house position index

| | |
|---|---|
| **Status** | **Accepted, spike-conditional** on Backend spike AIS-4 |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (owns AIS-4 and the implementation), QA & Security (owns the licence ruling and has a block) |
| **Affects** | `docs/TECH-SPEC.md` §3, §5.3–5.5, §5.7, §13.1, §13.4, §15, M1 sizing |
| **Reversibility** | Moderate. `packages/parser` exposes `parse(files) => ParseResult`; the implementation behind it can be replaced without touching the graph model, the database, the API or the canvas. Replacement cost is 1–3 weeks depending on the option. |

## Context

Parsing Terraform is the product. If the parse is wrong, the diagram is wrong and the
explanations are confidently wrong, which is worse than having no product. **Build the
risky part first** — this and grounded explanations are where the risk lives.

What the parser must produce, from `TECH-SPEC` §4 and ADR-0003:

1. Block structure: `resource`, `data`, `module`, `variable`, `local`, `output`,
   `provider`, `terraform` blocks with their labels and attributes.
2. **Unevaluated expressions preserved as text** — `"${var.env}-web"` must survive as an
   expression, because the model represents partial knowledge rather than collapsing it.
3. **File and line ranges for every block and every attribute.** This is non-negotiable.
   `SourceRef` on every node, edge and value is what makes grounded citation possible, and
   it is the one requirement that eliminates most of the options below.
4. Tolerance: one malformed file must not fail the scan. Partial success is the normal
   outcome, not an exception path.
5. Safety: this code processes untrusted customer bytes. It must not throw, hang, or
   exhaust memory on hostile input.

Constraints: TypeScript only (ADR-0002, one runtime); £60/month; permissive licences, with
QA & Security owning the authoritative ruling; and no execution of customer code, ever.

## Options considered

### Option A — The `terraform` CLI (`terraform providers schema`, `terraform graph`, or parsing via the binary)

HashiCorp's own implementation. Maximally accurate by definition — it *is* the reference.

**Cost: excluded outright on licence grounds.** Terraform ≥ 1.6 is **BUSL-1.1**, a source-
available licence whose additional use grant prohibits use in a product competing with
HashiCorp's offerings. A hosted commercial Terraform visualisation service is close enough
to that line that I will not take the risk, and the decision does not need a lawyer to be
obvious. We do not ship, embed, call or vendor the `terraform` binary, and the CI licence
gate fails the build on any BUSL dependency.

Independently of licence: it would mean executing a Go binary against customer
configuration, which is a sandboxing and supply-chain exposure, and `terraform graph`
emits no source positions anyway, so it fails requirement 3 regardless.

### Option B — OpenTofu's Go libraries, or `hashicorp/hcl` directly, as a Go sidecar

OpenTofu is MPL-2.0 (the Terraform fork from before the BUSL change), and `hashicorp/hcl`
itself remains **MPL-2.0** — the licence change applied to Terraform, not to the HCL
library. Both are Go. `hclparse` gives exact `hcl.Range` source positions for every block
and attribute, for free, from the reference implementation. **This is the technically
superior option for accuracy and it is the one I most seriously considered.**

**Cost:** a second language and runtime in the stack. A Go service or WASM-compiled Go
module, its own build pipeline, its own dependency and CVE surface, cross-process or
cross-boundary serialisation of the parse result, and — decisively for a six-agent team —
code that exactly one agent can write and nobody else can review. Roughly 3–5 days saved
on position indexing, paid back indefinitely in two-runtime maintenance. It also inherits
the same MPL-2.0 question as Option C without removing it.

Rejected on **boring technology** and Conway's Law grounds, not on technical merit. I am
recording it explicitly as the **first fallback** if the position index proves harder than
estimated, because it solves exactly the problem we are choosing to take on.

### Option C — `@cdktf/hcl2json` (WASM) plus our own position index (chosen)

`@cdktf/hcl2json` is HashiCorp's own `hashicorp/hcl` compiled to WebAssembly and published
as an npm package for CDKTF. It parses HCL to JSON from Node with no second runtime, and it
preserves unevaluated expressions as interpolation strings — requirement 2, satisfied by
the reference implementation rather than by our approximation of it.

Its one critical gap: **it does not emit source positions.** The Go `hcl.Range` data exists
inside the library but is not carried through the JSON conversion. Since positions are the
product, we compute them ourselves with a bracket- and string-aware scanner that maps
`(blockPath, attributeKey)` to a line/column range, then joins the two results by block
path.

**Cost:** ~5 days for the position index (the single largest risk line item in M1), plus
**MPL-2.0** — see the licence section below — plus a WASM module in the Node runtime
(bundling and cold-start considerations), plus the risk that the index and the parser
disagree about structure on unusual input.

The degradation strategy is what makes this acceptable: when a position cannot be resolved
precisely, we fall back to the **enclosing block's** range and emit a
`POSITION_INDEX_FALLBACK` diagnostic. A reference is then *wider* than ideal but always
**contains** the construct. **Degraded, never wrong.** A citation that points at a
20-line block instead of one line is a usability issue; a citation that points at the
wrong line destroys the product's credibility. The fallback converts the hard failure mode
into the soft one.

### Option D — A hand-written HCL parser in TypeScript

Full control, exact positions by construction, no WASM, no MPL.

**Cost:** HCL2 is a real language — expressions, for-expressions, dynamic blocks,
heredocs, operator precedence, function calls, splat expressions. A correct implementation
is weeks of work and a permanent maintenance obligation tracking HCL's evolution. Every
divergence from the reference implementation is a wrong diagram.

Rejected. **Cost of delay versus cost of rework** cuts the other way here: weeks of spike
to avoid days of position-index work is exactly the trade the lens warns against.

### Option E — An existing third-party TypeScript HCL parser

Several exist on npm.

**Cost:** low effort, high risk. The ones I assessed are either incomplete on HCL2
expressions, unmaintained, or without position information — and any of them becomes our
problem to maintain the moment it breaks on a customer's repository. Taking a dependency on
an unmaintained parser for the component that carries the product risk is the wrong place
to economise.

Rejected, with one exception: if AIS-4 finds a well-maintained, permissively licensed
parser that emits positions, that would be a better answer than this ADR and I want to
know. The spike is instructed to look.

### Option F — `terraform plan` JSON as the primary input

Accurate resolved values, real dependency edges, no parsing at all.

**Cost:** ~9 days saved; requires the customer to run Terraform with cloud credentials and
upload the output.

Rejected as primary and assessed fully in ADR-0003: **no source positions anywhere in the
output**, and it breaks the "connect a repository" onboarding promise. Retained as
**optional enrichment, structure only** (`TECH-SPEC` §5.7): it confirms `count`/`for_each`
resolution and contributes `plan_dependency` edges marked `provenance: "plan_json"`, and
**no value from it is ever persisted**. It also serves as the independent accuracy oracle
in §13.4 — comparing our static graph against plan JSON on fixtures where both exist is
how we measure recall, which is a much better use of it than making it the input.

## Decision

`packages/parser` parses Terraform with **`@cdktf/hcl2json` for structure and an in-house
position index for source ranges**, joined per file. Specifically (`TECH-SPEC` §5.3–5.5):

1. Per file, independently and tolerantly. A syntax error yields `FILE_PARSE_ERROR` with
   path and line for **that file only**; every other file continues. Partial success is
   the normal outcome.
2. `@cdktf/hcl2json` produces blocks and attributes with expressions unevaluated.
3. The position index — our bracket- and string-aware scanner — produces
   `(blockPath, attributeKey) → line/column range` for the same file.
4. The two are joined into `ParsedFile { blocks, diagnostics }`. An unresolvable position
   falls back to the enclosing block range with `POSITION_INDEX_FALLBACK`. **A reference
   always points to a range that contains the construct.** This is the normative rule;
   emitting a narrower-but-possibly-wrong range is forbidden.
5. **Evaluation is a separate, total, side-effect-free partial evaluator** (§5.5) with a
   deliberately short allow-list of pure functions (`join`, `format`, `lower`, `upper`,
   `trim`, `trimprefix`, `trimsuffix`, `replace`, `concat`, `merge`, `length`, `coalesce`,
   `try`, `tostring`, `tonumber`, `jsonencode`). Everything else — `for` expressions,
   `dynamic` blocks, provider functions, data results, resource attributes — is
   `unresolved` with a typed reason. It never throws; its failure mode is `unresolved`.
   Each function added to the allow-list is a new way to be subtly wrong about a
   customer's infrastructure, so additions require a fixture proving the semantics.
   Evaluation is bounded: ≤10,000 steps and ≤8 nesting levels per attribute.
6. **Reference extraction is syntactic and total** — it walks expression text, finds
   traversals and classifies them; it never evaluates. An unclassifiable expression yields
   `kind: "unknown"` plus a diagnostic. It never throws and never silently drops a
   reference.
7. **No module source is ever fetched.** Local relative paths inside the repository are
   followed (depth ≤ 8, cycles detected and reported, never followed); every other source
   — registry, git, GitHub shorthand, S3, HTTP — becomes a node with
   `moduleResolution: "remote_unsupported"` and a `MODULE_SOURCE_UNSUPPORTED` diagnostic,
   and the UI says so explicitly. Fetching arbitrary URLs on a customer's behalf is an
   SSRF and supply-chain exposure we are not taking at launch.
8. **Customer code is never executed.** No `terraform`, no `tofu`, no provider plugins, no
   cloud credentials, no network calls derived from file contents.
9. Both sub-parsers are **fuzz-tested** (§13.5): neither may throw, hang, or exceed memory
   on arbitrary input. They are the only components in the system that touch untrusted
   customer bytes, so they get the only fuzz harness.

**Spike-conditional.** Backend spike AIS-4 must measure, on real public Terraform
repositories: line-reference accuracy against hand-verified expectations; the
`POSITION_INDEX_FALLBACK` rate; edge recall against `terraform plan` JSON where available;
and parse time and memory at the file-count ceiling. If accuracy or the fallback rate is
materially worse than this ADR assumes, the fallbacks below are taken and this ADR is
superseded.

**Fallback order, decided now so it is not improvised under pressure:**

1. **Option B — a Go/WASM module over `hashicorp/hcl` or OpenTofu's parser**, consumed
   behind the unchanged `parse()` interface. ~2 weeks. Taken if position accuracy is the
   problem, since it solves positions definitively.
2. **Block-level-only references**, shipping with every citation at block granularity and
   narrowing later. Days. Taken if positions are merely imprecise rather than wrong — the
   product still works, citations are just coarser.
3. **A hand-written parser** (Option D). Weeks. Only if `hcl2json` itself proves unusable.

**Licence position, stated plainly.** `@cdktf/hcl2json` is **MPL-2.0** and embeds
`hashicorp/hcl` (MPL-2.0). MPL-2.0 is file-level copyleft: it obliges disclosure of
modifications to the MPL-covered files themselves and does not reach into separate works
that merely use the library. We consume it unmodified as an npm dependency of a hosted
service and distribute no binaries to customers at all. **My reading is that this is
compatible with a proprietary SaaS.** That is a reading, not a ruling: **QA & Security owns
the authoritative licence review (AIS-7) and has a block on this.** If MPL-2.0 is judged
unacceptable, fallback 1 does not help (OpenTofu and `hashicorp/hcl` are also MPL-2.0) and
we go directly to fallback 3 — which is why the ruling is needed **before** M1 parser code
lands, not after. Related: `elkjs` (EPL-2.0) is excluded from the layout-library choice
unless QA & Security clears it, and Terraform ≥ 1.6 (BUSL-1.1) is excluded unconditionally.

## Cost

- **Money:** £0 recurring. No paid service, no new infrastructure.
- **Engineering:** ~5 days for the position index, ~4 for the evaluator, ~5 for the graph
  builder and reference extraction, ~3 for plan-JSON enrichment and the recall metric, ~4
  for the golden corpus and line-reference verification. The two position/reference line
  items are the ones most likely to double, which is what AIS-4 exists to find out before
  the schedule depends on it.
- **Licence obligation:** MPL-2.0 compliance (attribution; disclose modifications to MPL
  files — we make none), pending QA & Security's ruling. This is the single largest
  non-technical risk in the parser.
- **Permanent:** the position index is ours to maintain as HCL evolves, and it must stay
  consistent with whatever `hcl2json` does. A WASM module in the Node runtime adds bundle
  size and cold-start cost.
- **Accepted incompleteness:** remote modules are not fetched, so repositories built mostly
  from registry modules will show large `unknown_reference` regions. That is a **product**
  limitation recorded as a risk (`TECH-SPEC` §15) with Product and Backend as owners, not a
  parser bug — and it is visible to the customer rather than hidden.

## Consequences

- One runtime, one language, one toolchain. Any agent can read the parser.
- Expressions survive parsing unevaluated, which is what makes `partial` and `unresolved`
  representable (ADR-0003) — the WASM parser being the reference implementation is a
  significant correctness asset here.
- Source positions are **ours**, which means line-reference accuracy is a quality property
  we own and must measure. §13.1 verifies on every fixture that the cited lines actually
  contain the construct; §13.4 measures recall against plan JSON. **Make the invariant
  checkable** — without these two gates this ADR would be an unverifiable claim.
- The parser is pure: stages 2–8 take data and return data, touching neither network nor
  database. That is what makes the golden-fixture corpus a real regression suite and lets
  the Frontend build against fixtures before any endpoint exists.
- The evaluator's short allow-list means we will frequently say "unresolved" where
  Terraform would know the answer. That is the intended trade: **honest gaps beat
  confident errors**, and the gap count is surfaced as a product metric.
- `parse()` is a genuine seam — a seam placed where something could change, per the lens.
  Swapping the implementation does not touch the graph model, the database, the API or the
  canvas.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| **MPL-2.0 acceptability** | Cannot use `hcl2json` at all; also cannot use OpenTofu or `hashicorp/hcl`, since all three are MPL. Fallback 1 is void and only a hand-written parser remains | **3–4 weeks**, the worst case in this ADR | QA & Security licence review (AIS-7), required **before** M1 parser code lands. Sequencing this first is deliberate |
| Position-index accuracy | Citations point at wrong or uselessly wide ranges; grounded explanations lose credibility — the core claim | Fallback 1 (~2 weeks) or fallback 2 (days) | Spike AIS-4's hand-verified line-reference measurement, before M1 commits |
| The fallback being "always containing" | A citation points somewhere the construct is **not**. Silent and corrosive: the diagram looks right and is wrong | Code fix is small; credibility cost is not | A §13.1 fixture assertion that every `SourceRef` range contains its construct, on every PR |
| The evaluator's allow-list being long enough | Many values show `unresolved` and the product looks blind on real repositories | Additive — each function is ~half a day plus a fixture | `stats.unresolvedAttributeCount` on the nightly public-corpus run. Measured, not guessed |
| Not fetching remote modules | Large real repositories render mostly as `unknown_reference` nodes — the product looks broken on exactly the repositories that most need it | Remote fetching is weeks plus a serious SSRF/supply-chain design, and needs its own ADR | Unresolved-ratio metric on the public corpus; Product's call on whether launch is viable without it. **This is the biggest product-level risk from this ADR** |
| WASM in Node (bundle size, cold start, memory) | Slow worker startup or memory pressure at the file ceiling | Days of tuning, or Option B | AIS-4's parse time and memory measurements |
| Fuzz-safety | A malicious repository hangs or OOMs the worker — a denial-of-service vector reachable by any signed-up user | Hours per bug, but it is a live availability issue | The nightly fuzz run; the 10-minute wall-clock scan budget bounds the damage |

Two of these have no cheap recovery: the MPL ruling and remote-module coverage. Both are
sequenced ahead of M1 implementation on purpose — the licence review as a hard gate, the
coverage measurement as a spike output — because discovering either after the parser is
built is the expensive version of finding out.
