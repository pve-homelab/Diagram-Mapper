# Diagram Mapper — Test Strategy

Owner: QA & Security Engineer (reports to CEO, independent of the CTO and the engineers
whose work is verified).
Status: M0 baseline, version 1.0. Mirrored from issue document `test-strategy` on AIS-7.
Applies to: launch scope — Terraform / HCL only, plus customer-supplied `terraform plan`
JSON. TypeScript / Next.js / PostgreSQL / React Flow / Stripe / Claude API.

---

## 0. The rule this document exists to enforce

**Nothing is believed until it has been verified from evidence gathered independently.**
No agent closes its own work as verified. "It works" is not a result; the command, its
output, the diff, the screenshot, the request and the response are results.

Two corollaries that shape every choice below:

1. **A check that only I can run is a check that will stop running.** Every check in this
   strategy is either automated in CI or is a named, scheduled manual procedure with a
   written script and a recorded result. There is no third category.
2. **For every test, state the oracle** — how we decide the answer is right. If the oracle
   cannot be stated, the test proves nothing and is not worth writing. Every section below
   names its oracle explicitly; this is the acceptance criterion for this document.

---

## 1. Test shape, tooling, and where each check runs

All tooling below is free / open source. Nothing here requires a purchase. Any future
paid tool goes to the CEO first.

| Layer | Tool | Count target | Runs |
|---|---|---|---|
| Unit | Vitest | ~70% of test count | pre-commit (changed files), every PR |
| Integration (API + DB) | Vitest + real PostgreSQL in a CI service container | ~20% | every PR |
| Contract / schema | Zod schemas + `zod-to-json-schema` snapshot diff | — | every PR |
| End-to-end | **Playwright, headless, in the repository** | ~10%, ≤ 40 specs | every PR (smoke), nightly (full) |
| Golden fixtures (graph accuracy) | Vitest + committed fixture repos | one per fixture | every PR |
| AI grounding | Node checker + sealed held-out fixture set | — | every PR (checker), nightly (model eval) |
| Accessibility | `@axe-core/playwright` + manual keyboard script | — | every PR (axe), per release (manual) |
| Performance | Playwright tracing + k6 (OSS) + parser benchmarks | — | nightly + per release |
| Security | see `docs/THREAT-MODEL.md` §8 (CI security gates) | — | every PR |
| Load / soak | k6 | — | per release |
| Deployment smoke | Playwright `@smoke` tag against the deployed URL | — | every deploy |

**Dependency injection over mocking.** Mocked collaborators test the mock. Integration
tests run against a real PostgreSQL with row-level security enabled, a real Stripe test
mode (or `stripe-mock` for pure-unit paths), and recorded-and-replayed GitHub App HTTP
fixtures via `msw`. The AI provider is the one exception: model calls are replayed from
recorded cassettes in PR CI (deterministic, free, fast) and executed live against the real
model in the nightly evaluation job (see §4).

### CI pipeline stages and gates

```
PR  → lint + typecheck + unit            (fail → stop)
    → integration (PostgreSQL, RLS on)   (fail → stop)
    → cross-tenant isolation suite       (fail → stop, no override)
    → golden fixtures (graph accuracy)   (fail → stop)
    → grounding checker (cassettes)      (fail → stop)
    → security gates (secrets, deps, licences)  (fail → stop)
    → build → Playwright smoke + axe     (fail → stop)
nightly → full Playwright, live-model grounding eval on sealed set,
          perf budgets, fuzz corpus, full-history secret scan
release → load/soak, backup-restore drill, migration up/down,
          manual a11y script, release gate document
```

Gates marked "no override" cannot be bypassed by a label, a force-merge, or a `skip-ci`
commit message. Branch protection must make the cross-tenant suite, the grounding checker
and the licence check required status checks. If a gate can be clicked past, it is not a
gate.

---

## 2. Unit testing

**What is covered.** Pure logic: HCL expression and reference resolution, module and
`count` / `for_each` expansion, graph construction and edge derivation, address
normalisation, entitlement state machine, authorisation predicate helpers, the crypto
wrapper, the prompt builder/serialiser, the log redaction allowlist, the citation
resolver.

**What is deliberately not covered here.** Anything whose correctness depends on the
database, the network, or the browser. Those are integration or E2E; a unit test that
mocks PostgreSQL proves only that the mock was configured as expected.

