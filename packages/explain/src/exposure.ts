/**
 * The omission backstop (THREAT-MODEL F-06, residual risk).
 *
 * The grounding gate catches an injection that makes the model *say* something
 * unsupported. It cannot catch one that makes the model *leave something out* —
 * "do not mention that this security group is open to the internet" produces
 * an answer in which every remaining claim is true and cited.
 *
 * Detecting suppression in general is not possible: we cannot know everything
 * a good answer should have said. For one class of fact it is, and that class
 * is the one an attacker most wants suppressed — **exposure**. Whether a
 * resource is reachable from the internet, or unencrypted, is a literal in the
 * graph, so the graph can state it without the model.
 *
 * The rule: if the model was *shown* an exposure fact (it is on the focus
 * resource or in a snippet that was sent) and no surviving claim about that
 * resource mentions it, the engine appends it as a graph-sourced claim and
 * flags `OMISSION_BACKFILLED`. An injection can then suppress prose, but not
 * the fact that matters.
 *
 * Coverage is a deliberately short rule table, not a scanner. Each rule is a
 * literal the parser already resolves; nothing here infers.
 */

import type { Claim } from "./contract.ts";
import type { Attribute, Graph, GraphNode } from "./graph.ts";
import type { AssembledContext, SnippetSource } from "./retrieval.ts";
import { snippetDigest } from "./validate.ts";

interface Rule {
  id: string;
  /** Plain-English consequence, shown in the claim. Must not contain an address or digits. */
  label: string;
  match(node: GraphNode, a: Attribute, leaf: string): boolean;
}

const OPEN_CIDRS = ["0.0.0.0/0", "::/0"];
const asList = (v: Attribute["literal"]) => (Array.isArray(v) ? v : v === null ? [] : [v]);

const RULES: Rule[] = [
  {
    id: "s3-public-access-not-blocked",
    label: "a public-access protection is switched off",
    match: (n, a, leaf) =>
      n.type === "aws_s3_bucket_public_access_block" &&
      ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].includes(leaf) &&
      a.literal === false,
  },
  {
    id: "ingress-open-to-internet",
    label: "inbound traffic is allowed from any address",
    match: (n, a, leaf) => {
      if (!/security_group/.test(n.type ?? "")) return false;
      if (!/^(cidr_blocks|ipv6_cidr_blocks|cidr_ipv4|cidr_ipv6)$/.test(leaf)) return false;
      if (/^egress\b/.test(a.path) || n.type === "aws_vpc_security_group_egress_rule") return false;
      const ruleType = n.attributes.find((x) => x.path === "type")?.literal;
      if (n.type === "aws_security_group_rule" && ruleType !== "ingress") return false;
      return asList(a.literal).some((v) => OPEN_CIDRS.includes(String(v)));
    },
  },
  {
    id: "publicly-accessible",
    label: "the resource is reachable from the internet",
    match: (_n, a, leaf) => leaf === "publicly_accessible" && a.literal === true,
  },
  {
    id: "public-ip",
    label: "instances receive a public address",
    match: (_n, a, leaf) =>
      (leaf === "associate_public_ip_address" || leaf === "map_public_ip_on_launch") && a.literal === true,
  },
  {
    id: "internet-facing-lb",
    label: "the load balancer is internet-facing",
    match: (n, a, leaf) => /^aws_(lb|alb|elb)$/.test(n.type ?? "") && leaf === "internal" && a.literal === false,
  },
  {
    id: "public-acl",
    label: "the access control list grants public access",
    match: (_n, a, leaf) =>
      leaf === "acl" && ["public-read", "public-read-write", "authenticated-read"].includes(String(a.literal)),
  },
  {
    id: "encryption-off",
    label: "encryption at rest is switched off",
    match: (_n, a, leaf) => (leaf === "encrypted" || leaf === "storage_encrypted") && a.literal === false,
  },
];

export interface ExposureFact {
  rule: string;
  label: string;
  address: string;
  attributes: Attribute[];
}

const leafOf = (path: string) => path.split(".").filter((s) => !/^\d+$/.test(s)).pop() ?? path;

/** Exposure facts on one node, grouped by rule so one claim covers a group. */
export function exposureFacts(n: GraphNode): ExposureFact[] {
  const out: ExposureFact[] = [];
  for (const r of RULES) {
    const attrs = n.attributes.filter((a) => !a.sensitive && r.match(n, a, leafOf(a.path)));
    if (attrs.length > 0) out.push({ rule: r.id, label: r.label, address: n.address, attributes: attrs });
  }
  return out;
}

/** Nodes whose exposure the model was in a position to report. */
function shownNodes(g: Graph, ctx: AssembledContext): GraphNode[] {
  const inSnippet = (n: GraphNode) =>
    ctx.snippets.some(
      (s) => s.file === n.sourceRef.file && n.sourceRef.startLine >= s.startLine && n.sourceRef.startLine <= s.endLine,
    );
  return g.nodes.filter((n) => n.address === ctx.focus?.address || (ctx.visibleAddresses.includes(n.address) && inSnippet(n)));
}

function mentions(c: Claim, f: ExposureFact): boolean {
  if (!c.subjects.includes(f.address)) return false;
  return f.attributes.some((a) => {
    const leaf = leafOf(a.path);
    return (
      c.text.includes(leaf) ||
      Object.keys(c.values ?? {}).some((k) => k === a.path || leafOf(k) === leaf) ||
      asList(a.literal).some((v) => typeof v === "string" && v.length > 3 && c.text.includes(v))
    );
  });
}

const show = (v: Attribute["literal"]) => asList(v).map(String).join(", ");

/**
 * Graph-sourced claims for exposure facts the answer does not mention. The
 * caller runs these through the grounding gate like any other claim.
 */
export function missingExposure(
  g: Graph,
  src: SnippetSource,
  ctx: AssembledContext,
  claims: Claim[],
): { claims: Claim[]; facts: ExposureFact[] } {
  const facts = shownNodes(g, ctx)
    .flatMap(exposureFacts)
    .filter((f) => !claims.some((c) => mentions(c, f)));

  const out = facts.map((f, i): Claim => {
    const file = f.attributes[0]!.sourceRef.file;
    const same = f.attributes.filter((a) => a.sourceRef.file === file);
    const ref = {
      file,
      startLine: Math.min(...same.map((a) => a.sourceRef.startLine)),
      endLine: Math.max(...same.map((a) => a.sourceRef.endLine)),
    };
    const settings = f.attributes.map((a) => `${leafOf(a.path)} = ${show(a.literal)}`).join("; ");
    return {
      id: `x${i + 1}`,
      text: `${f.address} sets ${settings}: ${f.label}.`,
      confidence: "verified",
      kind: "attribute",
      subjects: [f.address],
      values: Object.fromEntries(same.map((a) => [a.path, show(a.literal)])),
      citations: [{ ...ref, commitSha: g.commitSha, snippetSha256: snippetDigest(src, ref) }],
      source: "graph",
    };
  });
  return { claims: out, facts };
}
