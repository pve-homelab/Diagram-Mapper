# Diagram Mapper — Threat Model

Owner: QA & Security Engineer (reports to the CEO, independent of the CTO and of the
engineers whose work is verified).
Status: M0 baseline, version 1.0. Mirrored from issue document `threat-model` on AIS-7.
Target of evaluation: the approved design as specified in `docs/TECH-SPEC.md` v0.1
(AIS-3) and the six product-owner decisions recorded on AIS-7.
Method: STRIDE per element, over a data flow diagram with explicit trust boundaries.
Companion documents: `docs/TEST-STRATEGY.md` (how each control is proven),
issue document `licence-plan` (supply chain and licensing).

> **This is a design-time threat model. No code exists yet.** That is the point of doing
> it now: every finding below is cheap to fix today and expensive to fix after M2. Each
> finding names a concrete control and the engineer who owns it. The model is re-run
> against the real implementation at the M1 and M3 gates, and this document is versioned.

---

## 0. How to read a finding, and why severity and exploitability are scored separately

A single "risk score" hides the thing you need for scheduling. A flaw can be catastrophic
and nearly unreachable (fix it, but not tonight), or trivial and wide open (fix it
tonight). So every finding carries two independent scores.

**Severity — the damage if it happens.** Judged on blast radius, not on likelihood.

| | Meaning |
|---|---|
| **Critical** | Cross-tenant data access, customer credential disclosure, remote code execution, or a public data-handling promise proven false. Any one of these ends the company's credibility. |
| **High** | Single-tenant data disclosure, authentication or authorisation bypass within a tenant, secret persisted where it should not be, uncapped financial loss. |
| **Medium** | Availability loss, bounded financial loss, integrity of a diagram or explanation, or a control that fails open. |
| **Low** | Hardening gap, defence-in-depth layer missing while another layer still holds. |

**Exploitability — how hard it is to actually do.** 1 = hardest, 5 = easiest.

| | Meaning |
|---|---|
| **5** | Unauthenticated, no special knowledge, single request. |
| **4** | Any free-tier account the attacker can self-register; no guessing required. |
| **3** | Authenticated attacker plus one unguessable identifier, a race, or a specific victim action. |
| **2** | Requires a compromised internal component, a forged third-party signature, or a long enumeration. |
| **1** | Requires insider access, infrastructure compromise, or a cryptographic break. |

Findings also carry **Accident likelihood** where the realistic path to harm is an
engineering mistake rather than an attacker — the non-retention and redaction findings are
of this kind, and scoring them only on exploitability would make them look safe when they
are not.

Status values: `Open` (control not yet built), `Design-accepted` (the spec already
specifies an adequate control; my job is to verify it exists in code), `Residual`
(knowingly accepted, recorded).

---

## 1. Assets, ranked

What an attacker wants, in the order losing it would hurt.

| # | Asset | Why it matters | Classification |
|---|---|---|---|
| A1 | Another tenant's resource graph | It describes a real company's live infrastructure: resource names, network topology, security-group rules, IAM shapes. A reconnaissance gift for attacking *their* cloud. | Customer confidential |
| A2 | GitHub App installation tokens and the App private key | The private key mints tokens for **every** installation. One key compromise reads every customer repository we are installed in. | Secret, highest value |
| A3 | Customer-supplied Anthropic API keys (free tier) | Direct financial loss to the customer, and a credential they used elsewhere. | Secret |
| A4 | Secrets embedded in customer IaC | Hardcoded passwords and connection strings exist in real repositories whether we want them to or not. We ingest them by design. | Customer secret |
| A5 | The platform Anthropic key and its spend | Denial of wallet; the whole budget is GBP 60/month. | Secret + financial |
| A6 | Source snippets re-fetched for display and chat | Raw customer configuration, in memory, by design. | Customer confidential |
| A7 | Account data: email, GitHub id, display name, avatar | UK GDPR personal data. | Personal data |
| A8 | Diagram and explanation integrity | A confidently wrong diagram is worse than no diagram. Trust is the product. | Integrity |
| A9 | Service availability | Paid subscription. | Availability |

---

## 2. Trust boundaries

Six boundaries. Everything interesting happens when data crosses one.

| # | Boundary | Direction and the question it raises |
|---|---|---|
| **TB1** | Browser → Next.js API | Untrusted client. Is the caller who they claim, a member of the tenant they claim, and entitled to this capability? |
| **TB2** | Application → PostgreSQL | Is the tenant predicate present and impossible to omit? |
| **TB3** | GitHub → parser worker | **The repository tarball is attacker-controlled data.** A free-tier signup can hand us any archive and any HCL. |
| **TB4** | Parser worker → PostgreSQL (the persistence boundary) | What is allowed to be retained? This boundary carries the public non-retention promise. |
| **TB5** | Application → `api.anthropic.com` (the egress boundary) | What customer data leaves our control, and is repository-derived text being treated as data rather than instruction? |
| **TB6** | Stripe / GitHub webhooks → application | Unauthenticated internet-facing endpoints that mutate entitlements. Signature is the only thing standing there. |

A seventh, implicit boundary is the one that worries me most because it is easy to miss:
**TB4′ — the in-process source cache.** Section §4.9 of the spec holds re-fetched source
text in memory for up to 15 minutes. That cache is a second data store that PostgreSQL
row-level security does not protect. See F-03.

---

## 3. Data flow diagram

```
                                  TB1
   ┌──────────┐   HTTPS/session cookie  ┃  ┌───────────────────────────────┐
   │ Browser  │────────────────────────►┃─►│  Next.js route handlers       │
   │ (React   │◄────────────────────────┃──│  authn → membership →         │
   │  Flow)   │   graph JSON, SSE       ┃  │  assertEntitlement → withTenant│
   └──────────┘                         ┃  └──────┬─────────┬──────────────┘
        ▲                               ┃         │         │
        │ rendered explanation          ┃    TB2  │         │  TB5
        │ (markdown — see F-06)         ┃         ▼         ▼
        │                               ┃  ┌────────────┐  ┌──────────────────┐
        │                               ┃  │ PostgreSQL │  │ api.anthropic.com│
        │                               ┃  │ RLS FORCE  │  │  (Claude)        │
        │                               ┃  │ dm_app     │  └──────────────────┘
        │                               ┃  │ NOBYPASSRLS│         ▲
        │                               ┃  └────────────┘         │ prompt: graph
        │                               ┃         ▲               │ neighbourhood +
        │                               ┃    TB4  │               │ snippets + question
        │                               ┃         │               │
        │                        ┌──────┴─────────┴───────────────┴──────┐
        │                        │  Parser worker                        │
        │                        │  acquire→discover→parse→resolve→      │
        │                        │  evaluate→build→enrich→validate→      │
        │                        │  persist→DESTROY scratch (finally)    │
        │                        └───────────────▲───────────────────────┘
        │                                   TB3  │ tarball (ATTACKER-CONTROLLED)
        │                                        │ installation token, ≤1h
        │                               ┏━━━━━━━━┷━━━━━━━━┓
        │                               ┃  api.github.com ┃
        │                               ┗━━━━━━━━━━━━━━━━━┛
        │                                        │
   ┌────┴──────────────────────────────────┐ TB6 │ webhooks (signature only)
   │ in-process source cache, ≤15 min      │◄────┘   Stripe ──────┐
   │ TB4′ — NOT covered by RLS (F-03)      │                      ▼
   └───────────────────────────────────────┘        withSystem() + SECURITY DEFINER
                                                    ↑ the only RLS-bypass path
                                                      reachable from the internet (F-02)
```

Two observations from drawing it:

1. **Every path to customer data in PostgreSQL goes through `withTenant`, except two:**
   the Stripe webhook and the retention sweep, both via `withSystem()` plus
   `SECURITY DEFINER` functions. Those two functions are the entire RLS-bypass surface of
   the product. They deserve the scrutiny of a kernel syscall. F-02.