**Oracle.** Table-driven cases with hand-computed expected values written *before* the
implementation, derived from the Terraform language specification rather than from the
behaviour of our own parser. For every function with a mathematical property (idempotence
of address normalisation, graph edge symmetry where the relation is symmetric, stability
of node ordering under input reordering), the oracle is the property, asserted with
`fast-check` property-based tests, not a single example.

**Coverage.** Line coverage is a diagnostic, not a target; a coverage percentage is not
evidence that behaviour is right. The enforced rules are: (a) every defect fix ships with
a test that fails against the pre-fix code — the PR must show that failure; (b) mutation
testing with Stryker (OSS) is run per release on the parser and authorisation modules, and
a surviving mutant in either is triaged, because those are the two modules where a silent
wrong answer is most expensive.

---

## 3. Diagram accuracy — golden fixtures

This is the product's core correctness claim and the area where "it looked right" is most
tempting and most worthless. **Correctness of the graph is proven against committed
fixture repositories with hand-verified expected output, never by eye.**

### 3.1 Fixture layout

```
fixtures/
  terraform/
    <fixture-name>/
      README.md            # provenance, what this fixture is for, who verified it, when
      src/                 # the Terraform files, committed verbatim
      expected-graph.json  # canonical expected graph — hand-verified
      expected-notes.md    # per-node and per-edge justification, with file:line
      plan.json            # optional: terraform plan JSON, where applicable
```

`expected-graph.json` is canonical: nodes sorted by address, edges sorted by
`(from, to, kind)`, no timestamps, no absolute paths, schema-versioned. Canonicalisation
is a library function shared by the fixture tool and the test, so a reordering in the
parser output cannot produce a spurious diff and cannot hide a real one.

### 3.2 How a fixture is created

1. The `src/` tree is written or vendored (vendored repos: licence recorded in `README.md`
   and checked against `security/licence-policy.json`; permissively licensed public
   examples only; **never a real customer repository and never a third party's private
   repository**).
2. `expected-graph.json` is authored **by hand, by reading the source**, by someone who did
   not write the parser code under test. For large fixtures, the expected file may be
   seeded from a *second independent implementation* (`terraform graph` from OpenTofu, or
   the customer-supplied `plan.json` where available) — never from our own parser.
3. `expected-notes.md` records, for every node and every edge, the `file:line` in `src/`
   that justifies it. An edge nobody can justify in writing is an edge we do not assert.
4. The fixture is reviewed in a PR whose diff shows the expected graph in full.

### 3.3 How a fixture is kept honest

The failure mode to defend against is: the parser changes, the golden file is regenerated
to match, the test goes green, and the product is now wrong in a way nobody reviewed.
Controls:

- **No automatic regeneration.** The test asserts equality only. Regeneration requires
  running `pnpm fixtures:update --fixture=<name>` locally with `--reason="…"`, which writes
  the reason into the fixture `README.md`.
- **CI never regenerates.** The update script hard-exits when `CI=true`.
- **Golden changes are gated by review.** `CODEOWNERS` assigns `fixtures/**/expected-*` to
  the QA & Security Engineer. A PR that modifies both parser code and an expected graph
  must explain, in the PR body, why the old expectation was wrong — not why the new output
  is convenient. A diff to an expected graph with no corresponding change in
  `expected-notes.md` fails CI (`scripts/check-fixture-integrity.mjs`).
- **Second-oracle cross-check.** For every fixture that has a `plan.json`, a separate test
  asserts our graph's resource set equals the plan's resource set (modulo documented,
  enumerated exceptions such as `data` sources and `moved` blocks). Two independent
  oracles disagreeing is a finding, not a test to loosen.
- **Drift detection.** A nightly job re-runs all fixtures against the current parser and
  reports any fixture whose assertion has been `skip`ped or `todo`ed. A skipped accuracy
  test is treated as a failing one.

### 3.4 Oracle

The hand-written `expected-graph.json`, justified line by line in `expected-notes.md`,
authored independently of the implementation, and cross-checked against `plan.json` where
one exists. Pass = byte-equal canonical JSON. Partial credit does not exist here: a graph
that is 98% right is a diagram that lies in one place, and the customer cannot tell which.

