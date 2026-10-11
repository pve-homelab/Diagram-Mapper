# ADR-0006: AI provider seam, and the egress boundary for customer configuration

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | AI Engineer (owns the implementation, AIS-6), QA & Security (**must sign off the egress boundary before the explanation engine ships**), CEO (approved Claude API and the key model) |
| **Affects** | `docs/TECH-SPEC.md` §3, §8 (whole section), §9.6, §13.6 |
| **Reversibility** | Cheap *by construction* — that is the point of the seam. Swapping providers is days behind `LlmClient`. The **egress boundary** is not cheap to reverse: data sent to a third party cannot be unsent. |

## Context

Explanations are half the product. The other half is the graph. The approved stack names
the Claude API, with an approved cost-control model: paid plans use a platform key with a
hard per-plan token cap; the free tier requires the customer's own API key.

Two things need deciding, and they are different in kind:

**First, how tightly we couple to one provider.** The AI provider is the textbook case for
**seams over abstractions**: the vendor could change for reasons entirely outside our
control — pricing, terms, availability, a materially better model elsewhere, or a
customer's procurement requiring a specific provider. The lens says put an interface where
something could change. It also says *do not abstract where nothing varies*, so the seam
must be as thin as the actual variability and no thinner.

**Second, and more consequentially: what customer data leaves our system.** This is the
one place in the architecture where customer configuration crosses our trust boundary to a
third party. My brief is explicit that a design sending raw customer configuration to a
third party without it being documented in the specification and approved **never ships**.
The specification documents it (`TECH-SPEC` §8.4); this ADR is the decision record behind
it; QA & Security signs it off before the engine ships. Those are three separate steps and
all three are required.

There is a real tension to resolve. "Explanations grounded in the real source files" means
the model must see real source. A design that sends no source text cannot produce
`path:line` citations, and citation is the product's differentiator — the vision document
is explicit that the tools which merely draw boxes teach nobody anything. So the question
is not *whether* customer configuration leaves, but **exactly what, how little, and under
whose agreement.**

## Options considered

### On provider coupling

#### Option A — Use `@anthropic-ai/sdk` directly throughout `packages/explain`

Simplest. Full access to every Anthropic feature — prompt caching, streaming, tool use,
beta headers — with no abstraction tax.

**Cost:** £0 extra. But the provider leaks into context assembly, prompt construction,
streaming, token accounting and the citation validator. A provider change then touches
five concerns instead of one, and — worse — the per-request cost cap becomes entangled
with provider-specific usage reporting.

Rejected: this is a case where something genuinely could change, so a seam is justified.

#### Option B — A third-party abstraction layer (LangChain, Vercel AI SDK, LiteLLM)

Multi-provider support, streaming helpers and retries off the shelf.

**Cost:** a large dependency tree for the framework options, an abstraction designed for
someone else's use cases, and a hard ceiling: these layers normalise to a lowest common
denominator, which is exactly where prompt caching and provider-specific cost controls
live. LangChain in particular is a substantial dependency and a fast-moving API for what
we need, which is one method.

Rejected on **boring technology**. We make one kind of call. A framework to make one kind
of call is novelty with a maintenance cost.

#### Option C — A thin in-house `LlmClient` interface over the official SDK (chosen)

One interface, one implementation, written by us, sized to our actual needs: a streaming
message call, a token count, and a usage report.

**Cost:** roughly half a day, plus the discipline of keeping provider specifics behind it.

#### Option D — Self-hosted open-weight models

No per-token cost, no data egress at all — which would make §8.4 trivial.

**Cost:** GPU hosting is an order of magnitude beyond £60/month, and quality on
"explain this Terraform resource with accurate citations" from a small self-hostable model
is well below what the product needs. Rejected on cost and quality; revisit only if
per-token economics change the business case, with its own ADR.

### On the egress boundary

#### Option E — Send the graph context only; no source text

Resource addresses, types, attribute keys and values, edges. No file contents.

**Cost:** £0, and the strongest privacy position available while still having a product.

Rejected, but narrowly and worth recording. Without snippets the model can describe
structure but cannot quote or explain the actual code, and `[[src:path:line]]` citations
become unverifiable — we would be asserting line numbers the model never saw. That is
precisely the "confident box-drawing tool" the vision rejects. Retained as the natural
**degraded mode** if a customer or a prospect's security review demands it: the product
still works with structure-only citations, at reduced quality. Recorded here so that it
is a configuration decision later rather than a redesign.

#### Option F — Send whole files for the focus node's module

Maximum context, best explanations, simplest to implement.

**Cost:** the largest egress surface and the largest token bill. A 2,000-line
`main.tf` is both expensive and mostly irrelevant to one node, and it is likely to carry
unrelated resources, comments and possibly embedded secrets.

Rejected on data-minimisation and cost grounds together.

#### Option G — Minimal bounded neighbourhood with redaction (chosen)

The focus node, a bounded 1-hop neighbourhood, and short snippets only for the nodes
actually being discussed — with redaction applied before egress and identifiers stripped.

