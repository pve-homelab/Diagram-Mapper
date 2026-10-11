# Diagram Mapper — Licence and Dependency Plan

Owner: QA & Security Engineer (reports to the CEO).
Status: M0 baseline, version 1.0. Mirrored from issue document `licence-plan` on AIS-7.
Scope: the licence for our own repository, the licence policy for third-party
dependencies, and the CI enforcement for both — plus secret and vulnerability scanning.
Companion documents: `docs/TEST-STRATEGY.md`, `docs/THREAT-MODEL.md` (finding F-17).

> **I am not a lawyer and this is not legal advice.** It is an engineering recommendation
> with the trade-offs named, so the CEO and the product owner can make a decision and —
> for the items marked as such — take it to a solicitor. Deliverable 3 of AIS-7 asks for a
> recommendation and the trade-offs, not a decision, and that is what this is.
>
> This document also closes two of the CTO's open questions assigned to me:
> **open question 6** (is MPL-2.0 acceptable? is EPL-2.0?) in §3.3, and it gives the
> licence constraint for **open question 4** (which layout library) in §3.5.

---

## 1. The blocker, stated plainly

The repository has **no licence file**. That is a release blocker, and it is worse than it
looks because of where the repository lives.

**With no `LICENSE` file, the default position is "all rights reserved".** No one has any
right to use, copy, modify or distribute the code. For a product we intend to sell that
sounds harmless — but it has three live consequences today:

1. **If the GitHub repository is public**, GitHub's Terms of Service (the section on
   licence grants for public repositories) give every other GitHub user the right to
   **view and fork** it. That is a narrow grant, and it is emphatically *not* a licence to
   run or resell — but it does mean the source of a product we are about to charge for is
   readable and forkable by anyone, including a competitor who is happy to ignore the
   limits of that grant. **Action for the CEO: confirm whether the repository is public,
   and if it is, decide deliberately whether it stays that way.** This is the single
   highest-value question in this document and it costs nothing to answer.
2. **Contributor ambiguity.** With no licence and no contributor agreement, each
   contributor retains copyright in what they wrote. For a company that may later be
   acquired or raise investment, unclear ownership of the core asset is a diligence
   finding. Cheap to fix now, expensive and awkward to fix retroactively once there are
   more contributors.
3. **No disclaimer of warranty or liability.** Every standard licence carries one. Right
   now the repository carries none.

A second, separate gap worth naming here because it is routinely confused with the first:
**a repository licence is not a customer agreement.** They are different documents with
different jobs, and we need both.

| Document | Governs | Needed before |
|---|---|---|
| `LICENSE` | What anyone may do with the **source code** | Any public repository; any contributor |
| Terms of Service / subscription agreement | What a **customer** may do with the hosted **service**, and our liability to them | First paying customer |
| Privacy notice + DPA | Personal data (threat model F-16) | First paying customer |
| `NOTICE` / `THIRD-PARTY-LICENCES` | Attribution we **owe** to dependencies | First deploy that serves bundled JavaScript (§3.6) |

The ToS, the DPA and the liability cap need a solicitor. The `LICENSE` and the
third-party notices do not, and they are the two I can deliver.

---

## 2. Licence recommendation for our repository

### 2.1 The real question

Not "which open-source licence" but **"do we want anyone else to be able to run this?"**
We are selling a hosted subscription. The asset at risk is not the code's novelty — HCL
parsing and graph rendering are well-trodden — it is the time it would take a competitor
to reach parity. A permissive licence hands them that time for free.

### 2.2 Recommendation

**Primary recommendation: a proprietary, all-rights-reserved `LICENSE` file, in a private
repository.**

Second choice, **only if the product owner wants the repository public** for credibility,
hiring, or marketing: **Business Source License 1.1 (BUSL-1.1)** with a 4-year change date
to Apache-2.0 and an Additional Use Grant permitting everything except offering Diagram
Mapper as a competing hosted service.

The reasoning is short: an explicit proprietary licence costs nothing, forecloses nothing,
and removes the ambiguity in §1 today. Every other option is a strategic choice about
distribution that should be made on purpose and later, not as a side effect of a missing
file at M0. Licences are easy to loosen later (we hold the copyright, so we can relicense
at will) and effectively impossible to tighten — which makes the restrictive option the
reversible one. That asymmetry is the whole argument.

