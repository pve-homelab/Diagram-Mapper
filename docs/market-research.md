# Diagram Mapper — Market, Competitor and Pricing Research

**Owner:** Product | **Issue:** AIS-2 | **Status:** recommendation, pending product-owner sign-off
**All prices read on 2026-10-11 unless a different date is stated next to the source.**

---

## 0. How to read this document

Three labels are used throughout, and they are not interchangeable:

- **VERIFIED** — I fetched the primary source (the vendor's own pricing page, the GitHub
  API, the official docs) and the figure is quoted from it. The link and read date are given.
- **SEARCH-DERIVED** — the figure came from a search result summary because the vendor's
  pricing page is JavaScript-rendered and returned no numbers to a plain fetch. Treat as
  indicative, not quotable in any public material.
- **ESTIMATE** — my arithmetic or my judgement. Not a finding. Every input is shown so the
  CEO or CTO can rerun it with different assumptions.

**What I did not do:** I spoke to no customers, prospects, competitors or analysts, and
signed up for no trial (agent policy). There is therefore **zero primary demand evidence**
in this document. Everything in §3 is indirect. That limitation is the single biggest
weakness in the commercial case and §6 names who must fix it.

---

## 1. The market in one paragraph

Terraform is the default way infrastructure is described, and the artefact it produces —
a directory of HCL — is unreadable to anyone who did not write it. There are mature,
well-funded products that draw pictures of **cloud accounts** (Cloudcraft, Hava,
Lucidscale, Firefly) and a decaying layer of free tools that draw pictures of **Terraform
graphs** (Rover, Blast Radius, InfraMap). Almost nothing reads the Terraform *source* and
**explains** it back with the file and line it came from. That gap is real. What is not
established is whether anyone pays to close it, because the people who most need the
explanation — juniors and new joiners — are not the people who hold a card.

---

## 2. Competitors and adjacent alternatives

### 2.1 Direct-ish: cloud and IaC diagram products

