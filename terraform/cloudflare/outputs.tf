output "artifacts_bucket" {
  description = "Production R2 bucket name for zed-api-server S3_BUCKET"
  value       = cloudflare_r2_bucket.artifacts.name
}

output "cdn_hostname" {
  description = "Public Cloudflare-proxied origin for R2 objects (independent of the registry origin)"
  value       = cloudflare_r2_custom_domain.cdn.domain
}

output "edge_hostnames" {
  description = "Public hostnames that Cloudflare proxies (Workers sit on these routes)"
  value = {
    registry = cloudflare_dns_record.registry.name
    cdn      = cloudflare_r2_custom_domain.cdn.domain
    web      = cloudflare_dns_record.web.name
    app      = cloudflare_dns_record.app.name
    user     = cloudflare_dns_record.user.name
  }
}

output "artifacts_bucket_dev" {
  value = cloudflare_r2_bucket.artifacts_dev.name
}

output "artifacts_bucket_e2e" {
  value = cloudflare_r2_bucket.artifacts_e2e.name
}

output "static_registry_bucket_e2e" {
  value = cloudflare_r2_bucket.static_registry_e2e.name
}

output "s3_endpoint_url" {
  description = "S3-compatible endpoint for R2; set as zed-api-server S3_ENDPOINT_URL"
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}

output "s3_region" {
  description = "R2 uses the literal region `auto`"
  value       = "auto"
}

output "cdn_public_url" {
  description = "Public content-addressed artifact mirror URL, when the Worker/DNS record is enabled."
  value       = var.enable_cdn ? "https://cdn.zpkg.net" : "https://${cloudflare_r2_custom_domain.cdn.domain}"
}

output "cdn_workers_dev_hostname" {
  description = <<-EOT
    The zone-independent fallback hostname for the same Worker.

    Not managed by Terraform — Cloudflare assigns it when the Worker is
    deployed with workers_dev = true. Recorded here because it is the route
    that survives losing the zpkg.net zone, and therefore the one that must be
    in zed-cli's built-in mirror list.
  EOT
  value       = "https://zpkg-cdn.<account-subdomain>.workers.dev"
}
