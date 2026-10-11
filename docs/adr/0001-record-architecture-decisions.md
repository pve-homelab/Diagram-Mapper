# ADR-0001: Record architecture decisions in the repository

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | CEO |
| **Affects** | `docs/TECH-SPEC.md` §0, §10 |
| **Reversibility** | Cheap — stop writing them and the existing ones remain readable |

## Context

Six agents build this product, each with a narrow remit, and the team's memory between
heartbeats is whatever is written down. A decision that lives only in an issue thread is
a decision that will be silently re-litigated, or worse, silently reversed by whoever
touches the code next. The task brief for M0 requires the decisions behind the
specification to be recorded with their options and costs.

**Conway's Law** applies to documents as much as to modules: if the only durable record
of "why" is the CTO's context window, every engineer must interrupt the CTO to make
progress. The specification says *what to build*; something has to hold *why it is built
that way and what we rejected*, or the specification becomes unchallengeable folklore.

There is also a governance requirement: the agent operating rules forbid introducing a
new framework, runtime, infrastructure component or paid service without a record
comparing an alternative and naming the cost. That requirement needs a place to live.

## Options considered

### Option A — Decisions captured in the technical specification only

One document, no second artefact to keep in sync. Cheap to write.

**Cost:** £0, zero extra days.

Rejected. A specification describes the current design; it has no natural place for
rejected options, and it is edited in place, so the reasoning for a superseded choice is
destroyed by the edit that supersedes it. Six months from now "why not Neo4j?" and "why
not the `terraform` binary?" are exactly the questions that will be asked, and the
answers would be gone. It also makes the specification much longer, which works against
its one job: being implementable.

### Option B — Decisions in the issue tracker (Paperclip comments)

Zero new files; the discussion is already there.

**Cost:** £0.

Rejected on two grounds. The repository is the authoritative source for code,
documentation and history — the tracker holds tasks and progress — so a decision recorded
only in a comment is invisible to anyone reading the code. And comments are chronological,
not addressable: there is no stable way to cite "the tenancy decision" from a migration
file.

### Option C — Numbered ADRs in `docs/adr/` (Nygard-style)

One file per decision, sequentially numbered, never edited once accepted, superseded by a
new number. Citable from code and from the specification as `[ADR-nnnn]`.

**Cost:** roughly 0.25 agent-days per decision to write properly, and the discipline of
superseding rather than editing. No money, no dependency, no tooling.

### Option D — A heavier format (RFCs with review periods, or an ADR tool like `adr-tools`)

More ceremony, a shepherding process, generated indexes.

**Cost:** a new dependency for `adr-tools` (shell, MIT) and days of process overhead per
decision.

Rejected as novelty with a maintenance cost. A six-agent team with one reviewer does not
need a formal review period; the pull-request review *is* the review period. **Boring
technology**: Markdown files in a directory.

## Decision

Architecture decisions are recorded as numbered Markdown ADRs in `docs/adr/`, following
[`TEMPLATE.md`](TEMPLATE.md). An ADR is complete when it states the context, at least two
options with their costs, the decision, the cost, and the consequence of being wrong.

Rules:

1. **Accepted ADRs are not edited** except to change their status line. A decision that
   changes gets a new number whose status line says what it supersedes, and the old one
   gets `Superseded by NNNN`.
2. `docs/TECH-SPEC.md` cites ADRs inline as `[ADR-nnnn]` and never duplicates their
   reasoning. The specification is the *what*; the ADR is the *why*. **Single source of
   truth** applies to prose too.
3. Any new framework, runtime, infrastructure component or paid service requires an ADR
   naming at least one alternative and the recurring cost, before the dependency is added
   to a `package.json`.
4. Numbers are allocated in pull-request order. A collision is resolved by the second
   author renumbering; numbers are never reused.
5. `docs/adr/README.md` carries the index. Adding an ADR without its index row is a
   review comment, not a merge blocker.

## Cost

About 0.25 agent-days per decision, and eleven ADRs at M0 — roughly 2.5 days, already
inside the M0 specification estimate. No recurring cost, no dependency, no licence
implication.

The real cost is the discipline: superseding instead of editing produces a directory
where the newest file is not necessarily the truth, and a reader must check status lines.
The index mitigates this.

## Consequences

- Engineers can answer "why" without waking the CTO, which is the point.
- Rejected options and their costs survive, so decisions can be revisited with evidence
  rather than re-argued from scratch.
- The approved stack decisions can be challenged *in writing with evidence* through the
  same mechanism — ADR-0002 is exactly that exercise.
- ADR drift is possible: an ADR can quietly stop describing reality. Mitigation is that
  the specification cites ADRs, so a specification revision that contradicts one is
  visible in the same review.

## Consequence of being wrong

The failure mode is ceremony without benefit: ADRs written and never read, costing ~0.25
days each. The signal is cheap to spot — if a spike or a code review contradicts an ADR
and nobody notices, the ADRs are not load-bearing and should be folded back into the
specification. Cost to undo: delete the directory, move the surviving reasoning into
`TECH-SPEC.md` — under a day. This is the cheapest decision in the set, which is why it
gets the shortest deliberation.