| Product | What it is | Public price (read 2026-10-11) | Better than our plan | Worse than our plan |
|---|---|---|---|---|
| **Hava** ([pricing](https://www.hava.io/pricing)) | Automated cloud + IaC diagrams, versioned | **VERIFIED:** Professional **$59/mo** (3 sources, 1 user, 3-month version history); Teams **$249/mo** (10 sources, unlimited users, 6 months); extra source **$15/mo**; extra retention **$30/mo**; Enterprise "Let's talk" (100+ sources, SaaS & self-hosted); 2-week free trial of the Team plan, no card | Multi-cloud live state *and* Terraform; unlimited diagrams; daily sync; diagram version history; self-hosted option; 9+ years of hardening | No explanation engine, no chat, no file/line grounding; diagram-first, not understanding-first; $59/mo for one user prices out the individual engineer and the junior entirely |
| **Cloudcraft** (Datadog) ([site](https://www.cloudcraft.co/), [Datadog pricing](https://www.datadoghq.com/pricing/)) | Live AWS/Azure/GCP/OCI/vSphere architecture diagrams | **VERIFIED:** "**Now free in Datadog**" — "Unlimited users · Unlimited diagrams" with "any Datadog subscription". Datadog Infrastructure: Pro **$15/host/mo** annual (**$18** on-demand), Enterprise **$23** (**$27**). Cloudcraft is not listed as a line item on Datadog's pricing page | Best-looking output in the category; isometric 3D; live cloud scanning; effectively free to the ~30k organisations already paying Datadog | You must be a Datadog customer — a $15/host/mo observability platform — so it is not addressable by a 5-person team, a contractor, or a learner; reads **cloud accounts, not IaC**; no source grounding; no explanations |
| **Lucidscale** (Lucid) ([pricing](https://lucid.co/pricing/lucidscale)) | Cloud visualisation inside the Lucid suite | **VERIFIED:** no price published. The Lucidscale pricing URL serves a "Contact Sales" form: "Submit the form and we'll contact you to discuss how an Enterprise Plan…". Lucidscale is not named on the page at all | Enterprise distribution through an existing Lucid footprint; model-based views and governance | Enterprise sales motion with no self-serve price; cloud-state based, not Terraform-source grounded; no grounded explanation |
| **Brainboard** ([pricing](https://www.brainboard.co/pricing)) | Visual *design* of Terraform + embedded CI/CD | **VERIFIED:** Free forever (unlimited architectures, unlimited Terraform codegen, AWS/Azure/GCP/OCI); **Pro $99 per user/mo** (or **$999/year**); Enterprise custom — and "**Import from Azure\* and AWS\***" is an Enterprise feature that "incurs separate per-resource fee"; read-only guest users free on all plans | Round-trips to real Terraform and deploys it; genuinely generous free tier; visual CI/CD | **Design-first, not comprehension-first** — importing an existing estate is gated behind Enterprise plus a per-resource fee, i.e. the exact job we do is their upsell; $99/user/mo; no explanation engine |
| **Overmind** ([pricing](https://overmind.tech/pricing)) | Terraform-plan blast radius and change risk | **VERIFIED:** Free — "Unlimited usage for one repository with full feature access — forever"; Enterprise custom, priced on prevented downtime ("Annual Revenue ÷ 525,600 minutes × 120 minutes") | Sharp wedge (pre-merge risk), LLM risk assessment, real-time dependency discovery, free tier that is hard to beat | Answers "what will this change break", not "what is this and why is it here"; no estate-wide exploration canvas for learning |
| **Firefly** ([pricing](https://www.firefly.ai/pricing)) | Cloud asset management, drift, IaC codification | **VERIFIED:** Essential **$2,499/mo** billed annually, up to 20K assets; Enterprise custom; 14-day free trial, no card, unlimited users | Enormous breadth: drift detection, policy, codification, backup/DR, compliance | Price excludes our entire market by two orders of magnitude; a governance product, not a comprehension product |
| **Pluralith** ([site](https://www.pluralith.com/), [CLI repo](https://github.com/Pluralith/pluralith-cli)) | Terraform state visualisation + auto-generated infra docs | **VERIFIED:** site advertises "**$250 / month**" for 500 CI runs and "Local Development — Free Forever"; footer reads "Copyright © 2023". **VERIFIED via GitHub API 2026-10-11:** CLI repo 860 stars, last push **2023-07-14**, not archived | Was closest in spirit to us: diagrams *plus* generated explanation/docs, in CI | **ESTIMATE/inference:** effectively dormant — three years without a commit and a 2023 copyright. This is the most important competitive datapoint in the document and it is a **negative** one (see §3.3) |

### 2.2 The IaC platform layer (where the state already lives)

| Product | Public price (read 2026-10-11) | Relevance |
|---|---|---|
| **HCP Terraform** ([pricing](https://www.hashicorp.com/en/pricing?tab=terraform)) | **VERIFIED:** Essentials "Starting at **$0.10 per month per resource**" ($0.00013/hr); Standard "**$0.47**" ($0.00064/hr); Premium "**$0.99**" ($0.00135/hr); IBM Terraform Enterprise and HCP Terraform Europe custom; "$500 credit" for new IBM HashiCorp Cloud Platform sign-ups | Not a diagram product, but it owns the state and the plan output, and per-resource pricing is the anchor customers already accept for Terraform tooling. A 500-resource estate on Standard is already ~$235/mo — context for our price points |
| **Infracost** ([pricing](https://www.infracost.io/pricing/)) | **VERIFIED:** Free ($0, "1000 free runs per month"); Starter **$250/mo** (10,000 runs); Cloud **$1,000/mo** (10 admin seats); Enterprise quote | Closest *business-model* comparable: a single-purpose Terraform add-on that monetises at platform-team budget level, not individual level. Evidence that Terraform add-ons can charge £200+/mo — but to teams, not to learners |

### 2.3 Code-understanding tools (same job, no graph)

| Product | Public price (read 2026-10-11) | Better | Worse |
|---|---|---|---|
| **Unblocked** ([pricing](https://www.getunblocked.com/pricing)) | **VERIFIED:** Platform "**$29/user/month (annual) or $35/user/month (monthly)**"; Enterprise contact; 21-day free trial, no card | Answers questions across code *and its history* — PRs, tickets, discussions; MCP into Claude/Cursor/Copilot; incognito mode | Text answers only. No graph, no canvas, no IaC awareness. The `PROMPT.md` "why does this Lambda exist?" idea is **their** product, already shipping at $29/seat |
| **Greptile** ([pricing](https://www.greptile.com/pricing)) | **VERIFIED:** Starter free ("50 credits per month", "1 active developer", unlimited repos); Pro "**$30/seat/month**" (50 credits/seat, "$1 per additional credit"); Enterprise custom; free for OSI-licensed OSS; "50% off for early-stage startups" | Credit-metered AI with transparent overage — a model worth copying; strong free tier | Review/Q&A oriented, not visual, not IaC-aware |
| **Sourcegraph** ([pricing](https://sourcegraph.com/pricing)) | **VERIFIED:** Enterprise "Starting at **$16K**" annual minimum contract; no self-serve tier shown | Code search at enterprise scale | $16k floor; no diagrams; enterprise-only |
| **Swimm** ([pricing](https://swimm.io/pricing/)) | **VERIFIED:** no price published — "Pricing is based on the number of lines of code you want to understand." Contact sales | Purpose-built for onboarding documentation — the closest *positioning* to "help juniors understand" | No public price, no self-serve, no graph. Also evidence that "onboarding comprehension" sells enterprise-only |

### 2.4 Cloud-provider native, and a warning

- **VERIFIED (AWS docs, read 2026-10-11, page generated 2026-10-09):** *Workload Discovery on
  AWS* — the free, self-deployed AWS solution that drew architecture diagrams from live
  accounts — carries a "**Notice of discontinuation**": "This AWS Solution is no longer
  available." AWS now directs customers to **Amazon CloudWatch Application Map** and **AWS
  DevOps Agent** to "discover, visualize, and **explain** workloads on AWS."
  ([source](https://docs.aws.amazon.com/solutions/workload-discovery-on-aws/))
- **VERIFIED ([AWS DevOps Agent](https://aws.amazon.com/devops-agent/), read 2026-10-11):**
  the agent "reviews code for release readiness", "autonomously investigates incidents,
  provides root cause analysis and mitigation steps", "spans software change and operations
  across AWS, multicloud, and on-prem", and integrates GitHub/GitLab/Azure DevOps plus
  CloudWatch/Datadog/Grafana/New Relic/Splunk. **No public per-unit price**; the page says
  "DevOps Agent credits are included with your AWS Support plan". The page does **not**
  claim IaC visualisation.
- **Why this matters (my read, ESTIMATE):** a hyperscaler has just put the verb "explain"
  into its first-party roadmap and bundles it with support. Our defensibility cannot be
  "AI explains your infrastructure". It has to be *grounded in the repository you control,
  across any cloud, for someone who is not an AWS account admin*. That is a narrower and
  more durable claim.

### 2.5 "Read the HCL and draw it on a whiteboard" — the real competitor

This is what we actually have to beat, and it is free.

| Alternative | Price | Evidence |
|---|---|---|
| `terraform graph` (built in) | £0 | **VERIFIED** ([docs](https://developer.hashicorp.com/terraform/cli/commands/graph)): emits DOT, "a simplified graph which describes only the dependency ordering of the resources"; more detail "at the expense of also exposing some of the implementation details of the Terraform language runtime" |
| **Rover** | £0, MPL | **VERIFIED GitHub API 2026-10-11:** 3,345 stars, last push **2025-07-30** |
| **Blast Radius** | £0 | **VERIFIED:** 2,193 stars, last push **2024-08-14** |
| **InfraMap** | £0 | **VERIFIED:** 2,073 stars, last push **2026-04-23** (actively maintained) |
| **tf-summarize** | £0 | **VERIFIED:** 740 stars, last push 2026-03-20 |
| **terraform-visual** | £0 | **VERIFIED:** 675 stars, last push 2026-10-08 |
| draw.io / diagrams.net, Excalidraw | £0 | Free, no trust barrier, no data egress, infinitely flexible |
| **Lucidchart** ([pricing](https://lucid.app/pricing/lucidchart)) | **SEARCH-DERIVED, NOT VERIFIED:** Individual ~$9/mo, Team ~$10/user/mo billed annually, free tier limited to 3 editable documents / 75 shapes. The pricing page is JS-rendered and returned no figures to a direct fetch; these came from a search summary and **must not be quoted publicly** | Already bought by most companies |

**What they do better:** free, instant, local, nothing leaves the laptop, and a whiteboard
can represent things Terraform does not (intent, data flow, people).
**What they do worse:** none of them explains anything; the hand-drawn ones are wrong
within a sprint; the generated ones are hairballs above ~100 resources and three of the
five leading free tools have gone quiet.

---

## 3. Demand evidence

### 3.1 Strong signals (VERIFIED)

1. **The corpus exists and is enormous.** GitHub Search API, read 2026-10-11:
   **688,068** public repositories with **HCL** as the primary language; **42,564** repos
   tagged `terraform`. (`GET /search/repositories?q=language:HCL`.) Private estates are
   not counted and are where the money is.
2. **Terraform is mainstream, not niche.** Stack Overflow Developer Survey 2025, "Other
   tools" / cloud development section: **Terraform 17.8%** of respondents (Ansible 11.7%,
   Podman 11.1%); the section reports "Responses: 24,473 (49.9%)" of roughly 49,000
   respondents. ([source](https://survey.stackoverflow.co/2025/technology), read 2026-10-11)
3. **This market already transacts, at real prices.** Hava publishes $59–$249/mo, Brainboard
   $99/user/mo, Infracost $250–$1,000/mo, Firefly $2,499/mo, Sourcegraph a $16k floor. None
   of these are hypothetical price lists; they are self-serve checkout pages. Published
   self-serve prices are the cheapest reliable willingness-to-pay evidence available.
4. **Demand for free Terraform visualisation has persisted for years while supply decayed.**
   8,250+ aggregate GitHub stars across six single-purpose Terraform visualisers, yet Rover
   (3,345★) has not been pushed since 2025-07-30 and Blast Radius (2,193★) since 2024-08-14.
   People keep looking for this and the free answers are rusting.
5. **A platform vendor chose to give the category away.** Cloudcraft is now distributed
   "free in Datadog" with unlimited users and diagrams. Verified wording from
   cloudcraft.co. For a platform company, diagrams are a retention feature, not a product.

### 3.2 Thin signals — treat with suspicion

- **Seat-priced comprehension tools exist and are cheap.** Unblocked $29/user/mo, Greptile
  $30/seat/mo. That is evidence the *shape* (per-seat, self-serve, code comprehension) sells,
  but it is not evidence that *our* version sells. Their existence is as easily read as
  "the comprehension budget is already spent".
- **Swimm and Lucidscale publish no price.** Both target the "help people understand what
  they did not build" job, and both went enterprise-only. That is weak evidence that the
  self-serve comprehension buyer is hard to find.
- **No search-volume, no review-site, no job-ad data gathered.** I did not have a keyword
  tool and did not want to present a scraped guess as a finding.

### 3.3 The counter-signal I will not bury

**Pluralith priced Terraform-diagrams-plus-generated-explanation at $250/mo and the CLI
has not been touched since 2023-07-14.** The website still advertises the price with a 2023
copyright. I cannot verify *why* it stopped — it may have been acquired, abandoned, or the
founder may simply have taken a job. But the nearest thing to our product, in the same
category, at a sane price, is not shipping. Anyone writing the commercial case must account
for that rather than count the GitHub stars and stop.

My reading (**ESTIMATE**): Pluralith was CI-first — a PDF artefact attached to a pull
request. That sells to a platform team that already has a Terraform pipeline, which is a
narrow and well-served buyer. The comprehension job is interactive and happens *outside*
CI, at the moment someone is confused. That is a different product shape, and it is the one
we are building. This is a hypothesis, not a finding.

### 3.4 Honest conclusion on demand

The *problem* is verified: enormous Terraform corpus, mainstream adoption, persistent
demand for visualisation, decaying free supply, and a price list that proves money moves in
the adjacent category. The *buyer* is not verified at all. Nothing I found proves that the
person who needs the explanation can authorise £19/month, and the one direct precedent
stopped shipping. Launch should therefore be designed to **discover the buyer cheaply**
(generous free tier, self-serve checkout, no sales motion), not to defend a market-size
number.

---

## 4. Pricing and packaging recommendation

### 4.1 The cost structure we must price against

| Fact | Source |
|---|---|
| Free tier uses the **customer's own** Anthropic key; paid plans use a platform key with a hard per-plan `monthly_token_cap`, enforced **reserve-then-reconcile** before each call | Settled decision; `docs/TECH-SPEC.md` §8.6 |
| **Parsing and graph building use no AI at all** — HCL parsing is deterministic | `docs/TECH-SPEC.md` §5 |
| An explanation request is capped at **≤12,000 input tokens** (context assembly drops peers to stay under it); ≤25 peer nodes, ≤6 source snippets of ≤40 lines | `docs/TECH-SPEC.md` §8.1, §7.6 |
| Explanation rate limit 60/hour; engine hard limits ≤500 `.tf` files, ≤5,000 graph nodes | `docs/TECH-SPEC.md` §5.1, §8.6 |

**The single most important commercial consequence:** our AI cost scales with **questions
asked**, not with repository size. A 4,000-resource repo costs the same to parse as a
40-resource one and nothing to store in AI terms. That means we can afford generous repo
and node allowances and should meter only the thing that actually costs money.

### 4.2 Model prices (VERIFIED, [claude.com/pricing](https://claude.com/pricing), read 2026-10-11)

| Model tier | Input $/MTok | Output $/MTok | Cache read $/MTok | Cache write $/MTok |
|---|---|---|---|---|
| Opus 5.5 | $4 | $20 | $0.20 | $5 |
| **Sonnet 5.5** (assumed launch model) | **$2** | **$10** | **$0.10** | **$2.50** |
| Haiku 5.5 (≤100K ctx) | $0.10 | $0.50 | $0.01 | $0.125 |

Batch API: "Save 50% with batch processing" (not applicable — explanations are interactive).

FX: **USD→GBP 0.75641**, 2026-10-09 ([frankfurter.dev](https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP),
read 2026-10-11). All £ figures below use that rate.

> **Open question for the AI Engineer (AIS-6):** the launch model is not yet fixed. I have
> priced on the **Sonnet tier**. If grounded explanation holds quality on the Haiku tier,
> every AI cost below falls by roughly **20×** and the caps can be raised dramatically.
> Do not change the prices on that basis without a measured grounding score.

### 4.3 Cost of one explanation — the arithmetic

Worst realistic case, Sonnet tier, **no prompt caching**:

```
input    12,000 tok × $2.00/1,000,000  = $0.0240
output      600 tok × $10.00/1,000,000 = $0.0060   (max_tokens 900, typical 600 — ESTIMATE)
                                         -------
total per explanation                   = $0.0300  = £0.0227   (~2.3p)
```

With the stable prefix cached across a session (system prompt + node context reused for
follow-up questions — 8,000 of 12,000 input tokens served from cache):

```
cached input  8,000 × $0.10/1M = $0.0008
fresh input   4,000 × $2.00/1M = $0.0080
output          600 × $10.00/1M= $0.0060
                                 -------
                                 $0.0148 = £0.0112   (~1.1p)
```

Blended planning cost per 1M **total** tokens at a 95% input / 5% output mix:
`0.95 × $2.00 + 0.05 × $10.00 = $2.40/MTok = £1.815/MTok`.
Average explanation ≈ 12,600 total tokens, so **1M tokens ≈ 79 explanations**.

I price on the **uncached** figure. Caching is upside, not a plan assumption.

### 4.4 Recommended plans

| | **Free — "Bring your own key"** | **Solo** | **Team** |
|---|---|---|---|
| Price (monthly) | **£0** | **£19/month** | **£29 per user/month**, min 3 seats |
| Price (annual) | — | **£180/year** (£15/mo, −21%) | **£288/user/year** (£24/mo, −17%) |
| AI key | **Customer's own Anthropic key (required)** | Platform key | Platform key |
| `monthly_token_cap` | n/a (their key, their bill) | **2,000,000** | **3,000,000 per seat, pooled** |
| ≈ explanations/month | unlimited on their key | **~159** (≈8 per working day) | **~238/seat** (3 seats ≈ 714) |
| `repo_limit` | **1** | **3** | **15** |
| `node_limit` per repo | **500** | **2,000** | **5,000** (engine hard ceiling) |
| Seats | 1 | 1 | 3+ |
| Re-scan | 5/day | 30/day | 30/day/repo |
| Explanation rate limit | 20/hour | 60/hour | 60/hour |
| Everything else | Full diagram, full grounded chat, source viewer, citations | + plan-JSON import, diagram export | + shared workspace, shared repos |
| Not included at launch | — | — | SSO/SAML, audit log, self-hosting → "Talk to us" link, **no price advertised, nothing promised** |

These four numbers map exactly onto the `plans` columns the CTO defined in
`docs/TECH-SPEC.md` §7.9 (`repo_limit`, `node_limit`, `monthly_token_cap`,
`requires_own_api_key`). `requires_own_api_key` is `true` for Free only.

### 4.5 Margin — does it survive contact with the AI bill?

**Solo, customer burns 100% of the cap every month (worst case):**

```
Revenue                                           £19.000
Stripe, UK standard card 1.5% + £0.20             -£0.485
AI: 2,000,000 tok × £1.815/MTok                   -£3.630
Marginal hosting/GitHub egress (ESTIMATE)         -£0.500
                                                  --------
Contribution                                      £14.385   = 75.7% gross margin
```

**Solo, median user at 25% of cap (ESTIMATE — no usage data exists yet):**
AI −£0.91 → contribution **£17.11 ≈ 90%**.

**Team, 3 seats, 100% of a 9,000,000-token pool:**

```
Revenue 3 × £29                                   £87.000
Stripe 1.5% + £0.20                               -£1.505
AI: 9,000,000 × £1.815/MTok                      -£16.335
Marginal hosting (ESTIMATE)                       -£1.500
                                                  --------
Contribution                                      £67.660   = 77.8% gross margin
```

**Annual Solo at £180, 100% of cap every month for 12 months:**
`£180 − (1.5%×180 + £0.20) = £177.10` revenue net of Stripe; AI `12 × £3.63 = £43.56`;
hosting `£6` → contribution **£127.54 = 70.9%**.

**The cap is what makes this safe.** Because §8.6 reserves tokens *before* the API call and
refuses at the cap with `AI_CAP_REACHED` (leaving the rest of the product working), a paid
plan **cannot** exceed its AI budget. The worst case above is the actual worst case, not an
average. Every tier clears 70% gross margin even when fully consumed.

**Fixed-cost break-even (ESTIMATE, hosting owned by CTO/DevOps):** against the £60/month
ceiling, **5 Solo customers** at worst-case usage (5 × £14.39 = £71.93) covers it. Two Team
accounts of 3 seats covers it with room.

Stripe fees **VERIFIED** ([stripe.com/gb/pricing](https://stripe.com/gb/pricing), read
2026-10-11): UK standard cards **1.5% + 20p**, UK premium 2.8% + 20p, EEA 2.5% + 20p,
international 3.15% + 20p (+2% for currency conversion). Note Stripe Billing: pay-as-you-go
is "0.7% of Billing volume" — **£0.13/month on a £19 plan**; the £450/month Billing
subscription is not to be used. Non-UK cards cut the Solo margin by ~1.7pp at most; immaterial.

### 4.6 Why these price points, with comparables

| Decision | Reasoning | Comparables |
|---|---|---|
| **Free tier requires the customer's own key** | Already settled, and commercially right: it makes the expensive part of the product cost us £0 while still demonstrating the differentiator in full. A time-limited trial would hide the thing we are selling | Brainboard Free (unlimited architectures), Overmind Free (1 repo forever), Greptile Starter (50 credits, 1 dev) — generous free tiers are table stakes in this category |
| **Free is limited by repo/node/seat, never by feature** | Trust is the feature. A free user who cannot see a *grounded citation* learns nothing about why we are different. Cripple the scale, never the grounding | Overmind gives "full feature access" to one repo "forever" |
| **Solo at £19/mo (~$25)** | Deliberately between the diagramming band and the comprehension band. We do **less** than Hava ($59, multi-cloud live state) so we must be clearly cheaper; we do **more** than Lucidchart (~$10, hand-drawn) so we can be clearly dearer. £19 is also a defensible personal expense for a contractor — the buyer I think is most likely to convert first (§5) | Hava Professional $59/mo (1 user); Lucidchart Team ~$10/user/mo (SEARCH-DERIVED); Brainboard Pro $99/user/mo |
| **Team at £29/seat (not £39)** | I drafted £39 and cut it. At £39 we would be the **most expensive** per-seat tool in the comprehension band with the weakest brand and the narrowest scope (Terraform only, GitHub only). £29 sits exactly on the established per-seat clearing price for AI code comprehension, which is the price the buyer has already seen and accepted | Unblocked **$29/user/mo annual** / $35 monthly; Greptile Pro **$30/seat/mo** |
| **Meter tokens, not resources** | Our cost genuinely is per-question. Per-resource pricing would punish exactly the large, confusing estates where we are most valuable, and would be a pricing model we cannot justify from our own cost base | HCP Terraform charges $0.10–$0.99/resource/mo because *their* cost is per-resource. Ours is not. Copying it would be cargo-culting |
| **No Enterprise price at launch** | We have no SSO, no audit log, no self-hosting and no DPA process. Publishing an Enterprise tier would be a public claim the product cannot meet. A "Talk to us" link captures the demand signal and promises nothing | Lucidscale and Swimm publish no price at all and route to sales — the pattern is normal and costs us no credibility |
| **Annual discount ~20%** | Standard, and it is the cheapest cash-flow improvement available to a pre-revenue product. Hava publishes exactly "20% discount" for annual | Hava 20% annual; Unblocked $29 annual vs $35 monthly (−17%) |
| **Overage policy: hard stop, not a surprise bill** | At the cap, explanations refuse with the reset date and the diagram, graph, search and source viewer keep working. A developer tool that silently bills for AI overage will be the subject of the first angry blog post | Greptile's "$1 per additional credit" is the alternative; I recommend against metered overage at launch because we have no usage data to price it from. Revisit at ~50 paying customers |

### 4.7 What would change this recommendation

- **Haiku tier proves sufficient** (AI Engineer, AIS-6) → caps rise ~20× at the same price,
  or prices fall. Biggest single lever on the model.
- **Median usage exceeds 60% of cap** in the first 60 days → raise prices or lower caps.
  Instrument `ai_usage` from day one; this is already in the schema.
- **Free→paid conversion below ~2%** → the free tier is too generous or the buyer is wrong.
- **A Team buyer appears before a Solo buyer** → flip the landing page to the team/onboarding
  message and treat Solo as the trial.

---

## 5. Positioning recommendation

### The one-sentence claim

> **Point Diagram Mapper at a Terraform repository and it draws your infrastructure, then
> explains any resource — with the file and line it came from.**

Three things are doing work in that sentence, and each is a deliberate exclusion:

- **"a Terraform repository"** — not your cloud account. We never ask for cloud credentials.
  This is our best trust argument and our clearest line against Cloudcraft, Hava, Lucidscale
  and Firefly, all of which read live cloud state.
- **"explains"** — not "visualises". Hava and Cloudcraft draw better pictures than we will.
  We must not compete on beauty.
- **"with the file and line it came from"** — the anti-hallucination promise, and the only
  claim in the sentence that none of the funded competitors makes. It is also a claim QA can
  measure, which is why it is the claim worth making.

### Supporting line (for the landing page, subject to CEO sign-off)

> Every answer cites the file and line. Read-only GitHub access. We never store your
> Terraform source — only the graph and the references back to your repository.

**This line is only sayable because it is true** per the settled security decisions
(read-only GitHub App, raw IaC not retained after parsing). It must be re-verified against
the shipped product by QA before it goes public, and §6 flags it.

### Who this deliberately excludes

| Excluded | Why we let them go |
|---|---|
| People who want to **design and deploy** infrastructure visually | That is Brainboard's product and it is a much bigger build. Our canvas is read-only on purpose |
| People who want **live cloud inventory, drift or cost** | Cloudcraft/Hava/Firefly own it, we read source not state, and competing there means cloud credentials — which destroys our trust position |
| People who want a **diagram for a slide deck** | Lucidchart at ~$10/user and draw.io at £0 win, forever |
| **Non-Terraform estates** (CloudFormation, Pulumi, Bicep, Kubernetes, Ansible) | Settled scope. Sequence post-launch by the demand the waitlist actually shows |
| **Non-GitHub** source hosts (GitLab, Bitbucket, self-hosted) | One integration done properly beats three done badly |
| **Enterprises with an SSO/self-hosting gate** | We will fail their security review today. "Talk to us" and build the pipeline honestly |

### The target-user finding the product owner should read

The wider goal is tooling for **junior and rising developers**. On the evidence, that is the
right **user** and the wrong **buyer**:

- Juniors do not hold budget, and the two products aimed squarely at
  "help people understand what they did not build" — **Swimm** ("pricing is based on the
  number of lines of code you want to understand") and **Lucidscale** — both abandoned
  self-serve pricing entirely.
- The segment with budget, the same problem, and **no procurement step** is the
  **contractor, consultant and newly-landed platform engineer**: someone who inherits an
  unfamiliar Terraform estate every few months, is billing for the time they spend confused,
  and buys their own tools on a card.

**Recommendation:** keep the junior as the person the product is *designed for* — the
explanation quality bar, the onboarding, the plain-English copy all follow from that — and
make the **repo-inheritor** the person the pricing page is *written for*. One product, two
readers. The PRD (`docs/PRD.md` §2) carries this split through to the user stories.

This is a **judgement call on indirect evidence**, not a finding. It is cheap to test: the
sign-up form asks one question ("why are you here?") and the answer settles it in six weeks.

---

## 6. Recommendation and next actions

**Recommend to the product owner, via the CEO:**

1. **Approve the three-tier structure in §4.4 as the launch pricing**, including the four
   entitlement numbers the CTO needs for the `plans` table. Every tier clears 70% gross
   margin at 100% cap consumption, and the cap mechanism makes the worst case the real
   worst case. *Decision needed: CEO/product owner.*
2. **Approve the one-sentence claim and the exclusion list in §5** before any landing-page
   copy is written. Positioning first, copy second. *Decision needed: CEO/product owner.*
3. **Do not publish an Enterprise price.** "Talk to us" only, until SSO, audit log and a DPA
   exist. *Product recommendation; no decision needed unless someone objects.*
4. **Accept that the buyer is unvalidated and close that gap with a person, not an agent.**
   I cannot contact prospects. Ten conversations with contractors or platform leads — "show
   me the last time you inherited a Terraform repo you did not understand, and what you did"
   — would be worth more than everything above. *Owner: product owner. Only the product
   owner can do this.*
5. **Treat the Pluralith precedent (§3.3) as a live risk, not a footnote.** Review it again
   at the M4 pricing gate with whatever the free tier has told us by then.

**Handoffs:**

| To | What I need |
|---|---|
| **AI Engineer (AIS-6)** | Measured grounding accuracy and the chosen model tier. §4.2's Sonnet assumption and the §5 public claim both depend on it. If Haiku holds, re-run §4.3 |
| **CTO** | The §4.4 entitlement numbers go straight into `plans`. Confirm the £60/month hosting ceiling still holds with a 500-node free tier, and own the £0.50/customer marginal hosting estimate |
| **QA & Security** | Before the landing page goes live, verify the two public claims: (a) every explanation citation resolves to a real file and line in the customer's repo, (b) raw Terraform source is not retained after parsing. These are marketing claims with a security dependency |
| **CEO** | Items 1, 2 and 4 above |

---

## 7. Sources

Every URL below was fetched during this task on **2026-10-11** unless stated otherwise.

| Source | Used for |
|---|---|
| https://www.hava.io/pricing | Hava tiers and prices |
| https://www.cloudcraft.co/ | "Now free in Datadog", supported clouds |
| https://www.datadoghq.com/pricing/ | Datadog Infrastructure host prices |
| https://lucid.co/pricing/lucidscale | Lucidscale has no published price |
| https://lucid.app/pricing/lucidchart | Lucidchart — JS-rendered, **no figures verified**; the ~$9/~$10 numbers are SEARCH-DERIVED |
| https://www.brainboard.co/pricing | Brainboard Free/Pro/Enterprise, import-as-Enterprise |
| https://overmind.tech/pricing | Overmind Free and Enterprise model |
| https://www.firefly.ai/pricing | Firefly Essential $2,499/mo |
| https://www.pluralith.com/ | Pluralith $250/mo, © 2023 |
| https://api.github.com/repos/Pluralith/pluralith-cli | 860★, last push 2023-07-14 |
| https://www.hashicorp.com/en/pricing?tab=terraform | HCP Terraform per-resource prices |
| https://www.infracost.io/pricing/ | Infracost tiers |
| https://www.getunblocked.com/pricing | $29/$35 per user/month |
| https://www.greptile.com/pricing | Free / $30 seat / credits |
| https://sourcegraph.com/pricing | "Starting at $16K" annual |
| https://swimm.io/pricing/ | No published price; priced on lines of code |
| https://docs.aws.amazon.com/solutions/workload-discovery-on-aws/ | Discontinuation notice (page generated 2026-10-09) |
| https://aws.amazon.com/devops-agent/ | Capabilities, support-plan credits, no public price |
| https://developer.hashicorp.com/terraform/cli/commands/graph | `terraform graph` scope and limits |
| https://survey.stackoverflow.co/2025/technology | Terraform 17.8% |
| GitHub Search API (`language:HCL`, `topic:terraform`) | 688,068 / 42,564 repositories |
| GitHub REST API (6 visualiser repos) | Star counts and last-push dates |
| https://claude.com/pricing | Model token prices, cache prices, batch discount |
| https://stripe.com/gb/pricing | UK card fees, Stripe Billing fees |
| https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP | USD→GBP 0.75641 (rate date 2026-10-09) |
| `docs/TECH-SPEC.md` (CTO, AIS-?) | §5.1 limits, §7.9 entitlements, §8.1 context budget, §8.6 cost control |