### 3.5 Required fixture set at launch (minimum)

Boundary first, middle second — the interesting bugs are at the edges.

| Fixture | What it pins down |
|---|---|
| `empty-repo` | zero files → empty graph, 200 with an explanatory empty state, not an error |
| `no-terraform` | a repo with no `.tf` at all → clear "nothing to map" result, not a crash |
| `single-resource` | one `aws_instance`, no references → 1 node, 0 edges |
| `explicit-depends-on` | `depends_on` → edge, with the right direction |
| `implicit-reference` | `aws_instance.a.id` in another resource → derived edge |
| `interpolated-reference` | reference inside a string template |
| `local-module` | `module "x" { source = "./m" }` → addresses prefixed `module.x.` |
| `nested-modules-5-deep` | address composition and depth limit behaviour |
| `count-and-for-each` | expansion to indexed addresses `[0]`, `["key"]` |
| `dynamic-blocks` | `dynamic` block expansion |
| `data-sources` | data sources distinguished from managed resources |
| `locals-and-vars` | variable defaults, `locals` chains, unresolved variables |
| `multi-provider` | aliased providers, resources attributed correctly |
| `cyclic-depends-on` | cycle detected and reported; **must not** hang or stack-overflow |
| `malformed-hcl` | syntax error → precise `file:line` diagnostic, partial graph policy stated and asserted |
| `mixed-valid-invalid` | one broken file among nine good ones → the nine still parse |
| `huge-10k-resources` | generated; correctness assertions on a sampled subset + perf budget |
| `unicode-and-crlf` | non-ASCII names, CRLF line endings, BOM — line numbers still correct |
| `secrets-bearing` | `terraform.tfvars`, `*.tfstate`, `.env` present → excluded from parse and from any prompt (asserts the control in THREAT-MODEL TM-05) |
| `injection-corpus/*` | repositories containing text crafted to steer the model (THREAT-MODEL TM-06) |
| `deep-expansion-bomb` | `count = 100000` → refused by limit, fail-closed, no OOM |
| `zip-slip`, `symlink-escape` | archive extraction safety (TM-12); asserted at the extractor, not the parser |

`malformed-hcl` deserves emphasis: **parser differentials are exploits waiting to happen**,
and parsing untrusted HCL is the core feature. The oracle for a malformed input is never
"doesn't crash"; it is "produces the specified diagnostic, at the specified line, and the
specified partial-graph outcome". Ambiguous input is **rejected, not guessed at**.

### 3.6 Parser fuzzing

`fast-check`-driven structural fuzzing plus a corpus-based fuzz job (`jsfuzz` or a simple
mutation harness over the fixture corpus), run nightly with a time budget. Oracle: the
parser terminates inside its timeout, throws only typed `ParseError`s, never a raw
`RangeError`/`TypeError`, never exceeds its memory cap, and never emits a node whose
`file:line` does not exist in the input. Every crash found is committed to
`fixtures/terraform/fuzz-regressions/` as a permanent case.

---

## 4. AI explanation grounding

**Grounding is a build failure, not a quality note.** An explanation that names a
resource, dependency, attribute or file absent from the source fails the build.

I coordinate with the AI Engineer's evaluation harness (AIS-6) but I **do not verify by
reading their report**. The harness below is mine, lives in `tests/grounding/`, and is
owned by `CODEOWNERS` as QA. Both run in CI; mine is the gate.

### 4.1 The contract the model output must satisfy

Every factual sentence in an explanation must carry at least one citation of the form
`{ path, startLine, endLine, commitSha }`. Explicitly flagged uncertainty
("this is likely…", "the configuration does not say…") is permitted and must be
*unannotated-but-marked*: the renderer distinguishes **verified fact** from **assumption**,
and an unmarked uncharacterised claim counts as a fact and therefore needs a citation.

### 4.2 The independent checker (deterministic, no model involved)

For each explanation produced in a test run, `tests/grounding/checker.ts` asserts:

1. **Citation resolves.** `path` exists in the fixture at `commitSha`; `startLine ≤
   endLine`; the range is within the file's line count. Unresolvable citation → FAIL.
