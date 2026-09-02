terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24, < 6.0"
    }
  }
}

resource "cloudflare_r2_bucket" "this" {
  account_id    = var.account_id
  name          = var.bucket_name
  jurisdiction  = var.jurisdiction
  location      = var.location
  storage_class = var.storage_class

  lifecycle {
    prevent_destroy = true
  }
}
