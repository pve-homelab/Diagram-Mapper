# ADR-0007: Source retention boundary — persist the graph and references, re-fetch source on demand

| | |
|---|---|
| **Status** | **Accepted, with one item requiring the CEO's explicit confirmation** (expression-string retention — see Decision §4) |
| **Date** | 2026-10-11 |
| **Decider** | CTO; the retained-expressions exception is the CEO's to confirm |
| **Consulted** | QA & Security (verifies the boundary), Backend Engineer (implements), AI Engineer (consumes) |
| **Affects** | `docs/TECH-SPEC.md` §4.2, §4.9, §5.9, §5.10, §6.3, §7.6, §8.4 |
| **Reversibility** | **Expensive and asymmetric.** Retaining less later is easy. Retaining *more* later means re-scanning, and any data retained in the meantime was retained under a promise we had already made. |

## Context

The approved security constraint is: **raw customer IaC is not retained after parsing —
only the graph plus file and line references.** This is a commercial asset as much as a
security control. Diagram Mapper asks customers to point us at the repository describing
their entire production estate. "We do not keep your code" is a materially easier sentence
to get through a security review than "we store your code encrypted", and for an early
product with no compliance certifications it may be the difference between a trial and a
rejection.

The constraint is clear in intent. Implementing it honestly requires deciding the exact
boundary, because a graph derived from source code **unavoidably contains fragments of
that source code**. Resource names come from the source. Attribute keys come from the
source. An unresolved value's expression *is* source text. A boundary stated only as "no
raw IaC" is not implementable — it invites each engineer to draw their own line, and some
of those lines will be wrong.

So this ADR exists to say precisely what is kept, what is destroyed, what is re-fetched,
and — for the one genuinely debatable item — to put the question to the product owner
rather than quietly resolving it in my own favour.

The competing requirement: the node detail panel shows source code, and the explanation
engine cites `path:line` and needs snippets (ADR-0006). Both need source text at read
time, after the files are gone.

## Options considered

### Option A — Retain the repository snapshot (encrypted at rest)

Store the tarball or the parsed files, encrypted. Source display and AI snippets become
local reads: fast, always available, no dependency on a live GitHub installation.

**Cost:** storage grows with every customer and every snapshot (real money, and it scales
with success rather than revenue); the encryption key becomes the highest-value secret in
the system; a database compromise exposes complete customer infrastructure code; and it
**directly contradicts the approved constraint**, so it would require the CEO to reverse an
approved security decision.

