output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.id
}

output "address" {
  description = "Private RDS hostname."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "PostgreSQL port."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Initial Shared Auth database name."
  value       = aws_db_instance.this.db_name
}

output "security_group_id" {
  description = "RDS security group ID."
  value       = aws_security_group.this.id
}

output "master_user_secret_arn" {
  description = "AWS Secrets Manager ARN for the generated master credential. Grant workloads access through an explicit secret-delivery mechanism; never copy it into Git."
  value       = try(aws_db_instance.this.master_user_secret[0].secret_arn, null)
  sensitive   = true
}
