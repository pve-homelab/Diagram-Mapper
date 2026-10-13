/**
 * The provider seam.
 *
 * Claude is the launch provider. Everything the engine knows about it is behind
 * this interface, so replacing it is a new file, not a refactor. Nothing else in
 * the package imports `@anthropic-ai/sdk`.
 *
 * Keys come from the environment or, for free-tier tenants, from the decrypted
 * per-tenant key passed in at call time. A key is never read from source, never
 * logged, and never included in an error message.
 */

import Anthropic from "@anthropic-ai/sdk";
import { OUTPUT_FORMAT } from "./prompt.ts";

export interface ProviderRequest {
  system: string;
  userContent: string;
  maxOutputTokens: number;
}

export interface ProviderResponse {
  /** Raw JSON text matching RESPONSE_SCHEMA. */
  text: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** True when the counts came from the provider rather than an estimate. */
  measured: boolean;
}

export interface ExplanationProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  /** Free endpoint. Used to measure input cost without paying for inference. */
  countInputTokens(req: ProviderRequest): Promise<number>;
}

export class AnthropicProvider implements ExplanationProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(
    model: string = process.env.EXPLAIN_MODEL ?? "claude-sonnet-5",
    apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey) throw new Error("no provider credential available for this request");
    this.model = model;
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxOutputTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.userContent }],
      output_config: { format: OUTPUT_FORMAT },
    } as Parameters<Anthropic["messages"]["create"]>[0]);

    const text = ("content" in res ? res.content : [])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    const u = "usage" in res ? res.usage : undefined;
    return {
      text,
      model: this.model,
      inputTokens: u?.input_tokens ?? 0,
      cachedInputTokens: u?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      measured: true,
    };
  }

  async countInputTokens(req: ProviderRequest): Promise<number> {
    const res = await this.client.messages.countTokens({
      model: this.model,
      system: req.system,
      messages: [{ role: "user", content: req.userContent }],
    });
    return res.input_tokens;
  }
}

/**
 * Replays one committed response (a "cassette").
 *
 * PR CI runs the whole pipeline through this: deterministic, free, and it
 * exercises retrieval, prompt construction and the grounding gate exactly as
 * production does. The adversarial cassettes are the point — they contain
 * responses that invent resources, cite files that do not exist and obey
 * injected instructions, and the build must fail on every one of them.
 *
 * The harness constructs one per question, keyed by question id, because the
 * request itself carries a per-request nonce and is not a stable key.
 */
export class CassetteProvider implements ExplanationProvider {
  readonly name = "cassette";
  readonly model: string;
  private responseText: string;
  private counts: { input: number; output: number };
  constructor(responseText: string, model = "cassette", counts = { input: 0, output: 0 }) {
    this.responseText = responseText;
    this.model = model;
    this.counts = counts;
  }
  async complete(): Promise<ProviderResponse> {
    return {
      text: this.responseText,
      model: this.model,
      inputTokens: this.counts.input,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: this.counts.output,
      measured: false,
    };
  }
  async countInputTokens(): Promise<number> {
    return this.counts.input;
  }
}
