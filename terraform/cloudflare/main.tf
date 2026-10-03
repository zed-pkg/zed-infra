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

# Token comes from the CLOUDFLARE_API_TOKEN environment variable (house
# convention: never a tf variable — it leaks into tfvars and plan files).
# Needs Zone:DNS:Edit on zpkg.net plus account R2 write for the buckets.
provider "cloudflare" {}

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

# Public CDN in front of the production bucket. This is *not* an origin
# hostname: Cloudflare terminates TLS at the edge and reads R2 directly.
# registry.zpkg.net, web.zpkg.net, and the GitHub Pages apex can all be
# down without affecting GET https://cdn.zpkg.net/<object-key>.
#
# The custom-domain API creates the DNS record (proxied CNAME). Do not also
# declare cloudflare_dns_record.cdn or apply will fight itself. The drift
# script allowlists this hostname until/after apply because the CNAME
# target is Cloudflare-managed.
resource "cloudflare_r2_custom_domain" "cdn" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.artifacts.name
  domain      = "cdn.zpkg.net"
  enabled     = true
  zone_id     = var.zone_id
  min_tls     = "1.2"
}

# ---------------------------------------------------------------------------
# zpkg.net — the public domain. (zpkg.tech is parked for a future purpose and
# intentionally has no records here.)
#
#   zpkg.net / www.zpkg.net  -> GitHub Pages marketing site (zed-pkg.github.io)
#   registry.zpkg.net        -> zed-api-server  (registry REST API, k8s)
#   web.zpkg.net             -> zed-web-server  (read-only registry UI, k8s)
#   cdn.zpkg.net             -> R2 custom domain (public artifacts; independent of origin)
#
# Ordering rule (see docs/wiring-k8s-cluster.md and the canonical.plus runbook
# in ORESoftware/k8s-cluster): app records stay DNS-only until cert-manager
# has issued the HTTP-01 certs on the cluster, then flip proxy_app_records.
# The Pages records stay DNS-only permanently so GitHub can provision and
# renew its own certificate for the custom domain.
# ---------------------------------------------------------------------------

# Apex -> GitHub Pages. Cloudflare flattens the apex CNAME automatically.
resource "cloudflare_dns_record" "apex" {
  zone_id = var.zone_id
  name    = "zpkg.net"
  type    = "CNAME"
  content = var.marketing_origin
  proxied = false
  ttl     = 1
}

# GitHub Pages redirects www -> apex once the custom domain is set.
resource "cloudflare_dns_record" "www" {
  zone_id = var.zone_id
  name    = "www.zpkg.net"
  type    = "CNAME"
  content = var.marketing_origin
  proxied = false
  ttl     = 1
}

# Origin hosts: one per cluster, always DNS-only (cert-manager HTTP-01 and
# direct origin reachability depend on it). IPs are the cluster edge nodes
# documented in ORESoftware/k8s-cluster (Hetzner ingress-nginx hostNetwork
# node; AWS dd-remote-gateway EIP).
resource "cloudflare_dns_record" "origin_hetzner" {
  zone_id = var.zone_id
  name    = "origin-hetzner.zpkg.net"
  type    = "A"
  content = var.hetzner_ingress_ip
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "origin_aws" {
  zone_id = var.zone_id
  name    = "origin-aws.zpkg.net"
  type    = "A"
  content = var.aws_gateway_ip
  proxied = false
  ttl     = 300
}

# Primary public hostnames. Hetzner is the serving cluster today; repoint
# primary_origin when that changes.
#
# api.zpkg.net and registry.zpkg.net both resolve to the zed-api-server
# root for now. Later, registry.zpkg.net moves to a sub-path of the API
# (an ingress path route or edge rewrite), while api.zpkg.net keeps the
# root — DNS for both stays exactly this either way.
resource "cloudflare_dns_record" "api" {
  zone_id = var.zone_id
  name    = "api.zpkg.net"
  type    = "CNAME"
  content = var.api_origin != "" ? var.api_origin : var.primary_origin
  # Same rule as registry: a cfargotunnel.com target only works proxied.
  proxied = var.api_origin != "" ? true : var.proxy_app_records
  ttl     = 1
}

resource "cloudflare_dns_record" "registry" {
  zone_id = var.zone_id
  name    = "registry.zpkg.net"
  type    = "CNAME"
  content = var.registry_origin != "" ? var.registry_origin : var.primary_origin
  # A cfargotunnel.com target only works through the proxy — when the
  # transitional tunnel override is set, force proxied regardless of the
  # zone-wide flag, or the live registry goes dark.
  proxied = var.registry_origin != "" ? true : var.proxy_app_records
  ttl     = 1
}

resource "cloudflare_dns_record" "web" {
  zone_id = var.zone_id
  name    = "web.zpkg.net"
  type    = "CNAME"
  content = var.web_origin != "" ? var.web_origin : var.primary_origin
  proxied = var.web_origin != "" ? true : var.proxy_app_records
  ttl     = 1
}

# Per-cloud hostnames asserted by the dual-cloud deploy contract
# (registry.<cloud>.zpkg.net / web.<cloud>.zpkg.net). Always DNS-only:
# they exist for cert issuance, canaries, and direct-to-cluster debugging.
resource "cloudflare_dns_record" "api_per_cloud" {
  for_each = local.cloud_origins
  zone_id  = var.zone_id
  name     = "api.${each.key}.zpkg.net"
  type     = "CNAME"
  content  = each.value
  proxied  = false
  ttl      = 300
}

resource "cloudflare_dns_record" "registry_per_cloud" {
  for_each = local.cloud_origins
  zone_id  = var.zone_id
  name     = "registry.${each.key}.zpkg.net"
  type     = "CNAME"
  content  = each.value
  proxied  = false
  ttl      = 300
}

resource "cloudflare_dns_record" "web_per_cloud" {
  for_each = local.cloud_origins
  zone_id  = var.zone_id
  name     = "web.${each.key}.zpkg.net"
  type     = "CNAME"
  content  = each.value
  proxied  = false
  ttl      = 300
}

locals {
  cloud_origins = {
    aws     = "origin-aws.zpkg.net"
    hetzner = "origin-hetzner.zpkg.net"
  }
}

# Email anti-spoofing: zpkg.net sends no mail, and says so. These three were
# created live during the 2026-08-07 Cloudflare hardening pass (see the
# "Cloudflare DNS backup — 2026-08-07" Linear doc); managed here so the drift
# check owns them. zpkg.tech carries the same three records but that zone is
# parked and stays dashboard-managed. Import all three before the first apply.
resource "cloudflare_dns_record" "spf" {
  zone_id = var.zone_id
  name    = "zpkg.net"
  type    = "TXT"
  content = "\"v=spf1 -all\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.zpkg.net"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\""
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "null_mx" {
  zone_id  = var.zone_id
  name     = "zpkg.net"
  type     = "MX"
  content  = "."
  priority = 0
  proxied  = false
  ttl      = 1
}
