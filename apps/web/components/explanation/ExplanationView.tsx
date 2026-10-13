import type {
  Citation,
  Claim,
  Confidence,
  Explanation,
  Flag,
  UnansweredReason,
} from "@diagram-mapper/explain/contract";
import { citationHref, citationLabel } from "../../lib/explanation/citation-href.ts";
import styles from "./ExplanationView.module.css";

/**
 * Renders an explanation response (docs/ai-grounding.md section 2.4).
 *
 * Safety rule (threat model F-06): every string in an `Explanation` is attacker-reachable,
 * because the model reads customer repository content. So every string is rendered as a
 * React text node, which React escapes. There is no markdown, no HTML, no images and no
 * autolinking; the only links are citations, and their hrefs are built by `citationHref`
 * from validated parts, never taken from the model. Raw-HTML sinks are banned repo-wide by
 * Biome (`noDangerouslySetInnerHtml`) and by apps/web/lib/no-raw-html.test.ts.
 */

const CONFIDENCE: Record<Confidence, { label: string; glyph: string; className: string }> = {
  // The glyph is a second, non-colour cue; the label text is the primary one.
  verified: { label: "Verified", glyph: "✓", className: styles.verified ?? "" },
  inferred: { label: "Inferred", glyph: "≈", className: styles.inferred ?? "" },
  "general-knowledge": {
    label: "General AWS knowledge",
    glyph: "i",
    className: styles.general ?? "",
  },
};

const UNANSWERED_COPY: Record<UnansweredReason, string> = {
  "not-in-repository": "Not answerable from your configuration",
  "needs-runtime-state": "Needs live cloud state, which Diagram Mapper does not read",
  "out-of-scope": "Outside what Diagram Mapper explains",
};

function CitationLink({ citation }: { citation: Citation }) {
  const label = citationLabel(citation);
  const href = citationHref(citation);
  if (href === null) {
    // Never linkify something we could not validate. Show it, inert, so nothing is hidden.
    return <span className={styles.citationInert}>{label}</span>;
  }
  return (
    <a className={styles.citation} href={href} aria-label={`Open source ${label}`}>
      {label}
    </a>
  );
}

function ClaimView({ claim }: { claim: Claim }) {
  const c = CONFIDENCE[claim.confidence];
  return (
    <span className={`${styles.claim} ${c.className}`} data-claim-id={claim.id}>
      <span className={styles.badge}>
        <span aria-hidden="true" className={styles.glyph}>
          {c.glyph}
        </span>
        {c.label}
      </span>{" "}
      <span className={styles.claimText}>{claim.text}</span>
      {claim.citations.length > 0 && (
        <span className={styles.citations}>
          {" "}
          {claim.citations.map((cit) => (
            <CitationLink key={`${cit.file}:${cit.startLine}-${cit.endLine}`} citation={cit} />
          ))}
        </span>
      )}
    </span>
  );
}

function InjectionNotice({ flag }: { flag: Flag }) {
  return (
    <div className={styles.notice} role="note">
      <p className={styles.noticeTitle}>
        This repository contains text addressed to an AI assistant
      </p>
      <p>
        Diagram Mapper treated it as data, not as instructions. Review it before trusting comments
        or descriptions in this file.
        {flag.where && (
          <>
            {" "}
            <span className={styles.citationInert}>{citationLabel(flag.where)}</span>
          </>
        )}
      </p>
    </div>
  );
}

export function ExplanationView({ explanation }: { explanation: Explanation }) {
  const claims = new Map(explanation.claims.map((c) => [c.id, c]));
  const injection = explanation.flags.filter((f) => f.code === "INJECTION_ATTEMPT_IN_SOURCE");

  return (
    <article className={styles.root} aria-label="Explanation">
      {injection.map((f, i) => (
        // Flags carry no id; order is stable within one response.
        // biome-ignore lint/suspicious/noArrayIndexKey: stable, never reordered
        <InjectionNotice key={i} flag={f} />
      ))}

      {explanation.answerPath === "deterministic" && (
        <p className={styles.provenance}>From the parsed graph</p>
      )}

      {explanation.narrative.length > 0 && (
        <p className={styles.narrative}>
          {explanation.narrative.map((block, i) => {
            if (block.type === "connective") {
              // biome-ignore lint/suspicious/noArrayIndexKey: narrative order is the identity
              return <span key={i}>{block.text} </span>;
            }
            const claim = claims.get(block.claimId);
            // The server guarantees this; if it ever fails, drop the block rather than invent.
            if (!claim) return null;
            return (
              <span key={claim.id}>
                <ClaimView claim={claim} />{" "}
              </span>
            );
          })}
        </p>
      )}

      {explanation.unanswered.length > 0 && (
        <ul className={styles.unanswered}>
          {explanation.unanswered.map((u, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable within one response
            <li key={i}>
              <strong>{UNANSWERED_COPY[u.reason]}:</strong> {u.detail}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
