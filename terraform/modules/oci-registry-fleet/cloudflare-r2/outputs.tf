output "bucket_name" {
  value       = cloudflare_r2_bucket.this.name
  description = "R2 bucket name."
}

output "s3_endpoint" {
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
  description = "S3-compatible endpoint for the separately deployed registry service."
}

output "direct_oci_registry" {
  value       = false
  description = "R2 requires an OCI Distribution-compatible service in front of the bucket."
}