### 2.3 The trade-offs, as the task requires

| Option | For | Against | Verdict |
|---|---|---|---|
| **Proprietary, all rights reserved** (recommended) | Maximum protection; zero obligation; no ambiguity; trivial to write; can be relicensed later because we hold copyright; no interaction with dependency copyleft | No community contribution; no "open source" marketing; some developer-tool buyers distrust a closed tool that reads their infrastructure code — a real objection for *this* product; must keep the repository private to mean much | **Recommended for launch.** Decide the public/private question first |
| **BUSL-1.1**, 4-year change date → Apache-2.0 | Source is public and auditable, which directly answers "why should I let you read my infrastructure?"; blocks a competing hosted service; proven for commercial SaaS (MariaDB, Sentry, HashiCorp) | **Not an OSI-approved open-source licence** and attracts criticism for being marketed as open; the Additional Use Grant must be drafted carefully or it either blocks legitimate customer use or fails to block a competitor; the change date eventually releases everything under Apache-2.0 | **Recommended if the repository is to be public.** Needs a solicitor on the grant wording |
| **AGPL-3.0 + a contributor licence agreement** (open core) | OSI-approved, genuinely open; network-use copyleft forces a hosting competitor to publish their changes; the CLA lets us sell a proprietary licence alongside | Many companies ban AGPL software outright, so it can deter the customers we want; the CLA adds friction; **AGPL's copyleft reaches code we combine with it**, which demands care forever; "open source but you can't really use it commercially" invites bad faith readings | Viable, but the governance overhead is wrong for a pre-revenue team of this size |
| **Elastic License 2.0 / Fair Source** | Very short and readable; explicitly forbids providing the product as a service; low drafting risk | Not OSI-approved; smaller ecosystem of precedent than BUSL; same "not really open" criticism | Reasonable alternative to BUSL if simplicity is preferred over precedent |
| **MIT or Apache-2.0** | Maximum goodwill, adoption and contribution; zero friction for anyone | **Anyone may host and sell this, including with our own branding removed and ours undercut.** For a product whose entire business model is the hosted service, this gives away the business | **Not recommended.** Apache-2.0 would still be the right choice for a small library we spin out — e.g. the HCL parser as a standalone package, which is worth considering as a marketing asset once it is good |

### 2.4 What I will do, pending the decision — and what I deliberately will not

**I am not committing a `LICENSE` file in this task, and that is a considered choice.**

A licence is a legally operative document and it must name a copyright holder. I do not
know who that is — the product owner personally, or a company that may or may not yet
exist — and inventing a rightsholder is worse than a short, acknowledged gap. Legal
sign-off is the CEO's, not mine, so I am escalating the decision with a recommendation
instead of pre-empting it. An explicit "all rights reserved" is strictly better than
silence, but only once it names the right party.

What I **am** delivering in this task, because none of it has legal weight and all of it is
mine: the licence recommendation and trade-offs above, `licence-policy.json` encoding
§3.2–3.4 machine-readably, `licence-exceptions.json`, and a draft `SECURITY.md` for the
confidential-disclosure gap recorded as threat model F-16. The moment the CEO answers the
two questions below, the `LICENSE` file is a five-minute commit.

Open items for the CEO:

1. Is the repository public or private? If public, decide whether it stays public.
2. Who is the copyright holder — the product owner personally, or a company once formed?
   The `LICENSE` needs a name and it should be the right one from the first commit.
3. Proprietary or BUSL-1.1.
4. Solicitor review of the ToS, the DPA, and the liability cap before the first payment.
   This is spend, so it is a CEO decision; I am flagging, not acting.

---

## 3. Dependency licence policy

### 3.1 The distinction the whole policy turns on

Most copyleft obligations trigger on **distribution**. A hosted SaaS does not distribute
its server-side dependencies — users interact with the service over a network and never
receive the code. This is why AGPL exists at all: to close that gap.

So the policy must be split, because the risk is genuinely different on each side:

- **Server-side** (Next.js server, parser worker, database layer): not distributed. Weak
  copyleft (MPL-2.0, EPL-2.0, LGPL) is low risk. **AGPL is prohibited** — network use is
  its trigger, and we are the network use.