Rejected. It also inverts the trust story the product is sold on. The one honest argument
for it is availability (see Option C's cost), and that is not enough.

### Option B — Retain only the graph, no source text at all, anywhere, ever

The purest reading. Nothing beyond nodes, edges and references.

**Cost:** £0 storage, strongest possible privacy claim.

Rejected, because taken literally it destroys the product. An `unresolved` attribute with
no `expression` is a row saying "we do not know what this is and we cannot tell you why" —
the user sees `name: unknown` with no explanation, when the truth is
`name = "${var.environment}-web"`. That truth is the single most useful thing we could tell
them. It would also mean no snippet display and no grounded citation, which is Option E of
ADR-0006 taken to its end: a box-drawing tool.

This option is why the boundary needs a written decision instead of a slogan.

### Option C — Persist graph plus references; re-fetch source on demand (chosen)

Keep the graph, the file manifest and `SourceRef`s. Destroy the files. When the UI or the
AI needs source text, fetch it from GitHub with the read-only installation token, hold it
in memory for the request, cache ≤15 minutes in-process, never write it anywhere.

**Cost:** source display and snippet-grounded chat depend on a **live** GitHub
installation. If the customer uninstalls the App, or GitHub is unreachable, the source view
degrades — the graph and attributes still render, because they are persisted. Also a
latency cost per source request, and GitHub API rate-limit consumption.

That degradation is a real product cost and I am choosing to pay it. The alternative is
Option A, and "your diagram keeps working but the source view needs your GitHub connection"
is a far better position than "we hold a copy of your infrastructure code".

### Option D — Retain hashes only, and verify rather than display

Keep content hashes so references can be validated, but never show source.

**Cost:** cheapest and most private.

Rejected: it gives up source display and AI snippets for a marginal privacy gain over
Option C, since Option C already persists no source text. The *verification* idea from
this option is adopted though — see `blobSha` in the decision, which is the good half of
Option D kept at no cost.

## Decision

Option C, with the boundary stated exhaustively rather than by principle.

### 1. Never retained, in any store, at any time

Repository tarballs; file contents; **any contiguous source snippet**; comments in any
form; `terraform plan` JSON or any value derived from it; provider lock files beyond
version strings; `.tfvars` files (only the resolved values they produce, with provenance);
git history; commit messages; branch names beyond the scanned ref.

Files matching `*.pem`, `*.key`, `*.p12`, `.env*` are **never parsed at all** — they are
excluded at discovery, so their contents never enter memory.

**Enforcement is mechanical, not procedural.** The scan scratch directory is removed
recursively in a `finally` block that runs on **every** path including failure and timeout,
and its removal is **asserted**. A failed removal raises a `SCRATCH_CLEANUP_FAILED`
**alert**, not a log line — it is the one failure in the system that breaks this promise,
so it is the one cleanup failure that pages someone. Scratch lives on tmpfs where
available, mode `0700`, under a per-scan path.

### 2. Retained

The graph as defined in ADR-0003: resource addresses, kinds, types, local names, module
paths, multiplicity, attribute **keys**, resolved and literal attribute **values**,
provenance chains, edges and edge kinds, diagnostics. Plus the **file manifest** — path,
size, line count, sha256, git blob sha, parsed flag — and `SourceRef`s.

The manifest is retained for a specific and permanent reason: it lets every `SourceRef` be
validated (path exists in the snapshot; `startLine ≤ endLine ≤ lineCount`) **without the
source files**, forever, as a cheap CI and runtime integrity check (`TECH-SPEC` §13.2).
That is how "the diagram matches the source" stays checkable after the source is gone —
**make the invariant checkable**, applied to a boundary that deliberately destroys the
evidence.

`SourceRef` carries **no `snippet` field.** Not "unused" — absent from the type, so storing
one requires a schema change and a review of this ADR.

### 3. Source text at read time

`GET /api/v1/nodes/:id/source` and `GET /api/v1/snapshots/:id/source` fetch from GitHub
with the installation token, slice the requested range plus context, return it. Held in
memory for the request, cached in-process ≤15 minutes, **never written to PostgreSQL, to
disk, or to any log**.

Two controls on that endpoint, both required:

- **`path` MUST exist in the `file_manifest` for that snapshot, and `from`/`to` MUST be
  validated against `file_manifest.line_count`.** Without this the endpoint is an
  arbitrary-file-read proxy into the customer's repository, authenticated by our
  installation token. This is the most security-sensitive endpoint in the API and the
  manifest check is what contains it.
- **`blobSha` comparison.** If the file's current blob sha differs from the `SourceRef`'s,
  the response sets `stale: true` and the UI says "this file has changed since analysis"
  rather than confidently showing lines that may now contain something else. A stale
  citation that announces itself is acceptable; a silently wrong one is not.

### 4. The one exception, and it is the CEO's to confirm

**Normalized expression strings of ≤512 characters are retained** for `partial` and
`unresolved` values — for example `"${var.environment}-web"` — with comments stripped and
truncation marked.

These **are** fragments of the customer's configuration. I am not going to describe them as
something else. They are retained because without them an unresolved attribute is
unexplainable, which removes the core product value (see Option B). The exception is
narrow: bounded length, no comments, no contiguous multi-line text, and only for values
static analysis could not resolve.

This is a deliberate, documented narrowing of "raw customer IaC is not retained", and it
is the one item in this specification that needs the **product owner's explicit
confirmation rather than my judgement**. It is raised as open question 8 in `TECH-SPEC` §16
for the M0 sign-off gate.

**If the CEO rejects it**, the consequence is concrete and I would rather state it now than
negotiate it later: `AttributeValue.unresolved` loses its `expression` field; the UI shows
"unresolved" with a `path:line` and no explanation; the user must open the source panel
(live GitHub fetch) to see what the value actually is; and the AI can no longer explain
unresolved values without a snippet fetch. That is roughly a 2-day change to
`packages/graph`, the evaluator and the panel if made **before** M1 code lands, and a
schema migration plus a full re-scan if made after. Hence: decided at the M0 gate.

### 5. Deletion and retention periods

Deleting a repository cascades its scans, snapshots, nodes, edges, manifests and
diagnostics synchronously. Deleting a tenant cascades everything tenant-scoped **and
revokes the GitHub installation**. Snapshots are capped at the current one plus the three
most recent per repository, swept daily — which bounds storage, and therefore bounds cost.
`audit_log` is retained 365 days and holds **no** customer configuration. Conversations are
retained until the customer deletes them, and a tenant owner can delete all conversations
from the settings page.

## Cost

- **Money:** this *saves* money. No source storage, no growth in storage cost with
  repository size, no high-value encryption key to manage for source data. It is one of
  the decisions that keeps the product inside £60/month as it scales.
- **Engineering:** modest — the manifest, the validated source endpoint, the asserted
  scratch destruction. All in M1.
- **Availability, permanently:** source display and snippet-grounded chat require a live
  GitHub installation. This is a recorded risk (`TECH-SPEC` §15) and an accepted,
  explicitly-communicated degradation, not a bug to be fixed later.
- **Latency:** a GitHub round trip per source request, mitigated by the ≤15-minute
  in-process cache. GitHub API rate limits become a capacity consideration.
- **What this makes harder:** offline or air-gapped operation; source-level search across a
  repository; showing source for a snapshot whose commit has been force-pushed away;
  re-parsing an old snapshot with a new parser version without re-fetching.

## Consequences

- "We do not keep your infrastructure code" is true, with one documented and bounded
  exception that is disclosed rather than buried. That sentence is a commercial asset in
  every security review the product will face.
- A database compromise exposes graph structure and short expression fragments — serious,
  but not the customer's complete infrastructure code. **Blast radius**, deliberately
  reduced at the cost of a feature.
- Source-citation integrity survives the files being gone, via the manifest and `blobSha`.
  The system can always answer "is this citation still valid?" even when it cannot answer
  "what does that line say?".
- The product degrades **visibly and explicitly** when GitHub is unavailable, rather than
  silently showing stale content. The graph keeps working.
- ADR-0006's egress table is implementable because snippets exist only transiently: what
  leaves the system is fetched for the request and then gone from our side too.
- Snapshot retention of four means storage is bounded per repository rather than growing
  without limit — cost control and privacy pointing the same direction.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| **Expression retention being acceptable** | We retained fragments of customer configuration under a promise the customer read as absolute. A trust and contract problem, not a technical one | Removing the field is ~2 days **before** M1 code lands; after launch it is a migration **plus a full re-scan** of every customer snapshot, and the data was already retained in the meantime | **CEO decision at the M0 gate** — which is precisely why this is open question 8 and not a footnote |
| Scratch destruction actually happening | Customer source persists on a worker volume after the scan. A direct breach of the stated promise, invisible unless asserted | Hours to fix; the exposure window is however long it went unnoticed | `SCRATCH_CLEANUP_FAILED` is an **alert**. The assertion-after-removal is the whole control; without it this risk has no signal at all |
| The source endpoint's manifest validation | **Arbitrary file read** from the customer's repository using our installation token. The most serious exploitable bug available in this design | Hours to fix, unbounded if exploited | QA & Security review of this endpoint plus a negative test (path outside the manifest, line beyond `line_count`). This endpoint must not ship without both |
| Live-GitHub dependency being tolerable | Customers who uninstall or restrict the App lose the source view and good explanations, and perceive the product as broken | Option A (retain source) would be weeks **and** an approved-constraint reversal | Support contacts; `stale: true` and fetch-failure rates in telemetry |
| 512 characters being enough | Long expressions are truncated, so the explanation is incomplete exactly where the configuration is most complex | Raising the cap retains more customer source — needs this ADR revisited, not just a config change | Truncation rate on the nightly public-corpus run |
| Four-snapshot retention | A customer wants history we deleted | Raising the cap is a config change; the deleted data is gone | Product feedback. Cheapest mistake here |

Two items in this table have no cheap recovery: retaining expressions without the owner's
agreement, and an unvalidated source endpoint. The first is sequenced to the M0 gate before
any code depends on it. The second is a named QA & Security review item with a required
negative test. Everything else degrades visibly, which is the property this whole boundary
was designed for.
