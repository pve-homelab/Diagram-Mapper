resource "random_id" "suffix" {
  byte_length = 4
  provider    = random
}

output "codes" {
  value = local.region_codes
}
