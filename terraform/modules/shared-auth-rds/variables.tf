variable "name" {
  description = "Stable RDS identifier, for example shared-auth-customer-prod."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_-]{2,62}$", var.name))
    error_message = "name must start with a letter and contain 3-63 letters, numbers, hyphens, or underscores."
  }
}

variable "vpc_id" {
  description = "VPC containing the private database subnets and Shared Auth workloads."
  type        = string
}

variable "private_subnet_ids" {
  description = "At least two private subnet IDs in distinct availability zones."
  type        = list(string)

  validation {
    condition     = length(distinct(var.private_subnet_ids)) >= 2
    error_message = "private_subnet_ids must contain at least two distinct private subnets."
  }
}

variable "source_security_group_ids" {
  description = "Security groups allowed to connect to PostgreSQL. Do not use CIDR-wide ingress."
  type        = list(string)

  validation {
    condition     = length(var.source_security_group_ids) > 0
    error_message = "At least one approved source security group is required."
  }
}

variable "engine_version" {
  description = "PostgreSQL engine version approved in the target AWS region. Kept explicit because regional availability changes."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+([.][0-9]+)?$", var.engine_version))
    error_message = "engine_version must be an explicit PostgreSQL version such as 16.4."
  }
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "database_name" {
  description = "Initial database used by Shared Auth."
  type        = string
  default     = "shared_auth"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a valid PostgreSQL identifier."
  }
}

variable "master_username" {
  description = "Generated-password master username; the password is owned by AWS Secrets Manager."
  type        = string
  default     = "shared_auth_admin"
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{0,62}$", var.master_username))
    error_message = "master_username must be a valid PostgreSQL identifier."
  }
}

variable "port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432

  validation {
    condition     = var.port >= 1024 && var.port <= 65535
    error_message = "port must be between 1024 and 65535."
  }
}

variable "allocated_storage_gib" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 50

  validation {
    condition     = var.allocated_storage_gib >= 20
    error_message = "allocated_storage_gib must be at least 20 GiB."
  }
}

variable "max_allocated_storage_gib" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 250

  validation {
    condition     = var.max_allocated_storage_gib >= var.allocated_storage_gib
    error_message = "max_allocated_storage_gib must be at least allocated_storage_gib."
  }
}

variable "storage_type" {
  description = "RDS storage type."
  type        = string
  default     = "gp3"

  validation {
    condition     = contains(["gp3", "io1", "io2"], var.storage_type)
    error_message = "storage_type must be gp3, io1, or io2."
  }
}

variable "storage_kms_key_id" {
  description = "Optional customer-managed KMS key ARN for database storage."
  type        = string
  default     = null
}

variable "master_user_secret_kms_key_id" {
  description = "Optional customer-managed KMS key ARN for the AWS-managed master-user secret."
  type        = string
  default     = null
}

variable "multi_az" {
  description = "Create a synchronous standby in another availability zone. Keep true for production."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Automated backup retention."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 7 and 35."
  }
}

variable "backup_window" {
  description = "Preferred UTC backup window."
  type        = string
  default     = "05:00-05:30"
}

variable "maintenance_window" {
  description = "Preferred UTC maintenance window."
  type        = string
  default     = "sun:06:00-sun:06:30"
}

variable "deletion_protection" {
  description = "Protect the database from accidental deletion. Keep true for production."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Permit deletion without a final snapshot. Must be false for production."
  type        = bool
  default     = false
}

variable "final_snapshot_identifier" {
  description = "Required explicit final snapshot identifier when skip_final_snapshot is false."
  type        = string
  default     = null
}

variable "performance_insights_enabled" {
  description = "Enable RDS Performance Insights."
  type        = bool
  default     = true
}

variable "performance_insights_retention_days" {
  description = "Performance Insights retention; AWS supports 7 or 731 days."
  type        = number
  default     = 7

  validation {
    condition     = contains([7, 731], var.performance_insights_retention_days)
    error_message = "performance_insights_retention_days must be 7 or 731."
  }
}

variable "performance_insights_kms_key_id" {
  description = "Optional customer-managed KMS key ARN for Performance Insights."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}
