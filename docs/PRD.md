# Diagram Mapper — Product Requirements Document (Launch)

**Owner:** Product | **Issue:** AIS-2 | **Status:** for CEO review at the M0 sign-off gate
**Companion document:** `docs/market-research.md` (market, competitors, pricing, positioning)
**Technical authority:** `docs/TECH-SPEC.md` (CTO). Where this PRD states a limit, the spec's
engine limit wins; where it states a behaviour, this PRD wins.

---

## 1. The job to be done

Nobody wants a diagram. They want to stop being the person who does not understand the
system. The moment we are selling into is narrow and specific:

> It is day four. There is a `terraform/` directory with 62 files. Someone has asked you
> why the ALB has two target groups. You have the repo open, you have `grep`, and you have
> nobody you want to ask a fourth question to today.

Everything in this document is written against that moment. A feature that does not shorten
it does not launch.

**The product in one sentence** (positioning, see `docs/market-research.md` §5):

> Point Diagram Mapper at a Terraform repository and it draws your infrastructure, then
> explains any resource — with the file and line it came from.

---

## 2. Who this is for

### 2.1 The user we design for — "the new joiner on an unfamiliar estate"

Concretely: 1–5 years' experience, comfortable with cloud concepts, can read HCL slowly,
has **not** written this HCL. Joined a team or a client in the last 90 days. Their estate is
400–3,000 Terraform resources across 20–200 files with 5–15 modules. They are measured on
shipping something in month one, and their main obstacle is that the architecture lives in
three senior engineers' heads.

**Evidence (VERIFIED, see `docs/market-research.md` §3.1):** Terraform is used by 17.8% of
Stack Overflow Developer Survey 2025 respondents; GitHub holds 688,068 public HCL-primary
repositories; six free Terraform visualisers have accumulated 8,250+ stars and three of the
leading five have gone unmaintained. The problem is mainstream and under-served.

**Evidence I do not have:** no customer interviews, no survey of our own, no usage data.
The *persona* is reasoned from the product owner's stated goal plus the competitive
landscape. It is a hypothesis with a cheap test attached (§8, activation metrics).

### 2.2 The buyer — and why they are a different person

| Segment | Who signs | Why they sign | Launch priority |
|---|---|---|---|
| **The repo-inheritor** — contractor, consultant, freelance platform engineer | **Themselves**, on a personal card | Inherits an unfamiliar Terraform estate every few months; billing for the hours they currently spend confused; no procurement step | **Primary.** This is who the pricing page is written for |
| **The engineering manager / platform lead** | Themselves, on a team card, 3–10 seats | Onboards two or three new engineers a year and currently pays for it in senior engineers' time | **Secondary.** Team tier exists for them; no sales motion at launch |
| **The junior developer** | **Nobody.** They have no budget | They are the user, not the buyer | Designed for, never sold to |

**The finding the product owner should read:** the wider goal is tooling for junior and
rising developers. On the evidence that is the right **user** and the wrong **buyer** — the
two products aimed squarely at this job (Swimm, Lucidscale) both abandoned self-serve
pricing and went enterprise-only. Full reasoning and sources in `docs/market-research.md`
§5. The recommendation is to keep the junior as the person the product is *designed* for and
make the repo-inheritor the person the *pricing page* is written for. **This needs the
product owner's agreement, because it changes who the landing page talks to.**

---

## 3. Time to first value — the hardest requirement in this document

If a trial user cannot see **their own** infrastructure diagrammed in minutes, no amount of
pricing or copy will save the product.

| Target | Value | How it is measured |
|---|---|---|
| **TTFV-total (p50)** | **≤ 5 minutes** from landing on the marketing page to their own diagram on screen | Instrumented funnel: `page_view` → `graph_rendered`, median over rolling 7 days |
| **TTFV-total (p95)** | **≤ 10 minutes** | Same funnel, 95th percentile |
| **TTFV-scan (p95)** | **≤ 90 seconds** from clicking *Connect* to first render, for a repo of ≤ 1,000 nodes | `scan.started` → `graph_rendered`, from the scan metrics the CTO already specifies |
| **Clicks to first diagram** | **≤ 6** from landing page to rendered graph, including GitHub consent | Counted manually in the QA onboarding walkthrough |
| **Hard ceiling** | A scan that cannot finish inside the spec's **10-minute wall-clock budget** fails loudly with a named reason and a suggested next step — never a spinner | `docs/TECH-SPEC.md` §5.1 |