2. **The parser worker is the most hostile position in the system.** It processes an
   attacker-supplied archive, with a live GitHub token in memory, on a filesystem shared
   with other tenants' scans. F-01, F-04, F-05.

---

## 4. STRIDE per boundary

Summary pass; each `→ F-nn` is written up in §5. Items marked ✔ are adequately specified
in TECH-SPEC v0.1 and move to my verification queue rather than to the defect list.

### TB1 — Browser → API

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **S**poofing | Session theft; tenant-cookie forgery to act in another tenant | GitHub OAuth via Auth.js; `HttpOnly`/`Secure`/`SameSite=Lax`; active-tenant cookie **validated against `tenant_members` on every request** | ✔ verify; → F-09 (no session rotation on tenant switch) |
| **T**ampering | CSRF on mutations | POST/DELETE only + Auth.js CSRF; `SameSite=Lax` blocks cross-site POST | ✔ verify |
| **R**epudiation | "I didn't delete that repository" | `audit_log`, 365 days, no customer config | ✔ verify coverage of authz decisions |
| **I**nfo disclosure | **IDOR on every `:id` route** | Three-layer isolation (§6.1) + 404-not-403 | ✔ design is strong → F-01 is the residual, F-02 the bypass |
| **D**oS | Expensive endpoints | Per-tenant limits in PostgreSQL | → **F-04** (no per-IP limit, no scan concurrency cap, fail-open risk) |
| **E**levation | `member` performing `owner` actions | Roles + `assertEntitlement` | → F-10 (role check must be function-level, not route-prefix) |

### TB2 — Application → PostgreSQL

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **T** | SQL injection | Drizzle parameterised queries; zod validation | ✔ verify, plus a CodeQL gate on raw SQL |
| **I** | A query that omits `tenant_id` | RLS `FORCE` + `NOBYPASSRLS` role + composite FKs; no exported pool; boundary test | ✔ **the strongest part of this design** → F-01 verifies it empirically |
| **E** | RLS bypass | `withSystem()` + 2 × `SECURITY DEFINER` | → **F-02 (Critical)** |

### TB3 — GitHub → parser worker

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **T** | Malicious tarball: traversal, symlinks, hardlinks, entry types | Limits during extraction; traversal and symlinks rejected | → **F-05** (hardlinks and non-regular entry types unspecified; no realpath assertion at write time) |
| **T** | Malicious HCL: local module path escapes the repository root | Depth cap 8; cycles detected; remote sources **not fetched** (good — closes SSRF) | → **F-01a (Critical)**: containment of *relative* module paths is not specified |
| **D** | Parser bomb: pathological HCL, deep nesting, huge files | Caps on files/size/nodes; total side-effect-free evaluator | ✔ verify with fuzzing → F-04 for CPU cost |
| **I** | Token leakage into diagnostics shown to the user | "never persisted, never logged, redacted from error messages" | ✔ verify with a test that asserts redaction |

### TB4 — Worker → PostgreSQL (persistence)

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **I** | Customer secret persisted in an attribute value | Secret-pattern pass at the persistence boundary (§5.9) | → **F-07** (denylist, with named realistic misses) |
| **I** | Raw IaC retained, contradicting the public promise | Narrow retention set (§4.9); scratch destroyed in `finally` + assertion | → **F-08** (claim/code gap, needs CEO wording decision) and **F-11** (`finally` does not run on SIGKILL) |

### TB5 — Application → Anthropic

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **T** | **Indirect prompt injection** from repository content | Comments stripped from snippets before egress | → **F-06** (insufficient: names, values and expressions are still attacker text; and output handling is the real wound) |
| **I** | Over-sharing customer data | Explicit sent/not-sent inventory (§8.4) | ✔ excellent; → F-12 (terms must be confirmed in writing) |
| **D** | Denial of wallet | Reserve-then-reconcile against `monthly_token_cap` | ✔ correct mechanism → F-04 for the scan-side gap |

### TB6 — Webhooks

| | Threat | Specified control | Verdict |
|---|---|---|---|
| **S** | Forged webhook granting a paid plan | Signature verification, idempotent by event id | → **F-02** (raw-body and constant-time requirements must be explicit) |
| **T** | Replay to re-trigger entitlement changes | "idempotent by event id" | ✔ verify it is a **unique constraint**, not a `SELECT` then `INSERT` race |

---

## 5. Findings

### F-01 — Cross-tenant read (IDOR) on every tenant-scoped resource

**Class:** Broken object-level authorisation (OWASP API1:2023).
**Severity: Critical. Exploitability: 3** (authenticated attacker plus one identifier) —
**but only if a control fails**; the specified design makes it unreachable.
**Blast radius:** one successful cross-tenant read on `GET /api/v1/snapshots/:id/graph`
returns a complete map of another company's infrastructure. Unbounded: every tenant.
**Status:** Design-accepted mechanism, **Open verification**. Owner: Backend Engineer
builds; I verify and the suite is mine.

I want to be straight about this one: the specified design is better than what I usually
see. Three independent mechanisms — forced RLS, a `NOBYPASSRLS` non-owner role, and
composite foreign keys that make cross-tenant rows *unrepresentable* rather than merely
unqueryable — plus no exported database handle and a boundary test. The failure mode it
does not cover is a handler that reads data **outside** `withTenant` (the cache, F-03) or
through the bypass path (F-02).

The control is not a code change; it is the proof. **The cross-tenant suite is specified
to implementable precision in §6 below**, and per the test strategy it is the one suite
CI may never skip: if it does not execute, the build fails.

**Residual risk after the control:** a cross-tenant leak through a data store that is not
PostgreSQL — the in-process cache (F-03), logs (F-13), or an error message. The route
manifest test bounds, but does not eliminate, the risk of a new unenumerated route.

---

### F-01a — Relative module path may escape the scan root, reaching another tenant's scan directory

**Class:** Path traversal → cross-tenant information disclosure (bypasses RLS entirely by
not involving the database).
**Severity: Critical. Exploitability: 3.**
**Status: Open.** Owner: Backend Engineer. **This finding is the reason to threat-model
before implementation.**

Spec §5.4: *"`module "x" { source = "./modules/x" }` with a relative path inside the
repository is followed"*. The containment check that enforces "inside the repository" is
not specified. Scratch directories are siblings: `${SCAN_SCRATCH_ROOT}/${scanId}`.

**Attack path.** The attacker signs up for the free tier (no payment, no review), connects
a repository they control, and commits a module block whose `source` is a relative path
with enough upward traversal to leave their own scan root and descend into a sibling scan
directory — which, if another tenant's scan is concurrently in flight on the same worker,
contains that tenant's extracted repository. The parser then parses those files and builds
them into **the attacker's graph**, which the attacker reads back through the normal API
and sees rendered on their own canvas. Row-level security is never consulted, because the
data never came from the database.

I am deliberately not writing the literal payload string here, per disclosure discipline.
The shape above is sufficient for the owning engineer to write the fix and the test.

Secondary variants: an absolute path; a `file://` source; a path escaping into the worker's
own filesystem to probe for files whose existence is then disclosed through the file
manifest or a diagnostic.

**Concrete fix** (all four, they are cheap):

1. Resolve every candidate module directory with `fs.realpath`, then assert the result is
   the scan root or a descendant of it — compare on path segments after normalisation, not
   with `String.startsWith`, which `/scan_1` vs `/scan_10` defeats. Reject with
   `MODULE_PATH_ESCAPES_REPO`.
2. Reject any `source` that is absolute, is a URI with a scheme, or contains a null byte.
3. Give each scan its own mount namespace or `chroot`-equivalent where the platform allows
   it; failing that, **make scan directories non-siblings**: mount the per-scan tmpfs at
   `${SCAN_SCRATCH_ROOT}/${scanId}` so traversal above it leaves the filesystem.