- **Client-side** (anything webpack/turbopack bundles into JavaScript sent to the
  browser): **this is distribution, to every single visitor.** Every attribution and
  source-availability obligation fires here. A copyleft dependency in the client bundle is
  a materially bigger commitment than the same dependency on the server.

I have not seen this distinction stated in the spec, and it is the one that would have
caused a real problem — see §3.5, where it decides the layout-library choice.

### 3.2 Acceptable — permissive, no conditions beyond attribution

`MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `Apache-2.0`, `Zlib`, `Unlicense`,
`CC0-1.0`, `Python-2.0`, `BlueOak-1.0.0`, `MIT-0`.

Use freely on both server and client. Two standing obligations: preserve copyright notices
and licence text (satisfied by the generated `THIRD-PARTY-LICENCES` file, §3.6), and for
Apache-2.0 specifically, carry forward any upstream `NOTICE` file content — §4 of
Apache-2.0 requires it and it is the attribution obligation most often missed.

### 3.3 Acceptable with conditions — weak copyleft

**This answers the CTO's open question 6.**

**MPL-2.0 — yes, acceptable, including in the client bundle.**
MPL-2.0 is **file-level** copyleft. Combining MPL files with our proprietary code into a
"Larger Work" is **explicitly permitted** by §3.3 — this is the case MPL was written for.
Obligations: (a) if we **distribute** the MPL-covered files, their source must be
available, which is satisfied by the unmodified upstream package being public; (b) keep
the notices; (c) **any modification we make to an MPL-covered file must itself be released
under MPL-2.0.** Our proprietary code is untouched either way.
→ **Condition: never fork, vendor-patch, or inline an MPL dependency.** Use it unmodified.
If a patch is unavoidable, upstream it or publish the patched file. CI records the
obligation; the discipline is a review rule.

**EPL-2.0 — yes, acceptable, with the same shape and more care.**
EPL-2.0 is also weak copyleft at the level of "Modified Works", and permits combination
with proprietary code in a "Larger Work". Two wrinkles MPL does not have: EPL's §3 source
availability obligations on Contributions we distribute, and a secondary-licence provision
allowing recipients to take the code under GPL-2.0 — which is a right granted to *them*,
not an obligation on us, and does not affect our proprietary code.
→ **Conditions: unmodified only; attribution in `THIRD-PARTY-LICENCES`; and prefer a
permissive alternative when one exists of comparable quality.** EPL carries more
litigation-and-patent text than MPL and is less familiar to reviewers, so for equal
functionality I would rather take the MIT option. Not a prohibition — a preference.

**`LGPL-2.1`, `LGPL-3.0`, `CDDL-1.0/1.1`, `Artistic-2.0`, `OpenSSL`:**
server-side only. **LGPL must not enter the client bundle** — bundlers perform what is
effectively static linking, which triggers LGPL's relinking obligations (§4 of LGPL-3.0)
and means shipping object files or equivalent so a user can substitute their own version.
That is an obligation we do not want to discover after launch. Server-side, where nothing
is distributed, LGPL is unproblematic.

### 3.4 Prohibited

| Licence | Why |
|---|---|
| `AGPL-3.0`, `AGPL-3.0-only`, `AGPL-3.0-or-later` | Network use triggers the source obligation for the **entire combined work**. This is the one that could force us to publish Diagram Mapper. **Hard prohibition, no exceptions, including transitive.** |
| `GPL-2.0`, `GPL-3.0` (any variant) | Strong copyleft over the combined work; the "mere aggregation" argument is too thin to rest a business on |
| `SSPL-1.0` | Requires releasing the source of the entire service stack if offered as a service. Aimed precisely at us |
| `BUSL-1.1`, `Elastic-2.0`, `Commons Clause`, `Confluent`, `RSAL`, `PolyForm-Noncommercial` | Restrict commercial or hosted use **of the dependency**. (Note the asymmetry: BUSL is a fine licence for *our* code and an unacceptable one for a *dependency*.) |
| `CC-BY-NC-*`, `CC-BY-ND-*` | Non-commercial or no-derivatives — incompatible with selling a product |
| `JSON` ("the Software shall be used for Good, not Evil") | Unenforceably vague and a known blocker for commercial use; a documented reason to avoid `org.json`-lineage packages |
| `UNLICENSED`, `SEE LICENSE IN …`, `UNKNOWN`, missing, or unparseable | **Prohibited until a human resolves it.** Unknown is not permissive. Resolution = read the repository, record the finding in `licence-exceptions.json` with the actual SPDX id and a link, or remove the dependency |

`WTFPL` and similar joke licences are permissive in intent but legally sloppy; allowed only
by recorded exception, and preferably replaced.

### 3.5 Assets are dependencies too — and the layout-library answer

Fonts, icon sets and images carry licences and are routinely missed because they are not in
`package.json`. Font Awesome Free mixes `CC-BY-4.0` (icons, attribution required) with
`MIT` (code); many icon sets are `CC-BY-4.0`; some commercial fonts forbid web embedding
outright. **Policy: every font, icon set and image gets an SPDX id and a source URL
recorded in `THIRD-PARTY-LICENCES` before it is committed, and the CI gate covers the
asset manifest as well as `package.json`.** Prefer `MIT`/`ISC`/`OFL-1.1` assets.

**Constraint for the CTO's open question 4 (layout library), which is a client-bundle
decision:**

| Candidate | Licence | Verdict |
|---|---|---|
| `dagre` / `@dagrejs/dagre` | MIT | **Preferred.** Permissive, client-safe, no obligation beyond attribution |
| `d3-hierarchy` | ISC | Fine, if the layout need is tree-shaped |
| `elkjs` | **EPL-2.0** | Allowed, but it is **client-bundled, therefore distributed**, so the EPL obligations in §3.3 fire. Acceptable **only** unmodified and with the notice shipped. If ELK's layout quality is decisively better, this is a reasonable trade — but take it knowingly, not by accident |
| `@xyflow/react` (React Flow) | MIT in v12 — **to be confirmed by the gate**, because React Flow also sells a Pro tier and the licence must be checked against the exact version we install, not against a blog post | Confirm at install |

The point is not that EPL is dangerous. It is that "which layout library" looked like a
purely technical question and is partly a licensing one, and the client/server distinction
in §3.1 is what reveals that.

### 3.6 Attribution output

CI generates `THIRD-PARTY-LICENCES.md` — every production dependency with its version,
SPDX id, copyright holder and full licence text — and a CycloneDX SBOM. Both are
committed, so a licence change in a dependency shows up as a reviewable diff rather than
as a surprise. The file is served at `/licences` in the app, which discharges the
attribution obligations for the client bundle in the ordinary way.

An SBOM also arrives already built the first time an enterprise prospect asks for one,
which they will.

---

## 4. CI enforcement — every tool free

**Constraint honoured: nothing below costs money.** Where the obvious tool is free only for
public repositories, I say so and name the free alternative, because that distinction
decides whether a gate actually runs.

### 4.1 Licence gate

- **Source of truth:** `pnpm licenses list --json --prod` (built into pnpm; no service, no
  account, no network call beyond the install already performed).
- **Gate:** `scripts/check-licences.ts`, committed, reading `licence-policy.json`
  (the §3.2–3.4 lists) and `licence-exceptions.json` (each exception requiring an SPDX id,
  a reason, an approver and a date). It **fails the build** on any prohibited licence, any
  unknown or missing licence, and any conditional licence appearing in the **client**
  bundle when the policy restricts it to the server. Client/server classification comes
  from the bundler's module list, not from a guess — a dependency's position in
  `package.json` does not tell you whether it reaches the browser.
- **Allowlist, not denylist.** A licence not explicitly permitted fails. A new licence
  string must be classified by a human before it can ship — which is the whole point, and
  the reason this gate catches anything at all.
- Runs on every pull request and on `main`. Output is a table in the job summary.
- Avoided deliberately: `license-checker` (effectively unmaintained) and the hosted
  licence-compliance services (paid).

### 4.2 Vulnerability scanning

| Tool | Licence/cost | Role |
|---|---|---|
| `pnpm audit --prod --audit-level=high` | free, built in | Fast PR gate. Fails on high and critical in production dependencies |
| **`osv-scanner`** (Google, Apache-2.0) | free | Scans the committed lockfile against the OSV database. Broader and more accurate than `npm audit`, and not npm-registry-dependent. Nightly on `main` and on PRs touching the lockfile |
| **Dependabot alerts + security updates** | free, incl. private repos | Continuous notification and automated patch PRs. Enable; group non-security updates weekly so the gate does not drown in noise |
| `cyclonedx-npm` (Apache-2.0) | free | SBOM for §3.6 |

Policy: critical or high in a **production** dependency blocks the release; a documented
exception requires a stated reason, a compensating control and a review date. Development-
only advisories are triaged, not blocking — but a dev-dependency compromise is a build
compromise, so "not blocking" is not "ignored".

### 4.3 Secret scanning — two layers, because one is not enough

- **Pre-commit: `gitleaks` (MIT)** via the `pre-commit` framework, with a committed
  `.gitleaks.toml` extending the default rules with our own shapes: `DATA_ENCRYPTION_KEY`,
  `AUTH_SECRET`, GitHub App private keys (PEM), Stripe live keys (`sk_live_`), Anthropic
  keys (`sk-ant-`), and Terraform-shaped credentials. Catches the mistake before it is in
  history, which is the only cheap moment.
- **CI: `gitleaks detect --redact` over the full history** on every PR and nightly.
  `--redact` matters — a scanner that prints the secret into a public build log has
  widened the exposure it found. Fails the build on any finding.
- **GitHub secret scanning + push protection:** free and automatic for **public**
  repositories; on **private** repositories it is part of GitHub Advanced Security, which
  is **paid** → not assumed. If the repository is private, `gitleaks` in pre-commit and CI
  is our complete coverage, which is adequate.
- `trufflehog` OSS is a reasonable addition for its verified-credential checks (it tests
  whether a found key is live). Its own licence is AGPL — irrelevant to us, since we run it
  as a separate program and do not link it into the product.
- **A secret that reaches any branch is treated as compromised and rotated**, not deleted
  and forgotten. History rewriting is not remediation; rotation is. This is written down
  now so nobody has to decide it under pressure later.

### 4.4 Static analysis

- **`semgrep` OSS CLI (LGPL-2.1 tool, free)** with the community TypeScript, React and
  security rulesets, plus repository-specific rules that encode this product's invariants
  and are therefore worth more than any generic ruleset:
  - no `process.env` outside `packages/config` (spec §9.2);
  - no import of `pg` or `drizzle-orm` outside `packages/db` (spec §6.4);
  - no raw SQL template literal containing `${` outside an audited allowlist;
  - no `dangerouslySetInnerHTML`, ever (threat model F-06);
  - no `console.*` in server code — the allowlisting logger only (F-13);
  - every `app/api/**/route.ts` must reference `withTenant` or be on an audited
    public-route allowlist (F-01, F-10);
  - no new `SECURITY DEFINER` in a migration without a `SET search_path` on the same
    function (F-02).
- **CodeQL** is free for **public** repositories and requires paid GitHub Advanced Security
  for private ones. If the repository is public, enable it; if private, semgrep OSS is the
  plan and nothing paid is assumed either way.
- `tsc --noEmit` with `strict`, and ESLint with `@typescript-eslint` type-checked rules —
  a type error is a cheap security finding.

### 4.5 Supply-chain hardening

These are the controls that address how npm packages are actually compromised in practice,
rather than how we would prefer them to be:

- **`pnpm-lock.yaml` committed**, `--frozen-lockfile` in CI, and a `packageManager` field
  pinning the pnpm version.
- **`ignore-scripts=true` in `.npmrc`**, with the few packages that genuinely need a build
  step allowlisted via `pnpm.onlyBuiltDependencies`. Install-time lifecycle scripts are the
  execution vector in the large majority of npm supply-chain attacks; disabling them by
  default converts a malicious publish into an inert download.
- **`minimumReleaseAge`** set to a cooling-off period of several days, so a freshly
  published compromised version is not installed by CI within minutes of being pushed.
  Most malicious versions are yanked within hours; waiting costs us nothing.
- **GitHub Actions hardening:** third-party actions pinned by full commit SHA (never a
  floating tag), `permissions: contents: read` as the workflow default with escalation only
  where needed, no secrets exposed to `pull_request` workflows from forks, and
  `persist-credentials: false` on checkout.
- **New-dependency review:** adding a production dependency requires a line in the PR
  describing why it is needed and what it replaces. Check maintainer history, download
  volume, release age and whether the name is a plausible typosquat of something popular.
  Prefer the standard library, then a well-known package, then nothing. Every dependency is
  code we ship and a credential we trust.

### 4.6 Pipeline placement

| Stage | Checks | Blocking |
|---|---|---|
| Pre-commit (local) | `gitleaks`, lint, format, typecheck on staged files | yes, locally |
| PR | typecheck, lint, unit, `pnpm audit --prod`, licence gate, `gitleaks` full history, semgrep, integration + **tenant isolation suite**, Playwright | **yes — all of it** |
| Nightly on `main` | `osv-scanner`, licence gate, SBOM regeneration, live-model grounding evaluation, performance budget | yes, alerts on failure |
| Pre-release | full gate + the release checklist in the test strategy | yes |

The tenant isolation suite is listed as blocking and, per the test strategy, CI fails if it
does not execute at all. A security gate that can be skipped is decoration.

---

## 5. Actions and owners

| # | Action | Owner | Blocking what |
|---|---|---|---|
| 1 | Confirm whether the GitHub repository is public; decide if it stays public | **CEO** | the licence choice; costs nothing to answer |
| 2 | Decide proprietary vs BUSL-1.1; name the copyright holder | **CEO** + product owner | **release** |
| 3 | Commit `licence-policy.json`, `licence-exceptions.json` and draft `SECURITY.md` (threat model F-16) | **QA & Security (me)** | **done in this task** — all three committed; `SECURITY.md` carries a `<SECURITY-CONTACT>` placeholder and is marked not-yet-publishable pending action 3c |
| 3c | Supply the security reporting address and confirm a private triage channel, then publish `SECURITY.md` | **CEO** | the confidential-advisory route (F-16) |
| 3b | Commit the chosen `LICENSE` once actions 1–2 are answered | **QA & Security (me)**, on the CEO's decision | **release** |
| 4 | Build the licence gate, `gitleaks`, `pnpm audit`, `osv-scanner`, semgrep, SBOM into CI | **QA & Security (me)**, with the CTO on the pipeline | first deploy |
| 5 | `.npmrc` with `ignore-scripts=true` and `minimumReleaseAge`; lockfile committed | **Backend** at repository scaffold | first dependency install |
| 6 | Run the licence gate against the real dependency tree the moment `package.json` exists; report any prohibited or unknown licence | **QA & Security (me)** | M1 exit |
| 7 | Solicitor review: ToS, DPA, liability cap, BUSL grant wording if chosen | **CEO** (spend) | first paying customer |
| 8 | Confirm Anthropic commercial terms in writing (threat model F-12) | **QA & Security (me)** | public claims about AI data handling |

---

## 6. Verdict

**The missing licence file is confirmed as a release blocker, and it is not yet resolved —
only one of the two decisions it needs is mine to make.**

My recommendation is a **proprietary, all-rights-reserved licence in a private
repository**, with **BUSL-1.1** as the right answer if the product owner wants the source
public. The trade-offs are in §2.3. The decision belongs to the CEO and the product owner,
and per §2.4 I am **not** committing a `LICENSE` file in this task: a licence must name a
copyright holder, I do not know who that is, and inventing a rightsholder is worse than a
short acknowledged gap. The repository therefore remains in the ambiguous state described
in §1 until the CEO answers the two questions in §2.4 — at which point the `LICENSE` is a
five-minute commit (action 3b). The gap is recorded as a release blocker rather than
papered over.

**The CTO's open question 6 is answered: MPL-2.0 is acceptable, EPL-2.0 is acceptable, both
unmodified only** — with the caveat the question did not anticipate, that the client bundle
is distribution and therefore the obligations differ by side (§3.1). That caveat changes
the recommended answer to open question 4: prefer MIT-licensed `dagre` over EPL-licensed
`elkjs` unless ELK's layout quality justifies taking the obligation knowingly.

**No dependency licence has been verified, because there are no dependencies yet.** I am
not going to claim a clean licence audit of an empty `package.json`. The gate in §4.1 is
the deliverable; action 6 above runs it for real at M1 exit and I will report the result
with the command and its output. Every tool proposed here is free, and the two places where
the obvious tool is free only for public repositories (GitHub secret scanning, CodeQL) are
called out with a free alternative, so no gate in this plan depends on a purchase.

---

## Revision log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-11 | First licence and dependency plan. Answers TECH-SPEC open question 6 and constrains open question 4. |
