# Fixture: tf-core-web (TUNING set)

Synthetic Terraform. Not derived from any customer repository and not deployed anywhere.
A deliberately small public-web stack: VPC -> ALB -> ECS service -> RDS, plus a bastion
and an assets bucket.

Deliberate properties the question set depends on:

- `aws_security_group.bastion` allows `0.0.0.0/0` on port 22 — the canonical
  "verified fact with a citation" case.
- `aws_instance.bastion` has no `Name`/`Role` tag and no description anywhere, so
  "is this a bastion host?" can only be answered as an **inference**.
- `aws_db_instance.primary` has `publicly_accessible = false` and `storage_encrypted = true`.
- There is **no S3 bucket named `backups`** and **no CloudFront distribution**. Questions
  that ask about them must be refused, not answered.
- `aws_s3_bucket.assets` is referenced by nothing — an orphan node, used to test
  "what references this" returning an empty set rather than an invented answer.

Do not edit this fixture without updating `eval/questions/tuning/*.json`; line numbers
are asserted.