2. **Entity closure.** Extract every entity the prose names — resource addresses
   (`aws_instance.web`), resource types, module names, attribute keys, provider names,
   file paths — with a deterministic extractor, and assert each is present in the graph's
   symbol table for that fixture. An entity named in prose that is not in the symbol table
   → FAIL. This is the test that catches the invented sibling resource, which is the
   failure mode that destroys trust fastest.
3. **Span support.** For each cited span, the specific entity attached to that citation
   must appear literally (after normalisation) within the cited lines, or be derivable
   from the graph edge the citation is attached to. A citation that points at the wrong
   lines is worse than no citation, because it survives spot-checking.
4. **Relationship truth.** Every dependency claim ("X depends on Y", "Y is used by X") must
   match an edge in the hand-verified `expected-graph.json` — the golden fixture, not the
   parser's live output. Direction counts. A reversed edge → FAIL.
5. **Numeric and attribute truth.** Any quoted attribute value must match the source
   literal exactly, or be absent. Paraphrasing a value is inventing one.
6. **No cross-fixture leakage.** No entity from any other fixture may appear. Catches
   context bleed and cache-key bugs.
7. **Redaction.** No value from `secrets-bearing` fixture files appears in the output, and
   no such file appears as a citation. Overlaps TM-05; asserted in both places on purpose.

**Oracle:** the hand-verified golden graph plus the fixture source text at a pinned commit.
Both are facts in the repository, not model output, and neither was produced by the system
under test. Pass = zero failures across the suite. There is no tolerated hallucination
rate for entity invention; the threshold is 0.

### 4.3 Held-out sealed evaluation set

Quality measured on the data someone tuned against is not quality.

- `fixtures/terraform/` — open set. Prompt engineering, few-shot examples and iteration
  may use it.
- `tests/grounding/sealed/` — **held-out set**. `CODEOWNERS`-restricted to QA. Its contents
  are not referenced in any prompt, system message, few-shot example or documentation.
  The AI Engineer does not see the question/answer pairs. It is used only in the nightly
  live-model job and in the release gate.
- A CI check (`scripts/check-sealed-set.mjs`) greps the application source, prompts and
  docs for any sealed fixture name or question string and fails on a hit. Leakage is
  detected mechanically, not promised.
- The sealed set is rotated: at each release, 20% of its cases are retired into the open
  set and replaced with new hand-authored cases. A sealed set that never changes
  eventually leaks through accumulated iteration.

**Reported metrics (nightly, live model, sealed set):** citation resolution rate, entity
invention rate, relationship error rate, refusal-when-unsupported rate (the model *should*
say "the source does not specify" — a confident answer to an unanswerable question is a
failure), and injection resistance (§4.4). Release criteria: entity invention 0,
relationship error 0, citation resolution 100%, unanswerable-question refusal ≥ 95%.

### 4.4 Prompt-injection resistance (shares the fixtures, different oracle)

`fixtures/terraform/injection-corpus/` holds repositories whose comments, resource names,
descriptions and README text attempt to steer the model. Repository content is untrusted
input; the test asserts the system treats it as data and never as instruction.

**Oracle:** each injection fixture declares a machine-checkable *success marker* for the
attack — the thing that would only appear if the model had obeyed the embedded
instruction (a specific benign sentinel string, an unexpected tool invocation, a citation
outside the allowed file set, a markdown image or link to a non-allowlisted host, or a
dropped citation requirement). Pass = zero markers across the corpus **and** the §4.2
checker still passes on the output. Attack success budget: 0. No exploit payloads are
pasted into comments or public PR descriptions; the corpus lives in the repository with a
`README` that describes classes, and findings reference the fixture name rather than
quoting the payload.

---

## 5. Integration, API and data validation

**Scope.** Every route handler against a real PostgreSQL with RLS enabled, a real session,
and real migrations applied from scratch.

- **Schema contract.** Every request and response body has a Zod schema. A snapshot of the
  generated JSON Schema is committed; a change to it is a visible diff in review. Oracle:
  the committed schema snapshot.
- **Negative validation matrix.** For each field: missing, null, wrong type, empty string,
  whitespace, over-length (declared max + 1), under/over numeric range, wrong format,
  unexpected extra properties, prototype-pollution keys (`__proto__`, `constructor`),
  deeply nested JSON, very large array. Oracle: a 4xx with a typed error code and **never
  a 5xx**; a 5xx on malformed input is a defect, because it means an unvalidated value
  reached the implementation. Extra properties are rejected (`.strict()`), not stripped —
  **reject ambiguous input rather than sanitising it**, and mass-assignment is the
  broken-object-property-level-authorisation bug in OWASP API Top 10.