**Cost:** context-assembly complexity (priority ordering, token measurement, snippet
re-fetch) and occasionally a worse answer because a relevant peer was dropped.

## Decision

### 1. One thin seam, `LlmClient`, in `packages/explain`

```ts
interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  countTokens(req: LlmRequest): Promise<number>;
}
```

`AnthropicClient` is the only implementation at launch, over `@anthropic-ai/sdk` (MIT).
Provider-specific concerns — model ids, beta headers, prompt caching, retry and backoff,
usage parsing — live **inside** that implementation and nowhere else. Context assembly,
prompt construction, citation validation and token accounting are provider-agnostic and
must remain so; the CI boundary test (`TECH-SPEC` §2.3) enforces that `@anthropic-ai/sdk`
is imported by exactly one file.

The seam is deliberately thin. It does **not** attempt to abstract tool use, embeddings, or
anything else we do not do. Model selection, prompt caching strategy and `max_tokens` are
the AI Engineer's levers inside the implementation, bounded by the cost contract below.

### 2. Keys and cost control (approved model, mechanism fixed here)

- **Paid tenants** use the platform key from `ANTHROPIC_API_KEY`, server-side only, never
  sent to the browser, with a hard `monthly_token_cap` per plan.
- **Free tenants MUST supply their own key**, stored in `tenant_api_keys` encrypted with
  AES-256-GCM, a random per-row IV, `tenant_id` as additional authenticated data, under
  `DATA_ENCRYPTION_KEY` with a `key_version` for rotation. Decrypted only within the
  request that uses it. Never logged, never returned by any endpoint — the UI shows only a
  masked suffix and `last_used_at`.
- **Reserve-then-reconcile.** A request reserves its measured input tokens plus
  `max_tokens` against `ai_usage(tenant_id, period_month)` **before** calling the API, then
  reconciles against actual usage on completion and releases on failure. *A cap enforced
  after the fact is not a cap* — it is a report of how much we already overspent.
- Reaching the cap returns `AI_CAP_REACHED` with the reset date. **Blast radius:** chat is
  unavailable; the diagram, node panel and search are unaffected. A cost ceiling must
  never take down the product.
- Input context is capped at **12,000 tokens**, enforced by **measurement** — peers are
  dropped by lowest edge-kind priority until the context fits. Not by estimate, not by
  hope.

### 3. The egress boundary — exactly what customer data leaves

Destination: **`api.anthropic.com`** over TLS. There is **no other third-party destination
for customer configuration data** anywhere in the system. Adding one requires a new ADR and
CEO approval.

| Sent | Not sent |
|---|---|
| Resource addresses, kinds, types, local names, module paths | Repository owner or name |
| Attribute keys, and non-sensitive literal/resolved values | Tenant id, user id, email, any account identifier |
| Normalized expression strings (≤512 chars) for unresolved values | Any value marked `sensitive` or matching a secret pattern |
| Edge list of the selected neighbourhood, with edge kinds | `terraform plan` JSON, or any value derived from it |
| Repo-relative file paths and line numbers | Whole files |
| Re-fetched source snippets: **≤40 lines each, ≤6 nodes per request**, comments stripped | GitHub tokens, API keys, Stripe data |
| The user's question and ≤6 prior turns | Other tenants' data — structurally impossible (ADR-0004) |

Four properties of that table are load-bearing and must not be eroded by a later
convenience change:

- **`SourceRef.path` is repo-relative and carries no owner or repository name**
  (`TECH-SPEC` §4.2). A leaked prompt log reveals paths, not whose paths. This is why the
  repository identity is deliberately absent from the type itself rather than merely
  omitted at call time.
- **No account identifiers are sent.** Correlating a prompt back to a customer requires
  our database.
- **Redaction runs before egress**, from `packages/explain/src/redact.ts` — the *same*
  module used at the persistence boundary (`TECH-SPEC` §5.9), so there is exactly one
  definition of "secret" in the system. Every `sensitive` and `omitted` value is dropped
  entirely, not redacted in place. Every pattern has a positive and a negative unit test;
  false positives cost a displayed value, false negatives cost a credential, and the
  asymmetry is deliberate.
- **Snippets are the minimum that supports citation**: the focus node plus at most five
  highest-priority peers, ≤40 lines each, comments stripped.

**Stated without hedging: source snippets are raw customer configuration leaving our
system.** That is inherent to "explanations grounded in the real source files" and it is
the approved product. It is recorded in the specification (§8.4), recorded here, and is
**the specific item QA & Security must sign off before the explanation engine ships.**
For free-tier tenants the data leaves under the customer's *own* API agreement, which
**must be disclosed in the UI at the point they enter their key** — not buried in terms.

Two operational commitments are **not** assumed from this document and are open questions
owned by QA & Security (AIS-7): Anthropic's commercial terms on training with API inputs,
and retention/zero-retention options available to us. If zero-retention is available it
should be enabled; the design does not depend on it.

### 4. The grounding gate — a test, not a prompt instruction

