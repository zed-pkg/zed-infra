terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Local state by default; switch to an R2/S3 remote backend for teams.
  # backend "s3" {
  #   bucket                      = "zed-tfstate"
  #   key                         = "cloudflare/terraform.tfstate"
  #   region                      = "auto"
  #   endpoints                   = { s3 = "https://<account_id>.r2.cloudflarestorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Artifact storage: zed-pkg is the primary host of package tarballs/zips.
resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.account_id
  name       = "zed-pkg-artifacts"
  location   = var.r2_location
}

resource "cloudflare_r2_bucket" "artifacts_dev" {
  account_id = var.account_id
  name       = "zed-pkg-artifacts-dev"
  location   = var.r2_location
}

# DNS for the registry API and the zpkg.tech apex/www (proxied). Targets are
# placeholders: point them at your ingress/load balancer or Pages project.
resource "cloudflare_dns_record" "registry" {
  zone_id = var.zone_id
  name    = "registry.zpkg.tech"
  type    = "CNAME"
  content = var.registry_origin
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.zone_id
  name    = "www.zpkg.tech"
  type    = "CNAME"
  content = var.web_origin
  proxied = true
  ttl     = 1
}

# The marketing site is GitHub Pages (Astro). Point the apex at Pages, or set
# a custom domain in the Pages project and add the record there instead.
resource "cloudflare_dns_record" "apex" {
  zone_id = var.zone_id
  name    = "zpkg.tech"
  type    = "CNAME"
  content = var.marketing_origin
  proxied = true
  ttl     = 1
}
