variable "repository_name" {
  description = "ECR repository name. Use a service- or lambda-specific name, not a shared mutable bucket."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(?:[._/-][a-z0-9]+)*$", var.repository_name))
    error_message = "repository_name must satisfy the ECR lowercase repository-name grammar."
  }
}

variable "oci_role" {
  description = "Human-readable workload role, for example lambda or cloud-run-mirror."
  type        = string
  default     = "lambda"
}

variable "kms_key_arn" {
  description = "Optional same-region KMS key ARN. Null uses ECR AES-256 encryption."
  type        = string
  default     = null
  nullable    = true
}

variable "untagged_retention_days" {
  description = "Days to retain untagged images before ECR cleanup."
  type        = number
  default     = 7

  validation {
    condition     = var.untagged_retention_days >= 1
    error_message = "untagged_retention_days must be at least 1."
  }
}

variable "max_sha_tagged_images" {
  description = "Maximum number of immutable sha-* images retained."
  type        = number
  default     = 30

  validation {
    condition     = var.max_sha_tagged_images >= 2
    error_message = "Keep at least two SHA images for rollback."
  }
}

variable "lambda_source_arns" {
  description = "Approved Lambda function/version/alias ARNs. Empty disables the repository policy."
  type        = list(string)
  default     = []
}

variable "lambda_source_accounts" {
  description = "Optional source account IDs paired with lambda_source_arns."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}