- **Authorisation matrix.** For every route × {anonymous, authenticated-other-tenant,
  authenticated-same-tenant-wrong-role, owner} the expected status is declared in a table
  in `tests/authz/matrix.ts`, and the test is generated from the table. A route added
  without a matrix row fails CI (route-manifest completeness check, §6.2). **Deny by
  default:** the matrix's default expectation for an undeclared combination is 404/403, and
  the generator asserts the handler agrees.
- **Data integrity.** Migrations run up and down on every PR against a seeded database;
  NOT NULL / FK / UNIQUE / CHECK constraints are asserted by attempting the violation and
  expecting the error (a constraint nobody has tried to violate is a constraint that might
  not exist). Oracle: the declared schema invariants.
- **Idempotency and concurrency.** Repeated webhook delivery, double-submitted parse
  request, two concurrent parses of the same repository. Oracle: a declared post-state; one
  logical effect, no duplicate rows, no lost update. Concurrency tests use real parallel
  transactions, not sequential calls pretending to be parallel.

---

## 6. Security testing in CI

The full model, findings and controls are in `docs/THREAT-MODEL.md`. The automated part:

### 6.1 Cross-tenant isolation suite — the suite that cannot be skipped

Specified in full in `docs/THREAT-MODEL.md` §4 (TM-01) so that it is implementable
without further design. Summary: two seeded tenants, every route exercised with the other
tenant's object identifiers, plus database-level tests that prove the isolation is
**fail-closed** — a query issued with no tenant context returns zero rows rather than all
rows. Oracle: declared expected status per route (404, not 403, so the response is not an
existence oracle) and `rowCount === 0` at the database layer.

### 6.2 Route-manifest completeness

`scripts/check-route-coverage.mjs` enumerates every route from the Next.js build manifest
and fails if a route is absent from either the authorisation matrix or the cross-tenant
suite. This is the control that stops the suite rotting as the surface grows: coverage of
the attack surface is asserted, not assumed.

### 6.3 Other CI security gates

Secret scanning (`gitleaks`), dependency vulnerabilities (`osv-scanner`, `npm audit`),
dependency licences (`scripts/check-licences.mjs` against `security/licence-policy.json`),
static analysis (`semgrep` OSS rules + TypeScript strict + ESLint security rules),
log-redaction canary, raw-IaC-retention canary, header/CSP assertions in Playwright. Each
is specified in the licence-and-dependency plan (`docs/LICENCE-AND-DEPENDENCY-PLAN.md`
§4) or the threat model. All free.

---

## 7. End-to-end testing (Playwright)

**In the repository, headless, in CI** — so the checks keep running without me. Fixtures
and seeded tenants only; never a real customer repository, never real credentials.

Smoke set (`@smoke`, runs on every PR, target < 5 minutes):

1. Sign up → GitHub App install (stubbed App, real OAuth state/PKCE flow) → repository
   selected → parse completes → diagram renders with the expected node count.
2. Click a node → detail panel shows the resource with a `file:line` source reference →
   clicking the reference navigates to the cited source view.
3. Ask a question in the chat panel → answer renders with citations → clicking a citation
   navigates → the cross-reference "take me to it" button moves the canvas to the named
   node.
4. Chat panel is moved and resized; position persists across reload. (This is an explicit
   product requirement from `PROMPT.md`, so it is an explicit E2E assertion.)
5. Free tier without a customer API key → asked for a key, blocked with a clear message,
   no platform key consumed. Oracle: the platform key usage counter does not increment.
6. Subscribe (Stripe test mode) → entitlement becomes active → a paid-only action succeeds.
7. Sign out → protected route returns to sign-in, back-button does not reveal cached
   tenant data.

Full set (nightly) adds: all boundary repositories from §3.5 driven through the real UI,
error and recovery journeys (§9), billing journeys (§10), accessibility sweep (§8), and
the deep-link/permalink surface.

