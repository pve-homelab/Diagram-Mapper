/**
 * Cost control.
 *
 * Cost is a product constraint, not an optimisation. An explanation that costs
 * more than the subscription margin is a broken feature however good it is, so
 * every number here is in money per unit of customer value — per explanation
 * and per repository analysed — and every number is derived from measured
 * token counts, never from a guess about them.
 */

/** USD per million tokens. Anthropic first-party API list prices. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** 5-minute TTL cache write: 1.25x input. */
  cacheWrite5mPerMTok: number;
  /** Cache read: 0.1x input. */
  cacheReadPerMTok: number;
  contextWindow: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWrite5mPerMTok: 6.25,
    cacheReadPerMTok: 0.5,
    contextWindow: 1_000_000,
  },
  "claude-sonnet-5": {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWrite5mPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_000_000,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWrite5mPerMTok: 1.25,
    cacheReadPerMTok: 0.1,
    contextWindow: 200_000,
  },
};

/**
 * Committed conversion rate, with a date, so a cost figure in this repository
 * is reproducible. Re-check quarterly; a drift of a few percent does not change
 * any decision the cost model supports.
 */
export const USD_TO_GBP = { rate: 0.79, asOf: "2026-10-11" } as const;

export function gbp(usd: number): number {
  return usd * USD_TO_GBP.rate;
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function costUsd(model: string, t: TokenCounts): number {
  const p = MODEL_PRICING[model];
  if (!p) throw new Error(`no pricing for model ${model}`);
  const uncachedInput = Math.max(0, t.inputTokens - t.cachedInputTokens - t.cacheWriteTokens);
  return (
    (uncachedInput * p.inputPerMTok +
      t.cachedInputTokens * p.cacheReadPerMTok +
      t.cacheWriteTokens * p.cacheWrite5mPerMTok +
      t.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

/* ------------------------------------------------------------------ plans */

export interface Plan {
  id: string;
  /** Monthly subscription price in GBP, ex VAT. */
  priceGbp: number;
  /** Hard monthly token cap, input + output, across the tenant. */
  monthlyTokenCap: number;
  requiresOwnApiKey: boolean;
  repoLimit: number;
}

/**
 * Caps are set so that AI cost cannot exceed ~12% of subscription revenue at
 * 100% cap utilisation on the launch model. Everything above that is gross
 * margin for hosting and the business. A tenant that reaches its cap keeps the
 * diagram, the node panel and search — only chat stops (TECH-SPEC §4 failure
 * table), so a cap is a degradation, never an outage.
 */
export const PLANS: Record<string, Plan> = {
  free: { id: "free", priceGbp: 0, monthlyTokenCap: 0, requiresOwnApiKey: true, repoLimit: 1 },
  solo: { id: "solo", priceGbp: 12, monthlyTokenCap: 1_200_000, requiresOwnApiKey: false, repoLimit: 3 },
  team: { id: "team", priceGbp: 49, monthlyTokenCap: 6_000_000, requiresOwnApiKey: false, repoLimit: 15 },
};

/** Worst-case monthly AI spend if a tenant burns its entire cap. */
export function capCostGbp(plan: Plan, model: string, outputShare = 0.2): number {
  const out = plan.monthlyTokenCap * outputShare;
  const inp = plan.monthlyTokenCap - out;
  return gbp(costUsd(model, { inputTokens: inp, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: out }));
}

export function capMarginShare(plan: Plan, model: string): number {
  if (plan.priceGbp === 0) return 0;
  return capCostGbp(plan, model) / plan.priceGbp;
}

/**
 * How many explanations a cap buys, given a measured mean cost per explanation.
 * This is the number that goes in front of a customer, not the token cap.
 */
export function explanationsPerMonth(plan: Plan, meanTokensPerExplanation: number): number {
  if (meanTokensPerExplanation <= 0) return 0;
  return Math.floor(plan.monthlyTokenCap / meanTokensPerExplanation);
}

/** Reserve-then-reconcile: what we hold against the cap before calling out. */
export function reservation(estimatedInputTokens: number, maxOutputTokens: number): number {
  return estimatedInputTokens + maxOutputTokens;
}
