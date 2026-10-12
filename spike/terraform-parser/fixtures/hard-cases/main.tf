// Golden fixture: every construct that defeated an earlier version of the
// extractor, in one root module. The expected graph in
// fixtures/hard-cases.expected.json was written by hand from THIS file -- it is
// not captured output. Line numbers in the expectation are line numbers here, so
// edits to this file must be reflected there deliberately.

terraform {
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.region
}

provider "aws" {
  alias  = "replica"
  region = var.replica_region
}

data "aws_caller_identity" "current" {}

data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "example-state"
    key    = "network/terraform.tfstate"
  }
}

locals {
  # A for-expression binds `s`; `s.id` is a loop variable, not a resource.
  subnet_ids = [for s in aws_subnet.private : s.id]

  # The binding is used inside an interpolated string literal. The literal also
  # contains a filename with a dot, which must not be read as a traversal.
  arns = [
    for s in aws_subnet.private :
    "arn:${data.aws_caller_identity.current.account_id}:subnet/${s.id}/spec.json"
  ]

  # Interpolation nested inside a quoted string, with quotes inside it. This is
  # what desynchronised the block scanner before.
  dns = "[${join(", ", formatlist("\"%s\"", var.dns_servers))}]"

  account = data.aws_caller_identity.current.account_id
}

resource "aws_vpc" "main" {
  cidr_block = var.cidr
  tags       = { Name = "main", Owner = "aws_vpc.decoy" }
}

# count with a non-literal expression: cardinality is not statically known.
resource "aws_subnet" "private" {
  count      = var.subnet_count
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
}

# count with a literal: cardinality IS statically known.
resource "aws_subnet" "public" {
  count      = 2
  vpc_id     = aws_vpc.main.id
  cidr_block = cidrsubnet(var.cidr, 8, count.index + 100)
}

# for_each over a variable: not statically known. Also references an indexed
# resource and an indexed module output.
resource "aws_instance" "app" {
  for_each      = var.instances
  subnet_id     = aws_subnet.private[0].id
  ami           = each.value.ami
  instance_type = each.value.type
  provider      = aws.replica

  depends_on = [aws_vpc.main]

  lifecycle {
    # Self-relative attribute paths, NOT references to other objects.
    ignore_changes = [
      tags["LastSeen"],
      root_block_device[0].volume_size,
    ]
  }
}

resource "aws_security_group" "app" {
  vpc_id = aws_vpc.main.id

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port = ingress.value.from
      to_port   = ingress.value.to
      # Nested dynamic block with a renamed iterator.
      dynamic "cidr_blocks" {
        for_each = ingress.value.cidrs
        iterator = cidr
        content {
          value = cidr.value
        }
      }
    }
  }
}

module "net" {
  source     = "./modules/net"
  vpc_id     = aws_vpc.main.id
  subnet_ids = local.subnet_ids
}

# An output that exists in the child module, and one that does not.
resource "aws_route_table_association" "a" {
  subnet_id      = module.net.first_subnet_id
  route_table_id = module.net.nonexistent_output
}

# A reference to a resource that is not declared anywhere: genuinely unresolved.
resource "aws_eip" "nat" {
  instance = aws_instance.absent.id
}
