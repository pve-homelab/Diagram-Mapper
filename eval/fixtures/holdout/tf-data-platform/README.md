# Fixture: tf-data-platform (HELD-OUT set)

Synthetic Terraform. A streaming data pipeline: Kinesis -> Lambda -> S3 -> Glue.

**Do not read this fixture or its question set while tuning prompts or retrieval.**
See `docs/ai-grounding.md` § 4.4 for the held-out discipline and the CI guard that
enforces it (`eval/holdout-lock.json`).

Deliberate properties:

- `aws_sqs_queue.transform_dlq` is named like a dead-letter queue but is **not wired
  to anything** — no `dead_letter_config` on the Lambda. The honest answer is an
  inference ("named as a DLQ but no reference connects it"), not a verified fact.
- `aws_lambda_function.transform` reads `aws_s3_bucket.curated` through an
  environment variable, so the edge exists but is an attribute-level reference.
- There is no DynamoDB table, no Step Function, and no `aws_cloudwatch_log_group`.