4. Run one scan per worker process, so there is no concurrent sibling to reach.

**Regression test:** a fixture repository whose module source attempts the escape; assert
the diagnostic code, assert the graph contains no node sourced outside the scan root, and
assert a canary file planted in a sibling directory never appears in the resulting graph
or manifest. The canary assertion is the real oracle — the diagnostic alone could pass
while a different variant still reads the file.

**Residual risk after the fix:** a TOCTOU race between `realpath` and open. Mitigated by
(3) and (4), which remove the valuable target rather than winning the race.

---

### F-02 — `SECURITY DEFINER` functions without a pinned `search_path`, on the only internet-reachable RLS-bypass path

**Class:** Elevation of privilege (PostgreSQL `SECURITY DEFINER` search-path hijack),
reached through an unauthenticated endpoint.
**Severity: Critical. Exploitability: 2** (needs a forged Stripe signature or a second
flaw to reach the function with controlled input).
**Status: Open.** Owner: Backend Engineer, with CTO sign-off on the final function bodies.

Spec §6.4 grants `withSystem()` two `SECURITY DEFINER` functions,
`resolve_tenant_by_stripe_customer` and `claim_expired_snapshots`, and correctly calls
them "the complete list of RLS-privileged code paths". Three things are unspecified, and
each is a known exploit class:

1. **No `SET search_path`.** A `SECURITY DEFINER` function without a pinned `search_path`
   resolves unqualified names using the *caller's* path. Any object the caller can create
   in an earlier schema — a table, or an operator or cast that shadows a built-in — is
   executed with the definer's privileges. The definer here owns the tables and is
   presumably `BYPASSRLS`-capable, so this is a full tenant-isolation bypass.
   **Fix:** every such function gets `SET search_path = pg_catalog` and
   schema-qualifies every object reference. Additionally `REVOKE CREATE ON SCHEMA public
   FROM dm_app` and `FROM PUBLIC`, so `dm_app` cannot create the shadowing object at all.
2. **No `REVOKE EXECUTE ... FROM PUBLIC`.** PostgreSQL grants `EXECUTE` to `PUBLIC` on new
   functions by default. **Fix:** `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC;` then
   `GRANT EXECUTE … TO dm_app;` and a migration test that asserts the ACL.
3. **Signature verification details.** `resolve_tenant_by_stripe_customer` takes an
   attacker-influenced string from the webhook body. Its safety rests entirely on
   signature verification happening first and correctly. **Fix, stated explicitly in the
   spec:** verify against the **raw request body** before any JSON parsing (Next.js route
   handlers must read `await req.text()`; a framework that re-serialises the body breaks
   HMAC and this is a bug shipped regularly), use Stripe's constant-time verifier, enforce
   the timestamp tolerance to stop replay, and make idempotency a **unique constraint on
   the Stripe event id** rather than a check-then-insert that two concurrent deliveries
   both pass.

Also: `resolve_tenant_by_stripe_customer` must return **only** a tenant id, never a row,
and `claim_expired_snapshots` must take no caller-supplied argument.

**Residual risk after the fix:** the functions remain the bypass path, so any change to
them requires security review. I am adding "touches a `SECURITY DEFINER` function" to the
mandatory-review list in the SDLC policy.

---

### F-03 — The 15-minute in-process source cache is a data store that row-level security does not protect

**Class:** Broken object-level authorisation via a cache layer; failure of complete
mediation.
**Severity: Critical** (cross-tenant disclosure of raw customer configuration).
**Exploitability: 2–3**, depending entirely on the cache key — which is why it must be
specified now rather than chosen by whoever writes the function.
**Status: Open.** Owner: Backend Engineer.

Spec §4.9: re-fetched source is *"held in memory for the request, cached for at most 15
minutes in-process"*. Every other read path in this product is mediated by RLS. This one
is a plain object in process memory, and the security property reduces to the cache key:

- keyed `(path, blobSha)` → content-addressed; two tenants sharing an entry share
  *identical bytes*, so disclosure is limited, **but** a cache hit reveals that another
  tenant has a file with that exact content, and it skips the GitHub permission check
  entirely — a tenant who lost repository access keeps reading for 15 minutes;
- keyed `(snapshotId, path)` → **cross-tenant read** for anyone who learns a snapshot id,
  with no database query to be caught by RLS;
- keyed `(tenantId, snapshotId, path, blobSha)` and re-checked on read → safe.

**Concrete fix:** key on `(tenantId, snapshotId, path, blobSha)`; on every cache hit
re-assert `entry.tenantId === session.tenantId` before returning (complete mediation —
check every access every time, not just on insert); bound the cache by entry count and
total bytes to stop it becoming a memory-exhaustion vector; and make it a per-request
memo with a 15-minute cross-request tier only if the Backend spike proves the GitHub API
latency warrants it. **Secure default: no cross-request cache at launch.** The GitHub call
costs a few hundred milliseconds; a cross-tenant leak costs the company.

**Regression test:** tenant A warms the cache for a file; tenant B requests the same
`(snapshotId, path)`; assert 404 and assert — by instrumenting the GitHub client — that
B's request produced its own authorised fetch rather than a cache hit.

**Residual risk:** source text still resides in process memory for the request's duration;
a heap dump or an in-process RCE discloses it. Accepted — inherent to the feature. Control
is to keep the worker and web process surfaces minimal and never write heap dumps to disk.

---

### F-04 — Denial of wallet and denial of service on the scan path; rate limiting may fail open

**Class:** Unrestricted resource consumption (OWASP API4:2023).
**Severity: High** (the entire infrastructure budget is GBP 60/month, so compute
exhaustion is also a financial loss). **Exploitability: 4** (free-tier self-signup).
**Status: Open.** Owner: Backend Engineer; limits numbers from Product (AIS-2).

The AI side is well handled: reserve-then-reconcile against `monthly_token_cap` is the
correct mechanism, and the free tier spending the customer's own key moves that cost off
our books. The gaps are elsewhere.

1. **Scans are the expensive endpoint, and the limit is only 10/hour per tenant.** Each
   scan may extract 250 MB and parse 500 files — CPU and I/O, not tokens. Ten per hour,
   with no concurrency cap, lets one free account saturate the worker and starve paying
   customers. **Fix:** cap in-flight scans at **1 per tenant** and set a global worker
   concurrency cap; add a per-tenant monthly **scan-minutes** entitlement alongside the
   token cap; enforce a hard wall-clock timeout per scan stage with the scratch directory
   destroyed on timeout.
2. **No per-IP or per-identity limit on sign-in and on tenant creation.** Per-tenant
   limits are useless against an attacker who creates tenants. **Fix:** per-IP limits on
   the auth endpoints, and a per-GitHub-account cap on tenants created per day. Three
   different limits — per-IP, per-user, per-tenant — because they stop three different
   attacks.
3. **Fail-open risk.** Limits live in PostgreSQL. If the counter read throws or the
   transaction cannot be obtained, the request must be **rejected**, not allowed through.
   **Fix:** the limiter returns `allow` only on an affirmative successful check; wrap it so
   any exception yields `429`/`503`. **Test:** inject a limiter failure and assert the
   request is refused — fail securely is a property you prove by breaking the dependency,
   not by reading the code.
4. **Free tier accepts a customer API key that we then spend.** A hostile actor could
   supply a *stolen* Anthropic key, making us the engine of someone else's fraud. **Fix:**
   validate the key with a minimal call at entry, show the tenant their own usage, cap
   free-tier request volume regardless of whose key it is, and keep the key's masked
   suffix and `last_used_at` visible so the owner can audit.

