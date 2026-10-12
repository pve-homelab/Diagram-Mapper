variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

resource "aws_route_table" "this" {
  vpc_id = var.vpc_id
}
