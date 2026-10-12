variable "region" {
  type = string
}

variable "replica_region" {
  type    = string
  default = "eu-west-2"
}

variable "cidr" {
  type        = string
  description = <<DESCRIPTION
The VPC CIDR. The block below is documentation inside a heredoc and must not be
indexed as a real block:

resource "aws_vpc" "documentation_only" {
  cidr_block = "10.0.0.0/16"
}
DESCRIPTION
}

variable "subnet_count" {
  type    = number
  default = 3
}

variable "instances" {
  type = map(object({
    ami  = string
    type = string
  }))
  default = {}
}

variable "ingress_rules" {
  type    = any
  default = []
}

variable "dns_servers" {
  type    = list(string)
  default = ["10.0.0.2"]
}

/*
resource "aws_vpc" "commented_out" {
  cidr_block = "10.1.0.0/16"
}
*/
