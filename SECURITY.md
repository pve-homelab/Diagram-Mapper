# Security Policy

> **DRAFT — not yet publishable.** Two placeholders must be filled by the CEO before this
> file goes public: the reporting address (`<SECURITY-CONTACT>`) and the confirmation that
> a private triage channel exists. Publishing this document with a placeholder address is
> worse than publishing nothing, because it invites a report that nobody receives.
>
> Raised by threat model finding **F-16** (`docs/THREAT-MODEL.md`): the company currently
> has **no confidential security-advisory route**. A vulnerability report today lands in a
> normal issue thread, which is a disclosure incident of its own making. Drafted by the
> QA & Security Engineer; the contact address and the private route are the CEO's to own.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security vulnerability.**
A public report is itself an exposure: it tells everyone about the weakness before there
is a fix.

Report privately, by either route:

1. **GitHub private vulnerability reporting** — the "Report a vulnerability" button under
   the repository's **Security** tab. This is free on public and private repositories, it
   creates a private advisory thread visible only to maintainers and you, and it is the
   preferred route because the discussion stays attached to the code.
2. **Email** — `<SECURITY-CONTACT>`. If you want to encrypt, ask for a key in a first
   message that contains no vulnerability detail.

### What to include

The more of this you can give us, the faster the fix:

- the vulnerability class and the affected URL, endpoint, or component;
- the steps to reproduce, including any account or tenant you used;
- the impact you believe it has, and what an attacker gains;
- any proof-of-concept — as an attachment to the private report, never in a public place;
- whether you have told anyone else, and whether you intend to publish.

### What not to include

- **Another customer's data.** If you find a route to data that is not yours, stop, tell
  us the route, and do not collect the data. A screenshot proving cross-tenant access
  should show the fact of access, with the content redacted.
- **Working credentials.** If you find a leaked secret, report where it is. Do not use it
  beyond the minimum needed to confirm it is live, and tell us if you did.

## Our commitments to you

| Stage | We will |
|---|---|
| Acknowledgement | Confirm we received your report within **3 working days** |
| Initial assessment | Give you our severity assessment and whether we can reproduce it within **10 working days** |
| Progress | Update you at least every **14 days** while it is open |
| Resolution | Tell you when it is fixed, and what the fix was |

We will credit you by name or handle in the advisory if you want it, and not if you do
not. We will not take legal action against you for research conducted in good faith
within the scope below.

These windows are deliberately modest. This is a small team, and a promise of a 24-hour
response that we miss is worth less than a 3-day promise we keep.

## Scope

**In scope**

- The Diagram Mapper web application and its API.
- Authentication, authorisation, session handling, and **tenant isolation** — a
  cross-tenant read is the report we most want to receive.
- The Infrastructure-as-Code parser, including malformed or hostile input.
- Handling of repository content sent to the AI provider, and prompt injection via
  repository content.
- Secret handling, token storage, and anything that appears in a log or an error message.
- Billing and subscription flows.

**Out of scope**

- Denial of service by volume, load testing, or automated scanning that degrades the
  service for other users. Report the *absence of a rate limit* as a finding; do not
  demonstrate it by exhausting one.
- Social engineering of our team, our customers, or our suppliers; physical attacks.
- Vulnerabilities in third-party services we use (GitHub, Stripe, Anthropic, our host).
  Report those to them; tell us if our configuration of them is the problem.
- **Any testing against another customer's account, repository, or data.** Use your own.
  If you need a second tenant to demonstrate an isolation flaw, ask us and we will provide
  test accounts.
- Reports consisting only of automated scanner output with no demonstrated impact; missing
  hardening headers with no exploitation path; outdated-library claims with no reachable
  vulnerable path. We will read them, and we will likely fix them, but they are not
  treated as vulnerability reports.

## Safe harbour

If you follow this policy — report privately, stay within scope, avoid other people's
data, do not degrade the service, and give us reasonable time before publishing — we will
treat your research as authorised, will not pursue or support any legal claim against you
for it, and will work with you on disclosure timing. We ask for **90 days** before public
disclosure, or sooner by agreement once a fix has shipped.

If you are unsure whether something is in scope, ask first. An email asking "may I test
X?" is always in scope.

## What we do not offer

We have **no paid bug bounty**. We are a pre-revenue product and we would rather be honest
about that than imply a reward we cannot fund. We offer acknowledgement, credit, a fast
and respectful response, and a straight answer about what we fixed.

## Our own security posture, stated plainly

So you know what to expect and what to test:

- Repository access is a **read-only GitHub App install**, never a personal access token.
- Tokens are **encrypted at rest** with authenticated encryption.
- **Raw Infrastructure-as-Code is not retained after parsing** — we keep the resource
  graph plus file and line references. Snippets are re-fetched on demand to display or to
  answer a question.
- Tenant data is isolated by **row-level security in PostgreSQL**, enforced at the
  database rather than only in application code.
- Only the snippets needed to answer the question you asked reach the AI provider. Nothing
  else about your configuration is sent.

If you find any of those five statements to be untrue in the running product, that is a
high-severity report and we want it immediately. A public claim the code does not honour
is a defect we treat as seriously as a vulnerability.

---

*Draft v0.1 — 2026-10-12. Owner: QA & Security Engineer. Blocking items for the CEO: the
reporting address, the private triage channel, and sign-off on the response windows and
safe-harbour wording above (the safe-harbour paragraph has legal effect and should be
read by whoever reviews the terms of service).*
