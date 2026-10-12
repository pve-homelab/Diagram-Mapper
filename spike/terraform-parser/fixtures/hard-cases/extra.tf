resource "random_id" "suffix" {
  byte_length = 4
  provider    = random
}

output "codes" {
  value = local.region_codes
}

resource "time_sleep" "wait" {
  depends_on = [
    random_id.suffix,
  ]

  triggers = {
    id = random_id.suffix.hex
  }
}