**Oracle.** Each spec asserts on application state and visible text with stable
`data-testid` hooks and accessible roles — never on pixel positions, never on
`waitForTimeout`. Visual regression is deliberately excluded from the gate: for a
force-directed canvas it is inherently flaky, and node *positions* are not a correctness
claim; node and edge *identity* is, and that is asserted in §3 against the golden graph.

**Flaky is failing.** A spec that fails intermittently is quarantined within one working
day: moved out of the gate into a tracked quarantine project with an owning engineer and a
defect issue, or deleted. A test that passes four times in five tells us nothing. The CI
job records retries; a spec requiring a retry to pass is reported as a failure in the
nightly summary even though the job is green. Retries are 0 in PR CI for the smoke set.

---

## 8. Accessibility (WCAG 2.2 AA)

Automated (every PR): `@axe-core/playwright` on every primary view and on the diagram,
detail panel, chat panel, onboarding, pricing and billing pages, including the keyboard
focus states and both colour themes. **Oracle:** zero `serious` or `critical` axe
violations; `moderate` violations are triaged with a written decision. Contrast is
*computed* from the design tokens by a unit test against the WCAG formula (4.5:1 body,
3:1 large text and UI components), not judged by eye.

Automated but axe-invisible, so asserted explicitly:

- **Keyboard reachability.** Every interactive element reachable by `Tab`, in a logical
  order, with a visible focus indicator meeting WCAG 2.2 *Focus Appearance*. Asserted by
  walking the focus order in Playwright and snapshotting the sequence of accessible names.
- **Focus management.** Opening the detail panel moves focus into it; closing returns focus
  to the invoking node; the movable chat panel does not trap focus; `Escape` closes.
- **The canvas is the hard part.** A React Flow canvas is not accessible by default. The
  requirement, which I will verify and will fail the release on: a semantically equivalent,
  keyboard-navigable **tree/list view of the same graph** (nodes, their types, their
  dependencies), reachable without a mouse, exposing the same detail panel and the same
  explanations. Oracle: an automated test asserts the accessible alternative contains
  exactly the same node and edge set as the rendered graph for every fixture. Equivalence
  is asserted mechanically because "there's an accessible view too" is otherwise a claim
  that silently decays.
- **WCAG 2.2 additions specifically checked:** 2.4.11 Focus Not Obscured (the movable chat
  panel must not permanently obscure the focused node — asserted by checking the focused
  element's bounding box is not fully covered), 2.5.7 Dragging Movements (every drag — pan,
  node move, panel move and resize — has a keyboard or single-pointer alternative), 2.5.8
  Target Size (≥ 24×24 CSS px, asserted from computed boxes), 3.2.6 Consistent Help, 3.3.7
  Redundant Entry, 3.3.8 Accessible Authentication (no cognitive-function test).
- **Motion and zoom.** `prefers-reduced-motion` honoured (no canvas easing animation);
  layout usable at 200% zoom and at 320 CSS px width without loss of function (1.4.10
  Reflow), asserted at fixed viewports.

Manual (per release, scripted in `docs/qa/a11y-manual-script.md`, result recorded in the
release gate): a keyboard-only end-to-end pass, a screen-reader pass (NVDA on Windows and
VoiceOver on macOS — both free) over the diagram, the detail panel and the chat, and a
zoom/reflow pass. **Oracle:** the task can be completed, and what is announced matches
what is displayed. Automated tooling catches roughly a third of real accessibility
defects; the manual script is not optional and its result is a named line item in the
release gate.

---

## 9. Performance

Budgets are numeric and enforced; "feels fast" is not an oracle. Baselines are set in M0
by the CTO's canvas spike (AIS-5) and the parser spike (AIS-4); I verify against the
budget, independently, on CI hardware, reporting p50 and p95 over ≥ 10 runs.

| Measure | Budget (p95) | Harness |
|---|---|---|
| Parse, 100 resources | < 2 s | parser benchmark |
| Parse, 1 000 resources | < 10 s | parser benchmark |
| Parse, 10 000 resources | < 90 s, memory < 1 GB, or a refusal with a clear limit message | parser benchmark |
| `GET /api/graphs/:id` (1 000 nodes) | < 500 ms server time | k6 |
| First diagram interactive, 500 nodes | < 3 s from navigation | Playwright trace |
| Canvas pan/zoom, 500 nodes | ≥ 30 fps sustained, no frame > 100 ms | Playwright trace |
| Canvas, 2 000 nodes | usable with progressive disclosure / clustering; stated degradation policy asserted | Playwright trace |
| First explanation token | < 3 s | Playwright + cassette and live |
| 50 concurrent users browsing | no error rate > 0.1%, p95 < 1 s | k6 |

