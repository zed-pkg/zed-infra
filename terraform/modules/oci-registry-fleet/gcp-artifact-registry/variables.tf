variable "project_id" {
  description = "GCP project ID that owns the Artifact Registry repository."
  type        = string
}

variable "location" {
  description = "Artifact Registry region. Prefer the same region as Cloud Run."
  type        = string
  default     = "us-central1"
}

variable "repository_id" {
  description = "Artifact Registry repository ID."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,62}$", var.repository_id))
    error_message = "repository_id must be 3-63 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "description" {
  description = "Repository description."
  type        = string
  default     = "Immutable OCI images for reviewed deployments"
}

variable "oci_role" {
  description = "Human-readable workload role."
  type        = string
  default     = "cloud-run"
}

variable "cleanup_policy_dry_run" {
  description = "Keep cleanup in report-only mode until repository evidence is reviewed."
  type        = bool
  default     = true
}

variable "untagged_retention_days" {
  description = "Age threshold for untagged-image deletion."
  type        = number
  default     = 7

  validation {
    condition     = var.untagged_retention_days >= 1
    error_message = "untagged_retention_days must be at least 1."
  }
}

variable "keep_recent_versions" {
  description = "Minimum versions retained per package for rollback."
  type        = number
  default     = 10

  validation {
    condition     = var.keep_recent_versions >= 2
    error_message = "Keep at least two versions for rollback."
  }
}

variable "labels" {
  description = "Additional GCP labels. Keys and values must satisfy GCP label grammar."
  type        = map(string)
  default     = {}
}
