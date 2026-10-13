terraform {
  required_version = ">= 1.6.0"
}

provider "aws" {
  region = "us-east-1"
}

locals {
  prefix = "dp"
  tags = {
    Owner = "data-platform"
  }
}

resource "aws_kinesis_stream" "ingest" {
  name             = "${local.prefix}-ingest"
  shard_count      = 4
  retention_period = 48
}

resource "aws_lambda_function" "transform" {
  function_name = "${local.prefix}-transform"
  runtime       = "python3.12"
  handler       = "main.handler"
  role          = aws_iam_role.transform.arn
  memory_size   = 1024
  timeout       = 60

  environment {
    variables = {
      OUTPUT_BUCKET = aws_s3_bucket.curated.id
    }
  }
}

resource "aws_lambda_event_source_mapping" "ingest_to_transform" {
  event_source_arn  = aws_kinesis_stream.ingest.arn
  function_name     = aws_lambda_function.transform.arn
  starting_position = "LATEST"
  batch_size        = 100
}

resource "aws_iam_role" "transform" {
  name               = "${local.prefix}-transform"
  assume_role_policy = file("policies/lambda-assume-role.json")
}

resource "aws_s3_bucket" "curated" {
  bucket = "dp-curated-datasets"
}

resource "aws_s3_bucket_versioning" "curated" {
  bucket = aws_s3_bucket.curated.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_glue_catalog_database" "curated" {
  name = "dp_curated"
}

resource "aws_glue_crawler" "curated" {
  name          = "${local.prefix}-curated"
  role          = aws_iam_role.transform.arn
  database_name = aws_glue_catalog_database.curated.name

  s3_target {
    path = "s3://${aws_s3_bucket.curated.id}/tables/"
  }
}

resource "aws_sqs_queue" "transform_dlq" {
  name                      = "${local.prefix}-transform-dlq"
  message_retention_seconds = 1209600
}

output "curated_bucket" {
  value = aws_s3_bucket.curated.id
}