**Residual risk:** a distributed attacker across many IPs and GitHub accounts. Accepted at
launch; the mitigation is the global worker cap, which converts an unbounded bill into
degraded service, plus a spend alert to the CEO. **I recommend a hard monthly spend cap
configured at the Anthropic and hosting level, outside the application** — a cap enforced
by code that an attacker is attacking is not a cap. That is a CEO action.

---

### F-05 — Archive extraction: hardlinks and non-regular entry types unspecified; containment not asserted at write time

**Class:** Path traversal / arbitrary file write in the parser worker (zip-slip family).
**Severity: High** (arbitrary write in the worker is a credible path to code execution,
and the worker holds GitHub installation tokens). **Exploitability: 3.**
**Status:** Partially design-accepted — the spec is already better than most. Owner:
Backend Engineer.

Spec §5.1 enforces limits **during** extraction and rejects "path traversal and symlinks
outright". Good, and unusually explicit. What is not stated:

- **Hardlinks.** A tar hardlink entry can reference a path outside the extraction root;
  many extractors handle symlinks and forget hardlinks. Reject them.
- **Entry types.** Allowlist `REGTYPE`/`AREGTYPE` and `DIRTYPE`; reject character and
  block devices, FIFOs, and the GNU `L`/`K` long-name extensions, which have historically
  been used to smuggle paths past a check.
- **Unicode and case-folding differentials.** Two entries differing only by NFC/NFD
  normalisation or by case collide on some filesystems, letting a later entry overwrite a
  path that was validated earlier. Reject a second entry that resolves to an
  already-written path.
- **The check must be at write time, on the resolved path.** Validating the entry name
  before resolution is the classic parser differential: the name you checked and the path
  you wrote are not the same string. Assert `realpath(dirname(target))` is under the scan
  root immediately before opening the file.
- **Decompression ratio.** The spec caps compressed and uncompressed size independently,
  which bounds the bomb — note explicitly that the uncompressed counter must be enforced
  *as bytes are written*, with the stream aborted mid-entry, not checked per entry.

**Fix:** use a maintained, well-reviewed extractor configured to its strictest mode rather
than hand-rolling, plus the write-time `realpath` assertion as defence in depth. Run the
worker as a non-root user with a read-only root filesystem and only the scan tmpfs
writable — then an escape writes nowhere useful. Least privilege does the work that
input validation might miss.

**Regression test:** a committed corpus of hostile archives (traversal, symlink, hardlink,
device entry, duplicate-path, unicode collision, ratio bomb), each asserting a specific
rejection diagnostic **and** that no file exists outside the scan root afterwards.

---

### F-06 — Indirect prompt injection, and the exfiltration channel in rendered model output

