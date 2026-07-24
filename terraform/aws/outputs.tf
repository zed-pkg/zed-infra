output "bucket_name" {
  value = aws_s3_bucket.artifacts.bucket
}

output "access_key_id" {
  description = "Set as AWS_ACCESS_KEY_ID for zed-api-server"
  value       = aws_iam_access_key.api.id
  sensitive   = true
}

output "secret_access_key" {
  description = "Set as AWS_SECRET_ACCESS_KEY for zed-api-server"
  value       = aws_iam_access_key.api.secret
  sensitive   = true
}