A fixed, version-controlled system prompt at `packages/explain/prompts/<version>.md` is the
**only** instruction source; context is supplied as structured JSON rather than prose, so
there is exactly one serialisation to test against. The model emits `[[node:<id>]]` and
`[[src:<path>:<line>]]` markers, and `validateCitations()` checks every marker against the
context **that was actually sent**:

- an unknown node id, or a `path:line` absent from the sent context, is an **invalid
  citation**;
- a factual assertion with no citation is an **uncited claim**.

`grounding_status` is then `grounded`, `partial` (uncited claims stripped, visible notice
shown), or **`rejected`** — invalid citations present, **the answer is not shown**, and the
user sees "I could not answer that from your configuration" with a retry.

**We would rather return nothing than return a confident invention.** Validation is
deterministic post-processing against sent context, so it holds regardless of which model
or provider sits behind `LlmClient` — which is the real reason the seam and the grounding
gate are in the same ADR. It is measured on an offline evaluation set in CI (§13.6), not
asserted here.

## Cost

- **Money:** metered Anthropic usage, capped per plan by reserve-then-reconcile; £0 for
  free-tier tenants (their key, their bill). No fixed monthly cost, so no pressure on the
  £60/month envelope. CI runs against a **recorded transcript with no API keys**, so
  verification costs nothing.
- **Engineering:** ~0.5 days for the seam; context assembly, redaction and citation
  validation are the AI Engineer's M3 work, substantial but required by the product
  regardless of provider.
- **Quality:** the 12,000-token cap and the ≤25-peer bound mean some questions get a worse
  answer because a relevant peer was dropped. Measured by the eval set, not guessed.
- **Licence:** `@anthropic-ai/sdk` is MIT. No obligation.
- **What this makes harder:** anything needing deep provider integration — tool use,
  extended thinking, embeddings — requires widening `LlmClient`, which is a reviewed change
  rather than a local one. That friction is intentional.

## Consequences

- Exactly one file in the codebase imports the Anthropic SDK, enforced in CI. A provider
  change is days, and the grounding gate, prompt contract, redaction and cost accounting
  all survive it untouched.
- There is exactly one egress destination for customer configuration, documented as a
  table, with a single redaction module shared by the persistence and egress boundaries.
  A security reviewer can audit the whole boundary by reading two files.
- Grounding is enforced by deterministic validation against sent context rather than by
  trusting the model to behave. This is what makes "explanations grounded in the real
  source" a property we can test instead of a marketing claim.
- The free tier costs us nothing in tokens, which is what makes it viable before revenue —
  but it also means free-tier explanation quality varies with the customer's own key and
  model access, and the UI must be honest about that.
- Structure-only mode (Option E) remains reachable as a configuration change for a
  privacy-sensitive customer, without a redesign.
- Self-hosting is foreclosed at launch. Fine: it is cost-prohibitive, and the seam is
  exactly what makes it reachable later.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| **The egress boundary being acceptable** | Customer configuration — or worse, a secret — is sent to a third party in a way a customer did not expect. **Data sent cannot be unsent**; this is the one irreversible item in this ADR | Not undoable. Disclosure and reputational cost | QA & Security sign-off **before the engine ships**, plus redaction unit tests on every pattern. This is why sign-off is a gate and not a review comment |
| Redaction completeness | A credential in a customer's `.tf` file reaches Anthropic. We never retain it, but we did transmit it | Hours to add the pattern; the transmission is permanent | Positive/negative tests per pattern; `*.pem`, `*.key`, `*.p12`, `.env*` are never parsed at all. Residual risk is a secret in an unusual shape, and I am naming it as residual rather than solved |
| The grounding gate being strict enough | Confidently wrong explanations about real infrastructure — the product's core claim fails, and users cannot tell | Prompt and validator iteration is days; lost trust is not recoverable per-customer | The offline eval set in CI (§13.6) and `grounding_status` rates in production telemetry. `rejected` answers are a *healthy* signal, not a defect |
| The 12k-token cap | Answers miss relevant context on large neighbourhoods; users judge the product shallow | Raising the cap is a config change, paid in tokens — days | Eval-set scores segmented by neighbourhood size |
| The seam being thin enough | A desirable provider feature does not fit, so the seam is widened or bypassed | Days; the risk is quiet bypass, not cost | Code review: any import of `@anthropic-ai/sdk` outside the one permitted file fails CI |
| Reserve-then-reconcile | AI spend exceeds the plan cap; direct margin loss, and at the extreme a budget breach | Hours to fix the accounting; the money is spent | `ai_usage` reconciliation deltas monitored; a reservation leak shows as a drifting gap |
| Anthropic availability or terms | Chat unavailable (degraded, not down — by design), or terms become unacceptable | Provider swap: days behind the seam | Error rates; QA & Security's AIS-7 terms review |

The asymmetry is the whole shape of this ADR. Provider choice is cheap to get wrong, so it
gets a half-day seam and no more. The egress boundary is **impossible** to get wrong
cheaply, so it gets an exhaustive table, a shared redaction module, a disclosure
requirement, and a QA & Security block before shipping.