**Design consequences that follow and are therefore requirements, not suggestions:**

- **No credit card, no team setup, no project wizard before the first diagram.** Sign in with
  GitHub, pick one repository, see the graph.
- **The demo repository is a first-class feature, not a nice-to-have** (US-02). It is the
  only way to deliver value to someone who will not install a GitHub App on a work org on
  day one — and that is most people.
- **The scan is progressive.** The user sees named stages with counts, not a bar. Silence is
  the failure mode that kills the trial.

---

## 4. Launch feature set

Priorities: **P0** = launch blocker, the product is not shippable without it. **P1** = ship if
M3 lands on time, cut-ready with no architectural debt. **P2** = explicitly post-launch.

| # | Feature | Priority | Why this priority |
|---|---|---|---|
| F1 | Read-only GitHub App install; repository picker | **P0** | No input, no product. Read-only install is also the core trust claim |
| F2 | Terraform/HCL parse → resource graph (resources, data, modules, variables, outputs, locals, providers; edges from references, `depends_on`, and module wiring) | **P0** | The must-have. An inaccurate graph makes everything above it worthless |
| F3 | `terraform plan` JSON import as an alternative input | **P0** | Settled scope, and the only way to get a correct graph when remote modules are used (F2's biggest gap — see R1) |
| F4 | Interactive canvas: pan, zoom, fit, module grouping and collapse, node search, select | **P0** | This is the navigation layer. Without grouping, a 1,000-node graph is a hairball |
| F5 | Node detail panel: address, type, name, attributes, source `file:line`, inbound/outbound dependencies with named edge kinds | **P0** | The majority of "what is this?" questions are answered here with no AI at all, at zero marginal cost |
| F6 | Grounded explanation chat in a **movable, resizable, persistent** panel; citations rendered as clickable `file:line` chips | **P0** | The differentiator, and explicitly required by `PROMPT.md` |
| F7 | Jump-to navigation: clicking a cited resource in an answer selects and centres that node; clicking a citation opens the source at that line | **P0** | Explicitly required by `PROMPT.md`. It is what makes the diagram a navigation layer rather than a picture |
| F8 | Source viewer: the real file, the cited lines highlighted, ±10 lines of context, secrets redacted | **P0** | The grounding claim is only credible if the user can check it in one click |
| F9 | **Coverage and honesty panel**: count and list of unresolved references, unsupported remote modules, parse diagnostics, and a per-snapshot "references resolved" percentage; affected nodes badged on the canvas | **P0** | See R1. A product that silently omits half the estate is worse than one that admits the gap |
| F10 | Accounts, GitHub OAuth sign-in, tenant isolation | **P0** | Multi-tenant SaaS floor |
| F11 | Stripe subscription, plan entitlements (`repo_limit`, `node_limit`, `monthly_token_cap`), usage display, cap-reached state | **P0** | No billing, no business. Numbers in `docs/market-research.md` §4.4 |
| F12 | Free tier: customer's own Anthropic API key, stored encrypted, validated on entry, never displayed | **P0** | Settled decision; it is what makes the free tier cost us nothing |
| F13 | Secret redaction in every displayed attribute, source snippet and explanation | **P0** | Non-negotiable. One leaked credential in a screenshot ends the company |
| F14 | Onboarding: sample repository, first-run tour of the three panels, empty states that teach | **P0** | §3 is unreachable without it |
| F15 | Re-scan on demand; snapshot history with "what changed" resource-level diff between two snapshots | **P1** | Strong retention feature. Cut-ready: the snapshot model already supports it |
| F16 | **Story mode** — "Explain this environment": a guided narrative walk of the main request path | **P1** | High delight, directly from `PROMPT.md`, moderate cost. First thing to cut if M3 slips |
| F17 | Diagram export (PNG / SVG) | **P1** | Cheap, and it is how the product escapes the browser into a wiki or a slide |
| F18 | Resource owner from `CODEOWNERS` on the node panel | **P1** | Delivers a slice of `PROMPT.md`'s "which team owns it?" for roughly a day of work, with no new integration |
| F19 | Webhook-driven auto re-scan on push | **P2** | Nice; manual re-scan covers the job at launch |
| F20 | Account deletion and data export, self-serve | **P0** | Legal floor and a trust claim. Deleting a repo must delete its graph |

### 4.1 Explicitly OUT of scope for launch

This list is a commitment, not a hope. Anything here that appears in launch marketing is a
defect.

**IaC formats and inputs**
- CloudFormation, Pulumi, Bicep, Kubernetes manifests, Helm, Ansible, CDK, OpenTofu-specific syntax
- Terraform **state** files (`.tfstate`) as an input — source and plan JSON only
- GitLab, Bitbucket, Azure Repos, self-hosted Git, local folder upload
- **Remote module fetching** (registry or git-sourced modules) — see R1
- Repos above the engine limits: >500 parseable `.tf` files, >5,000 graph nodes (`docs/TECH-SPEC.md` §5.1)

**Cloud and runtime**
- Reading live cloud accounts or any cloud credential, ever, at launch
- Drift detection, cost estimation, security posture, compliance scanning, policy-as-code
- Metrics, logs, traces, deployment history, "3 deployments this week"

**Authoring**
- Editing, generating or refactoring Terraform; applying anything; visual infrastructure design
- Editing the diagram itself. The canvas is read-only; layout may be rearranged, the graph may not

**The wider `PROMPT.md` ideas** (evaluated individually in §6)
- Learning paths, levels, progress, gamification, "Duolingo for infrastructure"
- Organisational knowledge: Jira, Confluence, ADRs, PR history, SOPs, incident links
- Incident investigation and security-analyst investigation graphs
- Team ownership beyond `CODEOWNERS` (F18)

**Platform and enterprise**
- SSO/SAML, SCIM, audit log, self-hosting, on-premises, customer-managed keys, DPA/BAA workflow
- Native mobile apps. Public API and MCP server. White-labelling. Multi-repo joined graphs
- Any language other than English in the UI or in explanations

---

## 5. User stories and acceptance criteria

Every criterion below is written to be executable by an engineer and verifiable by QA.
QA & Security owns the final release definition of done; these are the product-level gates.

---

### US-01 — Connect a repository (F1, P0)
*As an engineer who has just been given a Terraform repo, I want to connect it in under a
minute without asking anyone for permissions I do not need.*

**AC:**
1. Sign-in offers GitHub OAuth only. No password field exists anywhere in the product.
2. The GitHub App install screen requests **read-only** repository contents and metadata.
   QA asserts the requested scopes include no write, no workflow and no secrets scope.
3. Given an installation on 50 repositories, the picker lists them paginated and
   searchable, and renders its first page in ≤ 1.5s (p95).
4. A repository with no `.tf` or `.tf.json` file is shown as ineligible **before** the user
   starts a scan, with the reason stated.
5. A personal access token can never be used as an auth path; no UI accepts one.
6. Disconnecting the installation revokes access and, within 60 seconds, every snapshot for
   that repository returns 404 for that tenant.

---

### US-02 — See a diagram before trusting us with a work repository (F14, P0)
*As a cautious evaluator, I want to see what this does before installing anything on my
employer's GitHub org.*

**AC:**
1. A signed-in user with zero repositories is offered a built-in sample Terraform repository
   (≥ 120 nodes, ≥ 3 modules, ≥ 2 unresolved references so the honesty panel is visible)
   on the empty state.
2. Loading the sample renders a graph in ≤ 5s (p95) and requires no GitHub App install.
3. Explanation chat works on the sample. On the free tier without a customer API key, the
   sample serves **pre-generated, pinned** answers for at least 8 seeded questions, labelled
   as examples; it never silently fails or shows a paywall as the first interaction.
4. The sample is clearly labelled as a sample and cannot be mistaken for the user's own repo.

---

### US-03 — Get an accurate graph (F2, P0) — the must-have
*As a user, I want the diagram to match the code, because a diagram I have to double-check
is worse than no diagram.*

**AC:**
1. Against the committed fixture corpus, the parser produces a graph that is **byte-identical
   to the reviewed golden snapshot** for every fixture, under the canonicalisation rules in
   `docs/TECH-SPEC.md` §13. Any diff is a build failure.
2. Every node carries a resolvable `file` path and `startLine`/`endLine` that point at the
   real block. QA samples 50 nodes per fixture; 50/50 must resolve to a block whose address
   matches the node.
3. Edges exist for: attribute references between blocks, `depends_on`, module input wiring,
   module output consumption, and provider association. Each edge kind is labelled and
   covered by at least one fixture.
4. A reference that cannot be resolved produces an `unknown_reference` node — **never a
   silently dropped edge**. Fixture `13-remote-module` asserts this.
5. **Zero invented nodes or edges**: for every fixture, every node address and every edge
   endpoint appears in the source files. Automated, not sampled.
6. Re-scanning an unchanged commit produces the same snapshot and performs no re-parse
   (idempotency assertion).

---

### US-04 — Know what the diagram is not showing me (F9, P0)
*As a user, I want to be told when the picture is incomplete, because I will base decisions
on it.*

**AC:**
1. The snapshot header shows a **references-resolved percentage** and an unresolved count,
   always visible, not behind a menu.
2. Nodes with diagnostics are visually badged on the canvas and filterable.
3. Clicking the badge opens a list of: unresolved references, unsupported remote modules
   (with the module source string), and parse diagnostics — each with file and line.
4. A repository whose references resolve below **70%** shows a prominent, non-dismissible
   banner explaining that remote modules are not fetched at launch and offering the
   `terraform plan` JSON path (US-05) as the fix.
5. No explanation is generated for an `unknown_reference` node beyond "this reference could
   not be resolved from the source in this repository, and here is why."

---

### US-05 — Use plan JSON when source alone is not enough (F3, P0)
*As a user whose repo uses registry modules, I want a path to a complete graph.*

**AC:**
1. A user can upload a `terraform show -json` plan file, up to the file-size limit, and
   receive a snapshot built from it.
2. Plan-derived snapshots are labelled as such in the UI and in the API response.
3. Resources present in plan JSON but absent from the repository source are rendered with
   no source citation and are explicitly marked "no source in this repository" — they must
   never display a fabricated `file:line`.
4. Uploading a plan file containing values matching the secret-redaction patterns results in
   those values being redacted before storage. Asserted by a fixture containing a fake
   credential in a plan output.
5. The upload is rejected with a named error if it is not valid Terraform plan JSON.

---

### US-06 — Explore a large graph without drowning (F4, P0)
*As a user with 2,000 resources, I want to find the one I care about.*

**AC:**
1. Modules render as collapsible groups, collapsed by default above 300 nodes.
2. Search by address, type and name returns matches in ≤ 300ms (p95) at 5,000 nodes, with
   match count shown; selecting a result centres and selects the node.
3. Filters for resource type, module and "has diagnostics" are combinable.
4. At 1,000 nodes the canvas sustains ≥ 30fps during pan and zoom on a 2020-or-later laptop
   (the acceptance threshold the Frontend spike AIS-5 must hit; if it cannot, the spike must
   return a level-of-detail or server-paginated approach before M2 commits).
5. Selecting a node and pressing `?` or clicking *Explain* opens the chat panel scoped to
   that node. The selection survives panel moves, resizes and a page reload.
6. Keyboard navigation reaches every node and every panel control; the full non-visual path
   (`/snapshots/:id/nodes` list plus `/nodes/:id` detail) is reachable in the UI as a
   searchable list view, per `docs/TECH-SPEC.md` §11.

---

### US-07 — Ask a question and get a grounded answer (F6, P0) — the differentiator
*As a user who does not understand a resource, I want an explanation I can verify.*

**AC:**
1. Asking about a selected node returns a streamed answer that begins rendering in ≤ 2s
   (p95) and completes in ≤ 15s (p95).
2. **Every factual claim about configuration carries a citation** to a `file:line` range in
   the customer's repository. Measured on the explanation eval set: ≥ 95% of citations
   resolve to a line range that supports the claim, scored by the rubric in
   `docs/TEST-STRATEGY.md`. **Below 95%, the launch claim in `docs/market-research.md` §5
   must change.**
3. **Zero invented resources.** For every eval answer, every resource address mentioned
   exists in the snapshot. One violation is a release blocker, not a bug.
4. When the context does not contain the answer, the response says so explicitly and names
   what it would need. Asserted by eval cases designed to be unanswerable from the context.
5. Verified facts are visually distinguished from inference. An answer containing an
   inference without a hedge fails review.
6. Answers never contain a value matching a redaction pattern. Asserted by a fixture with a
   hard-coded fake secret in a resource attribute.
7. Conversation history is scoped to the snapshot and persists across reload.
8. On the free tier with no customer API key configured, the chat shows a clear
   configuration prompt — never a generic error.

---

### US-08 — Move the explanation beside the thing it explains (F6, P0)
*As a user, I want the explanation next to the diagram, where I decide it goes.*

**AC:**
1. The chat panel can be dragged anywhere in the viewport, resized from at least two edges,
   docked left or right, minimised, and restored.
2. Position, size and dock state persist per user across sessions.
3. The panel never fully occludes the selected node: on drag release, if it covers the
   selection, the canvas pans to keep the selection visible.
4. The panel is usable at 320px width (content reflows, no horizontal scroll) and cannot be
   resized or dragged beyond the viewport.
5. Panel chrome meets WCAG 2.1 AA contrast; drag and resize are operable from the keyboard.

---

### US-09 — Follow a reference without losing my place (F7, P0)
*As a user, when an answer mentions another resource, I want to go there in one click.*

**AC:**
1. Resource addresses in answers render as interactive chips when the address exists in the
   snapshot, and as plain text when it does not.
2. Clicking a chip selects and centres that node, updates the detail panel, and leaves the
   chat history intact.
3. A back control returns to the previously selected node; history depth ≥ 10.
4. Clicking a `file:line` citation opens the source viewer at that line within 1s (p95).
5. The selected node is reflected in the URL so a view can be shared with a teammate who
   has access to the same tenant.

---

### US-10 — Check the source myself (F8, P0)
*As a user, I want to see the actual lines, because that is how I learn to stop needing this
tool.*

**AC:**
1. The viewer shows the real file content for the cited range plus ±10 lines, with the cited
   range highlighted and line numbers shown.
2. A permalink to the same lines on GitHub at the snapshot's commit SHA is offered.
3. Values matching the redaction patterns are masked in the viewer, and the mask is labelled
   as a redaction rather than silently replaced.
4. The viewer never renders a file outside the snapshot's file manifest.
5. If the file no longer exists at that commit, the viewer says so and offers a re-scan.

---

### US-11 — Subscribe, and know what I am spending (F11, P0)
*As a buyer, I want to pay, see my limits, and never receive a surprise bill.*

**AC:**
1. Stripe Checkout completes a subscription for each published tier in test mode; the
   webhook sets the tenant's plan within 30s and the entitlement change is visible in the UI
   without a re-login.
2. A usage page shows AI tokens used against the plan's `monthly_token_cap`, the reset date,
   and whether the platform key or the tenant's own key is in use.
3. Exceeding `repo_limit` or `node_limit` is refused **before** work starts, naming the limit
   and the plan that lifts it — never after a scan has run.
4. Reaching `monthly_token_cap` returns `AI_CAP_REACHED` with the reset date; the diagram,
   node panels, search and source viewer **continue to work**. QA asserts this explicitly.
5. **No metered overage exists at launch.** No code path can bill a customer more than their
   plan price.
6. Cancellation downgrades at period end, retains data, and enforces the free tier's limits
   from the next period.
7. Upgrade, downgrade, failed payment, and card update each have a tested path and a
   non-technical in-product message.

---

### US-12 — Use the free tier with my own key (F12, P0)
*As an evaluator, I want to use the real product on my own key before paying.*

**AC:**
1. The key is accepted only after a live validation call succeeds; an invalid key is rejected
   with a clear message and never stored.
2. The key is encrypted at rest (AES-256-GCM, per-row IV, tenant-scoped AAD per
   `docs/TECH-SPEC.md` §8.6) and is never returned by any endpoint, logged, or included in
   any error payload. QA greps logs and API responses for the key during an end-to-end run.
3. The UI displays only a masked suffix and `last_used_at`.
4. The key can be deleted by the user, which takes effect immediately.
5. With a valid customer key, the free tier's explanation quality is identical to paid —
   same model, same prompt, same grounding. No degraded free experience.

---

### US-13 — Trust us with the repository (F13, F20, P0)
*As someone whose Terraform is their company's attack surface, I need the data handling to be
true, not aspirational.*

**AC:**
1. After a scan completes, **no raw customer Terraform source remains** in any datastore,
   object store, cache or log. QA verifies by inspecting storage after a scan with a
   uniquely marked string in the source, and grepping for that string.
2. Stored attribute values matching the redaction patterns are stored redacted, not stored
   and masked on display.
3. Deleting a repository deletes its scans, snapshots, nodes, edges, manifests and
   diagnostics. Deleting an account deletes everything for that tenant. Both are self-serve,
   both verified by direct database inspection.
4. A self-serve export returns the user's graph data in a documented JSON format.
5. Cross-tenant access attempts on every snapshot, node and source endpoint return 404 (not
   403, which confirms existence). Covered by the tenant-isolation test suite.
6. The data-handling page states exactly what we send to the AI provider, what we retain,
   and for how long — and QA verifies each sentence against the implementation before the
   landing page goes live.

---

### US-14 — Understand the whole environment at once (F16, P1)
*As a new joiner, I want the five-minute version before I start clicking.*

**AC:**
1. "Explain this environment" produces a narrative of ≤ 600 words covering the entry point,
   the main request path, the data stores and the externally exposed surface.
2. Every resource named in the narrative is a chip that selects that node (US-09 AC1–2).
3. The narrative states its own limits: node count covered, unresolved references excluded.
4. It is generated once per snapshot and cached; regeneration is explicit and costs one
   metered request.
5. It is eval-covered for invented resources on the same zero-tolerance basis as US-07 AC3.

---

### US-15 — See what changed (F15, P1)
*As an engineer returning to a repo, I want to know what moved since last time.*

**AC:**
1. Two snapshots of the same repository can be compared, listing added, removed and modified
   resources with the attributes that changed.
2. Changed nodes are highlighted on the canvas.
3. The comparison is computed from stored graphs with no AI call and therefore no token cost.

---

## 6. Evaluation of the wider `PROMPT.md` ideas

Each idea judged on customer value, implementation cost, and risk, with a ruling. Cost is in
engineer-weeks and is my **estimate**; the CTO owns the real numbers and should correct any
of these before the M0 gate closes.

| Idea (`PROMPT.md`) | Customer value | Cost (est.) | Risk | Ruling |
|---|---|---|---|---|
| **Click a node → "what is this / why does it exist / how was it created"**, grounded in the real files | **Highest in the document.** It is the whole reason to choose us over `terraform graph` + ChatGPT | 3–4 wks (shared with F5/F8) | Hallucination destroys the only claim we have. Mitigated by zero-invented-resource gating (US-07 AC3) and the honesty panel (F9) | **LAUNCH — P0 (F6)** |
| **Movable, resizable chat/explanation panel beside the diagram** | High, and specifically requested. It is what makes the product feel like a workspace rather than a demo | 1–1.5 wks | Low. Mostly UI state | **LAUNCH — P0 (F8)** |
| **Click-through navigation between answers, nodes and source** | High. Turns the diagram into the navigation layer for everything else | 1 wk | Low | **LAUNCH — P0 (F7, F9)** |
| **"Story Mode" / "Explain this environment"** — the guided tour | Genuine delighter. Likely the thing that gets demoed and shared. Its weakness is that it is a one-time read, so it does not drive retention | 1.5–2 wks | Medium: the longest generated artefact and therefore the most hallucination-exposed. Needs its own eval set | **LAUNCH IF TIME — P1 (F16).** First cut if M3 slips |
| **"Which team owns it?"** | Moderate and constant — "who do I ask?" is the second question after "what is this?" | 0.5–1 wk if sourced from `CODEOWNERS` only; 4+ wks with a real ownership model | Low at `CODEOWNERS` scope; high if it becomes an ownership product | **LAUNCH the cheap slice — P1 (F18).** Ownership modelling is post-launch |
| **"Why is this here?" from Jira / Confluence / ADRs / PRs / incidents** — organisational memory | Potentially the most valuable idea in `PROMPT.md`. Also the most contested: **Unblocked already ships this at $29/user/mo** (`docs/market-research.md` §2.3) | 8–12 wks: three or more OAuth integrations, a second retrieval corpus, a much larger data-handling and permissions story | **High.** Triples the sensitive-data surface, triples the security review, and puts us head-on against a funded incumbent with a two-year head start | **POST-LAUNCH.** Strongest post-launch candidate *after* remote module support. Revisit once the Terraform graph is trusted — this feature is worthless on a graph the user does not already believe |
| **Recent changes / "3 deployments this week"** | Moderate | 3–5 wks (CI/CD and deployment integrations per customer) | Medium: per-customer pipeline variety means endless long tail | **POST-LAUNCH.** The cheap 80% is US-15 snapshot diff (P1), which needs no integration |
| **Learning paths / levels / "Duolingo for infrastructure"** | Appealing in a pitch. **No evidence anyone pays for it.** Swimm is the closest analogue and it went enterprise-only with no public price. It also assumes a curriculum we are not qualified to author per customer | 6–10 wks plus ongoing content | **High and insidious:** it would define us as a *training* product, sold to L&D on an annual cycle, which is a completely different company from the one we are building | **DROP for launch; do not sequence post-launch without demand evidence.** If it returns, it should return as "suggested next nodes" inside the existing canvas — days, not weeks |
| **Incident investigation / security-analyst graph** (alert → host → user → activity) | High value **to a different buyer** (SecOps), from different data (SIEM/EDR), under different compliance (often regulated) | 12+ wks, essentially a second product | **Very high.** Different buyer, different data, different compliance, different sales motion, and it would split a pre-revenue team's focus in half | **DROP.** This is a separate company. Note it in the post-launch roadmap as an explicit non-goal so it stops resurfacing |
| **"What breaks if it dies?" / blast radius** | High, and we already have the graph to compute a structural answer | 1–2 wks for dependent-closure from the graph (no AI) | Medium: **Overmind already owns pre-merge blast radius and gives one repo away free** (`docs/market-research.md` §2.1). Claiming "blast radius" invites a comparison we lose | **POST-LAUNCH as a graph query, not a claim.** F5's dependents list already answers the structural question; do not market it as blast radius |

**The cut that matters:** launch ships the *grounded explanation of a Terraform repo* and
nothing else from this list. Every idea above that is deferred is deferred because adding it
delays revenue against a £60/month budget and an unvalidated buyer. If the graph is not
trusted, none of the rest is worth building; if it is trusted, all of it gets easier to sell.

---

## 7. Known risks that are Product's to own

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| **R1** | **Remote modules are not fetched at launch** (`docs/TECH-SPEC.md` §5, risk register). Repositories that use registry or git modules — common in exactly the mature estates that most need us — will render largely as `unknown_reference` nodes. The product will look broken on its best prospects | **Severe.** This is the single largest threat to TTFV and to the "accurate graph" claim | F9 honesty panel is non-optional; the <70% banner (US-04 AC4); F3 plan-JSON path as the documented workaround; measure the unresolved ratio across a public Terraform corpus **before** M4 locks the landing-page copy; remote module support is the **first** post-launch feature. **No marketing claim of a "complete" picture** while this holds | Product + Backend |
| **R2** | Canvas performance above ~1,000 nodes is unproven (Frontend spike AIS-5) | Launch feature set may need to shed F4 capabilities, or cap `node_limit` lower than the 5,000 priced in `docs/market-research.md` §4.4 | US-06 AC4 is the explicit gate. If the spike fails, Product re-cuts the Team tier's `node_limit` and the price with it | Frontend + Product |
| **R3** | Grounding accuracy comes in below 95% | The one-sentence public claim becomes false and must be rewritten before launch | US-07 AC2 is a hard gate wired to the marketing claim. AI Engineer reports the measured score at M3; Product rewrites the claim rather than shipping it unmet | AI Engineer + Product |
| **R4** | The buyer is unvalidated — zero customer conversations exist | Pricing and positioning are reasoned, not tested | Free tier is designed to discover the buyer cheaply; sign-up asks one question ("why are you here?"); §8 activation metrics settle it in six weeks. **Ten conversations by the product owner would beat all of it** | Product owner |
| **R5** | AWS has put "explain workloads" into a first-party agent bundled with support (`docs/market-research.md` §2.4) | Long-term defensibility | Our claim must stay *repository-grounded, cloud-agnostic, no cloud credentials* — which is the one thing a hyperscaler agent will not be | Product |

---

## 8. Success metrics

Measured from launch day. Targets are **estimates** — there is no baseline — and exist so we
can be wrong in public rather than vaguely optimistic in private.

### Must-have health (the product works)

| Metric | Target | Why |
|---|---|---|
| Graph fidelity | **100%** of fixtures byte-identical to golden snapshots | US-03 AC1. A regression here is a release blocker |
| Invented resources in explanations | **0** across the eval set | US-07 AC3. Zero tolerance |
| Citation resolution rate | **≥ 95%** | US-07 AC2, and it gates the public claim |
| Scan success rate on eligible repos | **≥ 95%**, with every failure carrying a named reason | A spinner that never ends is the worst outcome |
| References resolved, median across connected repos | **Tracked from day one, no target** | This is R1's thermometer. It decides the post-launch roadmap |

### Activation (the funnel works)

| Metric | Target | Why |
|---|---|---|
| TTFV-total p50 / p95 | **≤ 5 min / ≤ 10 min** | §3 |
| Sign-up → first own-repo diagram | **≥ 60%** | Below this, onboarding or the GitHub App consent is the problem |
| Activation: diagram rendered **and** ≥ 3 explanations in the first session | **≥ 35%** of sign-ups | Three questions is where I judge the habit starts. A guess, to be recalibrated with real data |
| "Why are you here?" answer distribution | **Collected, no target** | This is the cheapest buyer-validation instrument we have (R4) |

### Commercial (someone pays)

| Metric | Target | Why |
|---|---|---|
| First paying customer | **Within 30 days of launch** | It is the only milestone in `pricinples and contraints.md` that lifts the £60/month ceiling |
| Paying customers at day 90 | **10** | Small, deliberately. 10 real customers beats a market-size slide |
| Free → paid conversion | **≥ 2%** of activated free accounts within 60 days | Below this, the free tier is too generous or the buyer is wrong |
| Gross margin per paying customer | **≥ 70%** at 100% cap consumption | Shown with arithmetic in `docs/market-research.md` §4.5 |
| Week-4 retention of paying accounts | **≥ 80%** | A comprehension tool is a one-time-value product unless US-15 and re-scan give it a reason to come back. This metric is the honest test of that |
| Median cap consumption | **Tracked; 20–60%** is healthy | Under 20% means caps are theatre and should be marketing; over 60% means repricing |

### Leading indicator to watch above all others

**Explanations per active user per week.** It is the only metric that is simultaneously the
value signal, the cost driver and the retention proxy. If it is high and retention is low,
the answers are not good enough. If it is low and retention is high, we are a diagram tool
and should price like one.

---

## 9. Open decisions for the CEO and product owner

1. **Buyer framing (§2.2).** Keep the junior as the designed-for user while writing the
   pricing page for the repo-inheritor? This changes the landing-page copy. **Product owner.**
2. **Pricing and the entitlement numbers** (`docs/market-research.md` §4.4). Needed by the
   CTO for the `plans` table. **Product owner.**
3. **The one-sentence claim and exclusion list** (`docs/market-research.md` §5), before any
   copy is written. **Product owner.**
4. **F16 Story Mode as P1** — confirm it is cuttable without renegotiation if M3 slips. **CEO.**
5. **R1 disclosure posture.** I am recommending we state the remote-module gap prominently
   in-product *and* in the public documentation, which costs conversions and buys trust.
   That is a brand decision, not a product one. **Product owner.**

---

## 10. Provenance

- **Requirements source:** `PROMPT.md`, `First_Team_outcome.md`,
  `commercial launch ready product.md`, `pricinples and contraints.md`
- **Market, competitor, pricing and positioning evidence, with links and read dates:**
  `docs/market-research.md`
- **Engine limits, data model, cost-control mechanism, security design:** `docs/TECH-SPEC.md` (CTO)
- **Test rubrics and release definition of done:** `docs/TEST-STRATEGY.md` (QA & Security)
- **Unverified in this document:** every persona claim, every effort estimate in §6, and
  every target in §8. They are labelled where they appear.