**Oracle:** the budget. Exceeding it is a failing test, not a note. Budgets are stored in
`perf/budgets.json`, and the nightly job fails on regression beyond a 10% tolerance band
against the committed baseline, so slow drift is caught rather than discovered at launch.
Where a budget cannot be met, the product decision is a **documented refusal** — a stated
resource-count ceiling with a clear user-facing message — rather than a page that hangs.
A documented limit is a feature; a hang is a defect.

---

## 10. Error handling and recovery

Fault injection matrix. For each fault: expected user-visible behaviour, expected log
record, expected retry/cleanup behaviour, expected system state afterwards.

| Fault | Expected |
|---|---|
| GitHub App unreachable / 500 / rate-limited (403 + `x-ratelimit-remaining: 0`) | typed error, retry with backoff and jitter, user-visible "GitHub is unavailable, retrying", no partial graph saved |
| GitHub App installation revoked mid-parse | job fails closed, tenant told to re-install, stored installation marked invalid, no stale data served |
| Repository too large / too many files | refused **before** download with the limit stated |
| Parse worker killed (OOM / timeout) | job marked failed with a reason, temporary directory removed, no orphaned raw IaC on disk (asserted) |
| AI provider 429 / 529 / timeout | retry with backoff, then a clear message; no partial hallucinated answer rendered; tokens accounted once |
| AI provider returns malformed or uncited output | rejected by the grounding checker at runtime, not shown; a "could not answer reliably" state is shown |
| Customer's own API key invalid (free tier) | precise message naming the key, no platform key fallback (asserted: platform counter unchanged) |
| Token budget exhausted | fail **closed** with 402/429 and a clear message, never a silent downgrade or an uncapped call |
| PostgreSQL connection lost mid-request | 503, no partial write, transaction rolled back |
| Stripe webhook arrives twice / out of order | idempotent; final entitlement matches Stripe's authoritative state |
| Subscription cancelled mid-request | entitlement re-checked at request time; the in-flight expensive call is refused |
| Session expires mid-session | re-authentication prompt, no data leak in the error, returns to the intended page |
| Deploy rolled back with a migration applied | documented, drilled procedure; migrations are backwards-compatible for one release |

**Oracle:** the declared row. Every row asserts three things, because an error path that
behaves correctly for the user while leaking into the logs or leaving data on disk is
still a defect: user-visible behaviour, log content (and absence of secrets), and
persistent state afterwards.

---

## 11. Subscription and billing

Stripe **test mode only** until the CEO authorises live mode. No payment capture, no
outbound email, no destructive flow against a shared environment without explicit
go-ahead on the task.

The oracle is an explicit **entitlement state machine** table in `tests/billing/states.ts`:
(plan, subscription status, payment status, cancellation state, usage against cap) →
(allowed actions, AI key source, visible UI state). Every test asserts a cell of that
table. Entitlement is derived **only** from Stripe-confirmed state, never from a client
assertion or a URL parameter.

Journeys: subscribe; card declined (`4000000000000002`); 3-D Secure required
(`4000002500003155`); upgrade and downgrade with proration; cancel at period end (access
until the end, then refused); immediate cancel; payment failure then dunning then
recovery; webhook replayed; webhook signature invalid → rejected; trial expiry; **cancelled
subscription mid-request**; usage cap reached on a paid plan; a free-tier user with no key;
tenant with two users and one subscription; refund/chargeback.

Boundary cases that matter financially: a cancelled subscription must not leave an
in-flight AI call billable to the platform key; a downgrade must not retroactively grant
free access to a paid graph; a second signup with the same email must not attach to an
existing tenant (that is both a billing bug and a tenancy bug). Each of those has a named
test.

---

## 12. Deployment and production operations

