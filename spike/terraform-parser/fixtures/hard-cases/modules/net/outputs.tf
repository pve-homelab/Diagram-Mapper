output "first_subnet_id" {
  value = var.subnet_ids[0]
}

output "route_table_id" {
  value = aws_route_table.this.id
}
