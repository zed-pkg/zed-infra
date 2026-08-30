output "artifacts_bucket" {
  description = "Production R2 bucket name for zed-api-server S3_BUCKET"
  value       = cloudflare_r2_bucket.artifacts.name
}

output "artifacts_bucket_dev" {
  value = cloudflare_r2_bucket.artifacts_dev.name
}

output "s3_endpoint_url" {
  description = "S3-compatible endpoint for R2; set as zed-api-server S3_ENDPOINT_URL"
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}

output "s3_region" {
  description = "R2 uses the literal region `auto`"
  value       = "auto"
}

output "cdn_hostname" {
  description = "Public content-addressed artifact mirror, when enabled."
  value       = var.enable_cdn ? "https://cdn.zpkg.net" : null
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

output "web_hostnames" {
  description = <<-EOT
    Both names for zed-web-server. `user.zpkg.net` is what people are given;
    `web.zpkg.net` is the name the manifests and per-cloud canaries use. They
    resolve to one origin on purpose — a second origin is how two names for one
    service start serving two different versions of it.
  EOT
  value       = ["https://user.zpkg.net", "https://web.zpkg.net"]
}

output "registry_gateway_worker" {
  description = <<-EOT
    registry.zpkg.net is a Worker route, not a plain proxy: the record here is
    inert without cloudflare/workers/zpkg-registry-gateway deployed. Deploy the
    Worker before applying, in the same order as the CDN.
  EOT
  value       = "zpkg-registry-gateway"
}