| Check | Oracle | When |
|---|---|---|
| Reproducible build from a clean clone, documented commands | documented commands exit 0 on a clean container; lockfile honoured (`--frozen-lockfile`) | per release |
| Migrations up on a copy of production-shaped data | exit 0, schema matches the declared snapshot, no destructive change without a reviewed plan | per deploy |
| Post-deploy smoke | Playwright `@smoke` against the deployed URL, all green | every deploy |
| Security headers on the live origin | asserted values: HSTS, nonce-based CSP with no `unsafe-inline`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, cookie flags | every deploy |
| TLS configuration | TLS 1.2+ only, valid chain, HSTS present (checked with `openssl`/`curl`, no third-party scanning service) | per release |
| Backup exists and **restores** | restore into a scratch database and run the integration suite against it — a backup that has never been restored is a hope, not a backup | per release, then monthly |
| Rollback | documented procedure executed in staging and timed | per release |
| Monitoring and alerting | a deliberately triggered synthetic error appears in the alert channel within the stated SLO | per release |
| Secret inventory | every secret the app needs is in the secret manager, rotatable, with a documented owner; none in the repository (gitleaks full-history, green) | per release |
| Cost guardrail | the running-cost guardrail (£60/month until the first paying customer) is instrumented with an alert; verified by forcing the counter | per release |

Public deployment, live Stripe mode, any spend, and any destructive run against a shared
environment are **CEO decisions**, escalated before execution, not assumed.

---

## 13. What stays manual, and why

Automation is the default; these four resist it honestly:

1. **Screen-reader experience** (§8). Automatable checks are a floor, not the outcome.
2. **Diagram comprehensibility** — whether a junior engineer actually *understands* the
   architecture. Oracle: a scripted usability session with ≥ 3 representative users and a
   task-completion rate, run by Product; I verify the session was run and record the
   result. This is the product's actual promise, and no assertion covers it.
3. **Explanation usefulness** (as distinct from groundedness, which is automated). Oracle:
   a human rubric on the sealed set, scored blind, ≥ 4/5 median.
4. **Threat-model review of new surface** — a judgement, performed per release, recorded
   in the risk register.

Everything else that is currently manual is a gap with an owner and a date, tracked in the
release gate, not a permanent category.

---

## 14. Defect and verdict discipline

- **Regression tests encode the bug.** Every fix ships with a test that fails against the
  pre-fix code. The PR shows that failure. No test, no merge.
- **Failed verification goes back to the owning engineer** with exact reproduction steps,
  expected versus actual, and the evidence. I do not fix feature code; I write the
  regression test and small remediations.
- **A verdict is the deliverable.** A review task closes with pass or fail on my own task,
  even when the findings are bad. Adverse findings are a completed review.
- Severity: **S1** data loss, cross-tenant exposure, secret exposure, payment error, or a
  false explanation presented as fact → release blocker, no exceptions. **S2** core journey
  broken for a common case → blocker. **S3** broken edge case with a workaround → fix or
  document. **S4** cosmetic → backlog. Severity is scored separately from exploitability
  and likelihood, and each is given a reason.

A **release gate** is complete only when it lists the tests that ran and their results,
the security checks performed, every unresolved defect with its severity, every residual
risk written down explicitly, and a plain statement of whether the release criteria are
met. A pass verdict with no evidence is not a pass.

---

## 15. Known gaps in this strategy (stated, not hidden)

1. **No code exists yet.** Every oracle here is specified against the approved design. The
   strategy will be re-verified against the real implementation at the end of M1, and this
   document versioned.
2. **Canvas accuracy at 10 000 nodes** is asserted on a sampled subset plus totals, not
   node-by-node; a full hand-verified 10 000-node expected graph is not economic to author.
   Residual risk: a systematic error affecting only very large graphs. Partially mitigated
   by the `plan.json` second oracle on generated fixtures.
3. **Live-model non-determinism.** PR CI uses cassettes, so a model-behaviour regression is
   caught nightly, not at merge. Residual risk: up to 24 hours of exposure on a branch.
   Accepted; the alternative is a slow, costly, flaky gate.
4. **Multi-cloud and non-Terraform IaC** are out of launch scope, therefore untested.
   Marketing claims must match tested scope; I will verify the landing page against it.
5. **Load testing is synthetic.** Real traffic shapes are unknown pre-launch.
6. **No penetration test by an independent third party.** Out of budget. Residual risk
   recorded in the risk register; recommend one before any enterprise sale. CEO decision.
