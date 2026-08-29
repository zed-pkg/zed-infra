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
