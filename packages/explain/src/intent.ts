/**
 * Question classification. This decides the single most important thing about
 * an answer: whether a language model is involved at all.
 *
 * Dependency, dependent, blast-radius and count questions are answered from the
 * parsed graph and never inferred. The graph already knows; asking a model to
 * re-derive it only adds a way to be wrong.
 */

import type { Graph } from "./graph.ts";

export type Intent =
  /** "what does X depend on" — graph, outgoing edges */
  | "dependencies"
  /** "what references X", "what breaks if I delete X" (1 hop) — graph, incoming edges */
  | "dependents"
  /** "blast radius of X" — graph, transitive incoming closure */
  | "blast-radius"
  /** "how many X" — graph, counted */
  | "count"
  /** "is X public", "what port", "what is the instance type" — snippet + model */
  | "attribute"
  /** "what is this for", "is this a bastion" — model, inference only */
  | "purpose"
  /** "is there a Y" where Y may not exist — graph symbol table, refusable */
  | "existence"
  /** anything else — snippet + model */
  | "other";

export interface Classification {
  intent: Intent;
  /** True when the answer requires no provider call. */
  deterministic: boolean;
  /** Address the question is about, if resolvable. */
  focus: string | null;
  /** Candidate symbols named in the question that are NOT in the graph. */
  unknownSymbols: string[];
}

const PATTERNS: { intent: Intent; re: RegExp }[] = [
  { intent: "blast-radius", re: /\b(blast radius|knock[- ]on|everything affected|ripple)\b/i },
  {
    intent: "dependents",
    re: /\b(what (?:else )?(?:references|uses|depends on this|points (?:at|to))|who (?:references|uses)|referenced by|used by|what breaks if|if i (?:delete|remove|destroy))\b/i,
  },
  {
    intent: "dependencies",
    re: /\b(what does .* (?:depend on|reference|use)|depends on what|its dependencies|what is it attached to|which .* does it)\b/i,
  },
  { intent: "count", re: /\bhow many\b/i },
  {
    intent: "existence",
    re: /\b(is there (?:a|an|any)|do(?:es)? (?:this|the) repo(?:sitory)? (?:have|contain)|where is the)\b/i,
  },
  {
    intent: "purpose",
    re: /\b(what is (?:this|it) for|why does (?:this|it) exist|what(?:'s| is) the purpose|is (?:this|it) (?:a|an) [a-z]+ (?:host|server|box|node)\b|what role)\b/i,
  },
  {
    intent: "attribute",
    re: /\b(is it (?:public|private|encrypted|exposed|open)|what (?:port|cidr|instance type|engine|version|size|value)|which (?:port|cidr)|open to|publicly|encrypted|retention|allowed)\b/i,
  },
];

export const DETERMINISTIC_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "dependencies",
  "dependents",
  "blast-radius",
  "count",
  "existence",
]);

/** Terraform-address-shaped tokens, e.g. `aws_instance.bastion`, `var.vpc_cidr`. */
export const ADDRESS_TOKEN = /\b((?:data\.)?[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+)\b/g;

/** `.tf` file references in free text. */
export const TF_FILE_TOKEN = /\b([A-Za-z0-9_./-]+\.tf(?:\.json)?)\b/g;

function symbolTable(g: Graph): Set<string> {
  return new Set(g.nodes.map((n) => n.address));
}

/**
 * Resolve the subject of a question. `explicitNode` is what the UI passes when
 * the user asked from a selected node; it always wins over text matching,
 * because text matching is a guess and the selection is a fact.
 */
export function classify(
  g: Graph,
  question: string,
  explicitNode: string | null = null,
): Classification {
  const symbols = symbolTable(g);
  const named = [...question.matchAll(ADDRESS_TOKEN)].map((m) => m[1]!);
  const known = named.filter((s) => symbols.has(s));
  const unknownSymbols = [...new Set(named.filter((s) => !symbols.has(s)))];

  let focus = explicitNode ?? known[0] ?? null;
  if (!focus) {
    // Fall back to a unique `name` match ("the bastion", "the primary database").
    const words = question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [];
    const hits = g.nodes.filter((n) => words.includes(n.name.toLowerCase()));
    if (hits.length === 1) focus = hits[0]!.address;
  }

  let intent: Intent = "other";
  for (const p of PATTERNS) {
    if (p.re.test(question)) {
      intent = p.intent;
      break;
    }
  }
  // A question naming a symbol that does not exist is an existence question
  // regardless of phrasing — the honest answer is "that is not in your
  // repository", and no snippet retrieval can change that.
  if (unknownSymbols.length > 0 && known.length === 0) intent = "existence";

  return {
    intent,
    deterministic: DETERMINISTIC_INTENTS.has(intent),
    focus,
    unknownSymbols,
  };
}
