output "repository_arn" {
  value       = aws_ecr_repository.this.arn
  description = "ECR repository ARN."
}

output "repository_url" {
  value       = aws_ecr_repository.this.repository_url
  description = "Registry/repository URL used as the promotion destination."
}

output "registry_id" {
  value       = aws_ecr_repository.this.registry_id
  description = "AWS registry account ID."
}