**Class:** LLM01 prompt injection (indirect) + LLM02 insecure output handling.
**Severity: High. Exploitability: 4** (the attacker only needs to control text in a
repository that we parse — which is the product's entire input).
**Status: Open.** Owner: AI Engineer for the prompt and grounding side, Frontend Engineer
for output rendering, me for the adversarial fixtures. Fixtures `tf-injection` and
`holdout/tf-injection-b` already exist in `eval/fixtures/`.

Repository content is untrusted input and must never be treated as instruction. Stripping
comments before egress (§8.4) removes the most *comfortable* injection vector but not the
others: **resource local names, attribute keys, attribute string values, and normalized
expression strings all cross TB5 and are all attacker-authored.** A resource can be named
to read as an instruction; a tag value can hold a paragraph of text.

Two distinct harms, and the second is the one that actually hurts:

1. **Steering.** The model is induced to misdescribe infrastructure, omit a
   publicly-exposed resource, or claim a security group is restrictive when it is not.
   Against our own tenant this is self-harm, so the real victim is a customer who connects
   a repository containing a vendored third-party module — a realistic supply-chain path.
   **Control:** structural separation — repository-derived content goes in a clearly
   delimited data block with an instruction that content inside it is data, never
   commands; the system prompt is never assembled from tenant data; and the **grounding
   gate is the backstop** — every citation must resolve to a real file and line, so an
   injected claim with no source reference fails the gate before the user sees it. Per the
   test strategy, a grounding failure is a build failure, not a quality note.
2. **Exfiltration through rendered output.** If the explanation is rendered as markdown
   with images and arbitrary links, a successful injection emits an image whose URL
   carries data in its query string; the victim's browser fetches it and the data leaves.
   No further attacker interaction needed. This also covers any raw HTML passthrough →
   stored XSS in a page that is already authenticated.
   **Control (the important one):** render model output through a restricted renderer —
   no raw HTML, **no images**, no autolinking; permit only `[[node:…]]` and
   `[[src:path:line]]` citation tokens, which the client resolves to internal navigation
   rather than URLs; anything else renders as inert text. Enforce with a CSP that makes the
   whole class impossible even if the renderer regresses: nonce-based `script-src`, no
   `unsafe-inline`, `img-src 'self' data:`, `connect-src` limited to our own origin,
   `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.

**Oracle for the test:** for each injection fixture, the expected output is defined by
what must **not** happen — no tool or instruction compliance, no citation to a file that
does not contain the claim, no `img`/`script`/external-link node in the rendered DOM. The
held-out fixture `tf-injection-b` is sealed so the AI Engineer cannot tune against it;
measuring injection resistance on the fixture someone tuned against measures nothing.

**Residual risk:** a novel injection the fixtures do not cover. Bounded by the output
restrictions in (2), which remove the exfiltration channel regardless of whether the
injection succeeds. That is defence in depth: assume the model can be steered, and make
steering not pay.

---

### F-07 — Secret redaction is a denylist, and the realistic misses are nameable

**Class:** Sensitive information disclosure (secret persisted to our database and egressed
to the AI provider).
**Severity: High. Accident likelihood: High** — this needs no attacker at all, only a
customer whose repository contains a hardcoded credential, which is common.
**Exploitability as an attack: 2.**
**Status: Open.** Owner: Backend Engineer owns `redact.ts`; I own the corpus test.

Spec §8.5 is a good denylist — key-name patterns, AWS/GitHub/Stripe/Slack/JWT/PEM
shapes, entropy threshold, and `sensitive = true` propagation — applied at both the
persistence and egress boundaries from a single module, which is the right architecture.
The documented asymmetry (a false positive costs a displayed value, a false negative costs
a credential) is exactly the right instinct.

But allowlist beats denylist, and these are the misses I expect in real Terraform:

- **Connection strings.** `postgres://admin:hunter2@db.internal:5432/app` — the key is
  `connection_string`, `database_url`, or `*_dsn`, matching none of the key patterns; the
  password is low-entropy and short, defeating the entropy rule. **Fix:** a URI pattern
  matching `scheme://user:password@host` and redacting the userinfo component.
- **`user_data`, `metadata_startup_script`, `provisioner` inline scripts.** Arbitrary
  shell that routinely contains credentials. Low entropy, innocuous key name. **Fix:**
  treat these keys as sensitive-by-name and never retain or egress their values; offer the
  snippet-on-demand path instead, which at least keeps it out of the database.
- **Long opaque strings generally.** **Fix — the allowlist half:** any string value longer
  than 256 characters whose key is not on a known-benign allowlist (`description`, `arn`,
  `policy` with a JSON-shape check, etc.) is stored as `{v:"omitted", why:"oversized"}`
  with the fetch-on-demand affordance. Length is a better proxy for risk than entropy.
- **Base64 of a short secret**, and **split secrets** assembled by interpolation across
  two attributes. Hard; accept, and state it.
- **`tags` and `environment`/`env` maps**, where key names are customer-chosen and
  arbitrary.

**Fix summary:** add the URI-userinfo pattern, the sensitive-by-name key list for script
and connection attributes, and the oversized-value allowlist rule. Keep the single shared
module.

**Test (mine, and it is the oracle that matters):** a committed corpus of
redaction cases — each a key/value pair with the expected classification — run as a unit
test, **plus** a crafted fixture repository containing planted non-secret canary strings
in each of the shapes above; assert that after a scan no canary appears in `graph_nodes`,
in any log line, or in the captured Anthropic request body. Canaries, not real secrets, so
the fixture is safe to commit — this is how I test the claim without putting a credential
in the repository.

**Residual risk:** redaction is best-effort and will miss novel shapes. Therefore it must
not be the only control: the customer-facing documentation must say plainly that we read
the repository and that hardcoded secrets should be removed from IaC regardless, and the
product should **surface detected hardcoded secrets to the customer as a finding** — which
turns a liability into a feature. Product (AIS-2) to consider; not launch-blocking.

---

### F-08 — The public non-retention promise is broader than what the code will do

**Class:** Integrity of a public data-handling claim (and, if it reaches marketing copy
unqualified, a consumer-protection and contractual exposure).
**Severity: High** (trust is the product's most fragile asset; a provably false public
claim is unrecoverable). **Exploitability: n/a** — this is not an attack, it is a true
statement we would be making falsely.
**Status: Open — needs a CEO/product-owner wording decision, not an engineering fix.**

The approved decision reads *"raw customer IaC is not retained after parsing — graph plus
file and line references only"*. Spec §4.9 honestly discloses that the graph retains
resolved and literal attribute **values** and normalized **expression strings up to 512
characters**, and flags it as open question 8 for the CEO. The CTO was right to surface it
rather than bury it.

My position as the person who would have to certify the claim: **an attribute value is
customer configuration.** A customer reading "we do not retain your IaC" will not expect
that `instance_type = "m5.large"`, a CIDR block, or `"${var.environment}-web"` is sitting
in our database. The retention is *defensible and probably necessary* — without expression
strings an unresolved attribute cannot be explained, which removes the core product value
— but it is not what the current sentence says.

**Concrete fix — change the claim, not just the code.** Replace the blanket sentence
everywhere it appears (landing page, privacy notice, in-product copy at repository
connection) with a specific, verifiable one. Proposed wording for the CEO:

> We do not store your source files. After analysis we keep the resource graph — resource
> names and types, attribute names and values, short configuration expressions (up to 512
> characters), and the file paths and line numbers where each resource is defined. Your
> repository contents are deleted from our systems as soon as analysis finishes. When you
> view source code in the app we fetch it from GitHub at that moment and do not store it.

Every clause there is testable, which is the point.

**How it is verified — in code and in the database, as the task requires:**

*In code:*
1. A boundary test asserting that only `packages/db` writes to PostgreSQL, so there is one
   place retention can be violated.
2. A unit test on the persistence mapper asserting that no field of the persisted row type
   can carry a string longer than 512 characters other than the allowlisted ones, and that
   comment text and whole-file content have no representable path into the schema.
3. A test asserting the scratch directory is removed on every exit path — success, hard
   diagnostic, timeout, thrown exception — and that removal is **asserted**, not hoped for.

*In the database — the check that actually proves it:*
4. **The retention audit, run in CI against a real PostgreSQL after scanning the full
   fixture corpus.** Dump every text column of every table and assert:
   (a) no value exceeds 512 characters except in the explicitly allowlisted
   `(table, column)` pairs; (b) no value contains a Terraform comment marker followed by
   prose, or a heredoc delimiter, or three or more consecutive newlines — the fingerprints
   of retained contiguous source; (c) for each fixture file, no stored value is a
   substring of that file longer than 512 characters; (d) planted canary comments from the
   fixtures appear **nowhere**. A new column that breaks the promise fails the build the
   day it is added, which is the only way this stays true after launch.
5. A `pg_stat` / table-size assertion that the ratio of stored bytes to repository bytes
   stays far below 1 — a blunt but effective tripwire for "someone started storing files".

**Residual risk:** expression strings remain customer configuration under the revised
wording, now disclosed. And this is a promise about *our* systems only — Anthropic
receives source snippets by design (F-12), which the privacy notice must state separately.

---

### F-09 — No session rotation on tenant switch or role change

**Class:** Authentication failure (session fixation across a privilege boundary).
**Severity: Medium. Exploitability: 2. Status: Open.** Owner: Backend Engineer.

The active tenant is a cookie validated against `tenant_members` per request, which is the
right design and prevents the obvious forgery. But a session identifier that survives a
privilege change is a stale-authorisation risk: a user removed from a tenant, or demoted
from `owner` to `member`, should not continue on the same session with cached claims.
Because membership is re-validated every request, the exposure is small — hence Medium.

**Fix:** rotate the session identifier on tenant switch and on any role change; carry no
role or entitlement in the cookie or token (re-read per request — the spec already implies
this); on member removal, invalidate that user's sessions for that tenant.
**Test:** user in tenants A and B switches to B, is removed from B by an owner in another
session, then replays the original request — assert 403.

---

### F-10 — Role enforcement must be function-level, not route-prefix-level

**Class:** Broken function-level authorisation (OWASP API5:2023).
**Severity: High** (a `member` performing an `owner` action — delete tenant, change
billing). **Exploitability: 4** if missed, since it needs only a direct call to the
endpoint. **Status: Open.** Owner: Backend Engineer.

Roles are defined (`owner` / `admin` / `member`) and `assertEntitlement` exists for *plan*
capabilities, but the spec does not state where the **role** check lives. Middleware keyed
on a path prefix is the classic miss: one handler added outside the prefix is
unauthenticated-by-omission, and deny-by-default is lost.

**Fix:** a single `assertRole(tenantId, userId, minimumRole)` called inside every handler
that requires more than `member`, co-located with `assertEntitlement`; plus the route
manifest test from the test strategy extended so that **every route file must declare its
required role**, and a route that declares none fails the build. Deny by default, enforced
by the build rather than by reviewer attention.
**Test:** for every route in the manifest, call it as each of the three roles and assert
the status matrix. Table-driven, so a new route without a matrix row fails.

---

### F-11 — The scratch-directory `finally` does not run on SIGKILL, OOM, or host loss

**Class:** Data retention failure — directly undermines the public promise in F-08.
**Severity: Medium. Exploitability: 1** (needs to induce a worker kill; an OOM from a
large repository is reachable, and OOM is the likely cause in practice anyway).
**Status: Open.** Owner: Backend Engineer / CTO for the deployment detail.

Spec §5.9 destroys the scratch directory in a `finally` and asserts its removal, with a
`SCRATCH_CLEANUP_FAILED` alert. Correct, and the alerting instinct is right. But a
`finally` block does not execute when the process receives `SIGKILL`, is OOM-killed, or
when the host disappears — and an OOM kill is a realistic outcome of parsing a hostile
250 MB repository, which is F-04's attack.

**Fix:** (a) put `SCAN_SCRATCH_ROOT` on **tmpfs** so a restart guarantees loss — the spec
says "tmpfs where available"; make it mandatory and fail at startup if the path is not a
tmpfs mount, because "where available" is how a promise quietly becomes untrue in one
environment; (b) a boot-time sweep that deletes everything under the scratch root before
accepting work; (c) a periodic sweep deleting any directory older than the maximum scan
wall-clock, alerting if it finds one; (d) a SIGTERM handler for the graceful path.
**Test:** start a scan, `SIGKILL` the worker mid-parse, restart, assert the directory is
gone and that the sweep logged it. This is the kind of test that only exists if someone
writes it deliberately.

---

### F-12 — Anthropic commercial terms are assumed, not confirmed; and the free tier's egress needs explicit consent

**Class:** Third-party data processing / unsafe consumption of APIs; UK GDPR processor
obligation.
**Severity: High** (a false public statement about where customer data goes).
**Exploitability: n/a. Status: Open — mine, and it is a launch blocker.**

Spec §8.4 correctly refuses to assume: data-retention options and the "API inputs are not
used for training" position are *to be confirmed in writing by QA & Security*. I accept
that action. Until it is confirmed in writing and filed, we cannot make a public statement
about it. I will obtain and archive the terms and the retention position, and record the
answer on this task; open question 7 is mine to close. **Zero-data-retention is normally a
commercial arrangement — if it costs money, it is a CEO decision, not mine.**

**Free tier, separately:** the customer's own key means their data leaves under *their*
agreement with Anthropic, and we are the one sending it. That must be disclosed at the
point they enter the key, with an explicit acknowledgement — not buried in a privacy
notice. **Fix:** a consent checkbox at key entry naming the provider and what is sent,
with the acceptance recorded in `audit_log`.

**Residual risk:** provider terms can change. Control: a calendar review of the terms and
a subprocessor list in the privacy notice that we actually maintain.

---

### F-13 — Logging: the field allowlist is right; the enforcement point and three gaps are not specified

**Class:** Logging failure → sensitive information disclosure.
**Severity: Medium** (a secret in a log is a secret in every downstream log sink).
**Exploitability: 1. Status:** Partially design-accepted. Owner: Backend Engineer.

Spec §9.3 specifies a structured-JSON **field allowlist** with a stripping serializer —
allowlist, not denylist, which is the correct choice and I want it on record as such.

**Must never be logged** (the canonical list, for the regression test):
GitHub App private key and installation tokens; `DATA_ENCRYPTION_KEY`, `AUTH_SECRET`,
webhook secrets; platform and customer Anthropic API keys, plaintext or ciphertext;
session cookies and CSRF tokens; attribute values and expression strings; file contents and
source snippets; **customer file paths** (they leak internal project structure); prompts
and completions; email addresses and `DATABASE_URL`.

Three gaps:

1. **Exception objects bypass field allowlists.** A `pg` error carries the failing
   statement and parameters; an HTTP client error carries request headers including
   `Authorization`. **Fix:** a custom serializer for `Error` that emits only `name`,
   `code`, `supportRef` and a sanitised stack, never `cause`, `config`, `request` or
   `parameters` — and a test that throws a `pg` error with a parameterised secret and
   asserts it is absent from the output.
2. **Unhandled rejections and the framework's own request logger** are outside the
   application logger entirely. **Fix:** install the serializer at the process level and
   disable or wrap the framework's default access log; assert in a test that no log
   transport exists other than the configured one.
3. **Missing security-event coverage.** The spec lists metrics but not the security log.
   **Fix:** log authentication success and failure, tenant switch, role change, member
   add/remove, repository connect/disconnect, API key set/delete, entitlement denial,
   rate-limit rejection, every `SECURITY DEFINER` invocation, and every scratch-cleanup
   failure — with enough context to reconstruct an incident and nothing more. You cannot
   investigate what you did not record, and a 365-day `audit_log` with no authz decisions
   in it will not answer the only question an incident ever asks.

---

### F-14 — Web hardening and CSP are not specified

**Class:** Security misconfiguration. **Severity: Medium** (and it is the backstop for
F-06's exfiltration channel, which raises its real importance). **Exploitability: 3.**
**Status: Open.** Owner: Frontend Engineer.

TECH-SPEC covers cookies and CSRF but no response-header policy. **Fix** — required at
launch, asserted by a Playwright test against the deployed preview so it cannot silently
regress:

`Content-Security-Policy` with a per-request nonce, `default-src 'self'`, no
`unsafe-inline` and no `unsafe-eval`, `img-src 'self' data:`, `connect-src 'self'`,
`frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`;
`Strict-Transport-Security` with a long max-age and `includeSubDomains`;
`X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`;
a `Permissions-Policy` denying camera, microphone, geolocation and payment;
`Cross-Origin-Opener-Policy: same-origin`. CORS: **no** cross-origin access to `/api/v1`
at launch — same-origin only, never a reflected `Origin`, never `*` with credentials.
Subresource integrity on any third-party script, and ideally no third-party scripts at
all. React Flow may need a style-src accommodation; if it requires `unsafe-inline` styles
that is a dependency finding to solve with nonces or hashes, not a reason to weaken
`script-src`.

---

### F-15 — Encryption at rest: good primitives, no rotation procedure, single-key blast radius

**Class:** Cryptographic failure (operational, not algorithmic).
**Severity: Medium. Exploitability: 1. Status:** Partially design-accepted. Owner:
Backend Engineer / CTO.

The primitives are right and I have no objection to them: AES-256-GCM (AEAD), random
per-row IV, `tenant_id` as additional authenticated data — which correctly stops a
ciphertext from one tenant being replayed into another row — and a `key_version` column.
This is the design done properly.

Gaps: there is no **written rotation procedure** (a `key_version` column with no runbook
is an intention, not a capability); `DATA_ENCRYPTION_KEY` is a single env-var key, so its
compromise exposes every tenant key; and the GitHub App **private key** — the highest
value asset, A2 — is in an env var with no rotation story at all.

**Fix:** write the rotation runbook (dual-key read, single-key write, background re-wrap,
retire) and rehearse it once before launch so it is known to work; store keys in the
hosting provider's secret manager rather than a plain env var where free tiers allow it;
document the GitHub App private-key rotation path; enforce constant-time comparison for
every secret comparison (webhook signatures, any token lookup) and ban `===` on secrets in
review. Confirm TLS 1.2+ with modern ciphers at the edge.
**Test:** encrypt under v1, rotate to v2, assert v1 ciphertext still decrypts and new
writes are v2; assert a ciphertext from tenant A fails authentication when its row is
moved to tenant B — which proves the AAD binding is real and not decorative.

---

### F-16 — UK GDPR: no privacy notice, no DSAR path, no subprocessor list, no breach procedure

**Class:** Regulatory and contractual compliance.
**Severity: High** (launch blocker for a paid UK SaaS; ICO enforcement and, more
immediately, no business customer will sign without it).
**Exploitability: n/a. Status: Open — CEO owns the decisions, I own the technical
controls.**

We are the **data controller** for account data (A7: email, GitHub id, display name,
avatar, `audit_log` with user ids) and a **processor-like custodian** of repository-derived
data on behalf of the customer. Anthropic, Stripe, GitHub and the hosting provider are
**subprocessors**. Required before taking a paying customer:

1. **Lawful basis** recorded per purpose: contract (service delivery), legitimate interest
   (security logging, abuse prevention) with a balancing note, consent (free-tier
   third-party AI egress, F-12).
2. **Privacy notice** covering what we collect, why, retention, subprocessors, UK
   international-transfer basis (the UK IDTA or the UK Addendum to the EU SCCs — Anthropic,
   Stripe and most hosting are US-based), and data-subject rights.
3. **DSAR capability within one month:** access/export and erasure. The schema already
   supports it — tenant delete cascades, repository delete cascades — so the engineering
   cost is a settings-page endpoint plus a verified test, not a rebuild. **Fix:** a
   `GET /api/v1/settings/export` returning the tenant's account data and graphs, and a
   delete-my-account flow. **Test:** create a tenant, scan, delete, then assert with a
   `withSystem` query that **zero** rows bearing that `tenant_id` remain in any table —
   enumerate tables from the catalogue so a newly added table is covered automatically.
4. **Retention schedule**, enforced and tested: `audit_log` 365 days, snapshots current + 3,
   conversations until deleted. The daily sweep must be verified to actually delete, with a
   test that ages a row and asserts its removal. An unenforced retention policy is a
   liability, not a control.
5. **Breach procedure:** 72-hour ICO notification, a named decision-maker (the CEO), and a
   written template. Deciding this during an incident is how the deadline gets missed.
6. **ICO registration** (the data-protection fee) and a **DPA** offered to customers.
   Both cost money and have legal effect → CEO, with legal review. Flagging, not acting.

**Process gap I must also record:** the company has **no confidential security-advisory
route**. If a researcher or customer reports a vulnerability today it lands in a normal
issue thread, which is a disclosure incident of its own making. **Fix:** a
`SECURITY.md` with a contact address and a stated response window, plus a private channel
for triage. I will draft `SECURITY.md`; the CEO owns the contact address and the private
route.

---

### F-17 — Supply chain and the missing licence file

**Class:** Vulnerable and outdated components / integrity failures (OWASP A06, A08), plus
a non-technical legal exposure.
**Severity: High. Exploitability: n/a** — this is the one finding with no attacker in the
story. The licence gap is a legal and commercial exposure, not something that is attacked,
so an exploitability score would be a false precision. The scanning gaps it sits beside
*are* exploitability-relevant, and they score as part of F-05, F-07 and F-13 where the
attack path is concrete.
**Blast radius:** no `LICENSE` file means no granted rights and no stated reservation —
ambiguous ownership at exactly the moment a buyer, an investor, or an acquirer does
diligence. The scanning gaps mean a compromised or prohibited dependency ships unnoticed.

Full treatment in issue document `licence-plan` and `docs/LICENCE-AND-DEPENDENCY-PLAN.md`.
Recorded here so the register is complete: no `LICENSE` file (**release blocker**), no
dependency licence policy enforced in CI, no secret or dependency scanning configured yet.

**Control:** the licence gate, `gitleaks` (pre-commit and full-history CI), `pnpm audit
--prod`, `osv-scanner`, Dependabot, semgrep OSS and a CycloneDX SBOM — all free, all
specified in the licence plan §4. `licence-policy.json` and `licence-exceptions.json` are
committed as of this task; the `LICENSE` file waits on a CEO decision (licence plan §2.4).

**Residual risk after the control:** a prohibited licence introduced through a dependency
whose `package.json` declares one licence and whose source carries another — the gate reads
the declaration. Mitigated only by the new-dependency review rule, not by tooling.

---

## 6. The cross-tenant isolation suite, specified to implementable precision

This is the deliverable the task asks for by name. It is written so the Backend Engineer
can implement it without asking me a question, and so that I can run it myself to form an
independent verdict. It lives at `packages/db/test/tenancy.spec.ts` and
`apps/web/test/tenancy.api.spec.ts`, runs against a real PostgreSQL in CI (not a mock —
the control under test *is* PostgreSQL), and **CI fails if this suite does not execute.**
A skipped isolation test is indistinguishable from a passing one, and that is the
difference that ends a company.

### 6.1 Fixtures

Seeded by a helper that uses `withSystem` and raw SQL (deliberately bypassing the
application layer, so the test does not depend on the code it is testing):

- Tenant **A**: owner `alice`, repository `repo-a`, one succeeded scan, snapshot `snapA`
  with ≥ 20 nodes and ≥ 10 edges, one conversation with 2 messages, one encrypted
  `tenant_api_keys` row, one `ai_usage` row, a `file_manifest`, `diagnostics`.
- Tenant **B**: owner `bob`, the same shape, snapshot `snapB`.
- Tenant **C**: `carol` is a member of both A and C — the multi-tenancy user, who catches
  bugs that a two-tenant fixture cannot.
- `mallory`: authenticated, member of **no** tenant. Catches "authenticated therefore
  authorised".
- All identifiers captured so the tests can use **B's real ids while authenticated as A**.
  Guessing is not the threat; a leaked, logged, or shared identifier is.

### 6.2 Layer 1 — database: the predicate cannot be omitted

For **every** tenant-scoped table, enumerated from `information_schema` at runtime so a
newly added table is covered the day it appears (a hand-maintained list is a list that
goes stale):

| # | Test | Expected |
|---|---|---|
| 1 | Table has a `tenant_id uuid NOT NULL` column | pass, else fail naming the table |
| 2 | `relrowsecurity` **and** `relforcerowsecurity` are both true in `pg_class` | both true — `FORCE` is the whole mechanism; without it the owner bypasses |
| 3 | A `tenant_isolation` policy exists with both `USING` and `WITH CHECK` | present |
| 4 | `UNIQUE (tenant_id, id)` on parents; children have composite FKs including `tenant_id` | present |
| 5 | As `dm_app` under `app.tenant_id = A`, `SELECT count(*)` | counts **only** A's rows |
| 6 | Same session, `SELECT` by B's primary key | **0 rows** |
| 7 | Same session, `UPDATE` a row by B's primary key | **0 rows affected** |
| 8 | Same session, `DELETE` a row by B's primary key | **0 rows affected** |
| 9 | Same session, `INSERT` a row with `tenant_id = B` | **error** (`WITH CHECK` violation) |
| 10 | Same session, `UPDATE … SET tenant_id = B` on one of A's own rows | **error** — tenant-hopping an owned row is the subtle one |
| 11 | `INSERT` a child row referencing a parent in B | **FK violation** — proves cross-tenant rows are unrepresentable, not just unqueryable |
| 12 | **No GUC set at all**, then `SELECT`/`INSERT`/`UPDATE`/`DELETE` | 0 rows / rejected on every table. **The fail-closed property.** |
| 13 | `app.tenant_id` set to `''`, `'not-a-uuid'`, `'00000000-…'`, and a SQL-injection-shaped string | 0 rows or a clean error; never a leak, never a crash |
| 14 | `pg_roles` for `dm_app`: `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` | all **false** |
| 15 | `dm_app` owns no table; has no `GRANT` beyond `SELECT/INSERT/UPDATE/DELETE`; `PUBLIC` has no grant; `dm_app` has **no `CREATE` on schema `public`** | asserted (closes F-02's shadowing route) |
| 16 | Every `SECURITY DEFINER` function in the database is on a 2-item allowlist, each with a pinned `SET search_path` and **no** `EXECUTE` to `PUBLIC` | asserted — a third such function fails the build, which is exactly what I want to be told about |
| 17 | After `withTenant(A)` returns, the pooled connection has no residual `app.tenant_id` | `current_setting` is empty — proves `set_config(..., true)` is transaction-local and state cannot leak to the next user of the connection |
| 18 | Concurrent `withTenant(A)` and `withTenant(B)` on the same pool, interleaved reads | each sees only its own rows |

### 6.3 Layer 2 — API: IDOR on every route

Driven by the **route manifest** (the test strategy requires every route file to be
enumerated and to declare its auth and role requirements; a route missing from the
manifest fails the build). For every route taking a resource identifier, table-driven
across identities:

| Identity | Target | Expected |
|---|---|---|
| `alice` (A) | A's own resource | 200 |
| `alice` (A) | **B's real id** | **404** — not 403: existence must not be confirmable, per spec §7.1 |
| `mallory` (no tenant) | A's and B's ids | 404 (401 if unauthenticated) |
| `carol` (A and C), active tenant C | A's id | **404** — she is a member of A but her active tenant is C; the active-tenant cookie must scope the read, not merely her membership. This is the test most products fail. |
| `alice` with A's cookie but tenant header/cookie hand-edited to B | A's and B's ids | 404/403 — never B's data; the cookie is validated against `tenant_members`, so prove it |
| `alice` | malformed id, wrong-type id, another table's id of the same shape | 400 or 404, never a 500 and never a leak of internal detail |

Routes in scope at minimum: `GET /snapshots/:id/graph`, `GET /nodes/:id`,
`GET /nodes/:id/source`, `GET /snapshots/:id/source?path=`, `GET /scans/:id`,
`GET /repositories/:id`, `DELETE /repositories/:id`, conversation and message reads and
writes, `GET /billing/subscription`, `PUT /settings/api-key`, every explain endpoint.

Three specific non-obvious cases:

- **`GET /snapshots/:id/source?path=` with a path from B's manifest while authenticated as
  A** → 404. This endpoint is a file-read proxy; spec §7.6 makes the manifest the
  authority, so the manifest lookup must be tenant-scoped. Also: `path=../../etc/passwd`,
  an absolute path, and a path with a null byte → 400, never a fetch.
- **The in-process cache (F-03)** → B requests the `(snapshotId, path)` A just warmed;
  assert 404 **and** that B triggered no GitHub fetch for A's installation.
- **Explanation requests** → ask about one of B's node ids while authenticated as A;
  assert 404 **and**, by capturing the outbound request body, assert **no byte of B's
  graph reached Anthropic**. Isolation has to hold at the egress boundary too.

### 6.4 Layer 3 — property test

Generate a random sequence of legitimate operations across tenants A, B and C through the
**public application API only**, then assert the invariant after every step: for each
tenant `T`, the set of rows reachable under `withTenant(T)` equals exactly the rows created
under `T`. Shrink on failure. This catches the handler nobody thought to enumerate — the
one that is missing from the manifest *and* from my imagination.

### 6.5 Oracle

Membership is defined by the seed, which was written with `withSystem` and raw SQL.
Expected visible set for tenant `T` = exactly the rows the seed created for `T`. Any row
outside that set appearing in `T`'s result is a failure; any row inside it that is missing
is also a failure (an over-broad fix that breaks the product is still a failure). The
oracle is independent of the application code under test — which is the only reason the
test proves anything.

### 6.6 Verdict rule

Any failure in §6.2, §6.3 or §6.4 is a **release blocker**, not a defect to triage. There
is no severity discussion to have about a cross-tenant read.

---

## 7. Risk register

Severity = damage. Exploitability = 1 (hardest) to 5 (easiest). Both, deliberately, are
not multiplied into one number.

| ID | Finding | Severity | Expl. | Status | Owner |
|---|---|---|---|---|---|
| F-01 | Cross-tenant read (IDOR) — residual after a strong design | Critical | 3 | Mechanism accepted; verification **Open** | Backend / QA |
| F-01a | Relative module path escapes scan root → cross-tenant read | Critical | 3 | **Open** | Backend |
| F-02 | `SECURITY DEFINER` without pinned `search_path`; webhook raw-body and idempotency | Critical | 2 | **Open** | Backend + CTO |
| F-03 | In-process source cache is unmediated by RLS | Critical | 2–3 | **Open** | Backend |
| F-04 | Denial of wallet / DoS on scans; limiter may fail open | High | 4 | **Open** | Backend + CEO (hard spend cap) |
| F-05 | Archive extraction: hardlinks, entry types, write-time containment | High | 3 | Partial | Backend |
| F-06 | Indirect prompt injection + exfiltration via rendered output | High | 4 | **Open** | AI + Frontend + QA |
| F-07 | Redaction denylist misses connection strings, `user_data`, oversized values | High | 2 (accident: High) | **Open** | Backend + QA |
| F-08 | Public non-retention claim broader than the code | High | n/a | **Open — CEO wording** | CEO + QA |
| F-09 | No session rotation on tenant switch or role change | Medium | 2 | **Open** | Backend |
| F-10 | Role enforcement not stated as function-level | High | 4 | **Open** | Backend |
| F-11 | Scratch `finally` does not run on SIGKILL/OOM | Medium | 1 | **Open** | Backend + CTO |
| F-12 | Anthropic terms unconfirmed; free-tier egress consent | High | n/a | **Open — mine** | QA + CEO |
| F-13 | Logging: error objects, framework logger, missing security events | Medium | 1 | Partial | Backend |
| F-14 | No CSP or security response headers specified | Medium | 3 | **Open** | Frontend |
| F-15 | No key-rotation procedure; single-key blast radius | Medium | 1 | Partial | Backend + CTO |
| F-16 | UK GDPR: notice, DSAR, subprocessors, breach, no `SECURITY.md` | High | n/a | **Open — CEO** | CEO + QA |
| F-17 | No licence file; no dependency or secret scanning | High | n/a | **Open** | QA |

### Residual risks accepted at launch, written down rather than quietly carried

1. **No independent third-party penetration test.** Out of budget. This threat model and
   the automated suites are not a substitute for an adversary who is paid to care.
   Recommend one before the first enterprise customer. CEO decision.
2. **Redaction is best-effort.** F-07 reduces it; a novel secret shape will get through.
   Mitigated by customer-facing guidance and, ideally, by surfacing detected secrets.
3. **Source snippets reach Anthropic by design.** Inherent to the product. Disclosed, not
   mitigated.
4. **Prompt injection cannot be eliminated**, only made unprofitable. F-06's output
   restrictions are the real control; assume the model can be steered.
5. **No SOC 2, no ISO 27001.** Will block some enterprise deals. Not a launch blocker for
   self-serve.
6. **Single-region, free-tier hosting.** Availability and backup guarantees are weak. The
   graph is reproducible from the customer's repository, which bounds the damage; the
   irreplaceable data is accounts, subscriptions and conversations, so **verify that
   backups exist and that a restore has actually been performed once.** An untested backup
   is not a backup.
7. **Expression strings retained** under the revised F-08 wording, pending the CEO's
   decision on open question 8.

---

## 8. What I need from others

| Who | What | Why |
|---|---|---|
| **CEO** | Decide the non-retention wording (F-08) and open question 8; approve a hard out-of-band spend cap (F-04); own the GDPR items and the `SECURITY.md` contact (F-16); decide on a penetration test and on paid zero-retention if it costs money (F-12) | Legal effect, spend, and public claims are not mine to make |
| **CTO** | Fold F-01a, F-02, F-03, F-05 and F-11 into TECH-SPEC v0.2 so the implementation is built right rather than corrected later | A fix in the spec costs an hour; the same fix after M2 costs a week |
| **Backend** | F-01a, F-02, F-03, F-04, F-05, F-07, F-09, F-10, F-11, F-13, F-15 | Owns the code these live in |
| **Frontend** | F-06 output rendering, F-14 headers and CSP | Owns the render and response surface |
| **AI Engineer** | F-06 prompt structure and the grounding gate as injection backstop | Owns the prompt |
| **Product** | Consider surfacing detected hardcoded secrets as a product finding (F-07) | Turns a liability into value |

I will open a child issue per finding against the owning engineer rather than leave them in
a document nobody is assigned. **This review is complete as a verdict; the fixes are not
mine to close.**

---

## 9. Verdict

**The approved design is sound in its hardest part and incomplete in its edges.**

Forced row-level security with a `NOBYPASSRLS` non-owner role and composite foreign keys
that make cross-tenant rows unrepresentable is a better tenancy design than most funded
products ship, and the refusal to fetch remote Terraform modules closes an SSRF and
supply-chain exposure that would otherwise have been the worst thing here. The explicit
data-egress inventory and the field-allowlist logger are the work of someone who has
thought about this properly, and the CTO surfaced the retention tension (F-08) instead of
hiding it, which is why I can be brief about it.

**Four findings must be fixed in the specification before M1 implementation begins:**
F-01a (module path containment), F-02 (`SECURITY DEFINER` hardening and webhook raw-body
verification), F-03 (the cache that RLS does not cover — default to no cross-request cache),
and F-10 (function-level role enforcement). All four are cheap now and structural later.

**Three findings are launch blockers that do not belong to engineering:** F-08 (the public
wording), F-12 (Anthropic terms in writing), F-16 (UK GDPR and the missing `SECURITY.md`
and advisory route), plus F-17 (the licence file) from the companion document.

Nothing here is reachable by a real user today, because nothing is deployed and no code
exists — so there is no live exposure to escalate, and I am not treating this as an
incident. That changes the moment the first deploy happens, which is why the four
specification fixes come first.

**Release criteria are not met**, and cannot be at M0 — this document exists to define
what meeting them will require.

---

## Revision log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-11 | First threat model. STRIDE over TECH-SPEC v0.1. 18 findings; 4 pre-M1 specification fixes; cross-tenant suite specified to implementable precision. |
