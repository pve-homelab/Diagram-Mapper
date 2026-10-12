# Cassettes — recorded provider responses

Each file is one recorded provider response for one question id.

```jsonc
{
  "model": "claude-sonnet-5",   // model the response is attributed to
  "inputTokens": 0,              // 0 = not measured (hand-authored cassette)
  "outputTokens": 0,
  "response": { ... }            // the response object, serialised by the runner
  // or "text": "..."            // raw text, for malformed-output cases
}
```

`eval/cassettes/*.json` are the honest answers: what a correctly behaving model
returns. `eval/cassettes/adv/*.json` are the adversarial ones — responses that
invent a resource, a dependency or a value, cite a file that does not exist, or
obey an instruction found in the customer's repository. **Every file under
`adv/` must cause the build to fail if the grounding gate ever accepts it.**

Replaying a cassette exercises retrieval, prompt construction, the grounding
gate and cost accounting exactly as production does — the provider seam is the
only thing substituted. What it does *not* measure is whether the real model
behaves well; that needs `--provider=anthropic` and a key. See
`docs/ai-grounding.md` § 4.3.

Hand-authored cassettes carry `inputTokens: 0`, and the runner reports them as
unmeasured rather than folding a zero into a cost average.
