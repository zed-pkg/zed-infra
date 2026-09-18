terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24.0, < 6.0.0"
    }
  }
}

variable "enabled" {
  description = "Whether Terraform should own the Cloudflare Worker shell."
  type        = bool
  default     = false
}

variable "account_id" {
  description = "Cloudflare account ID. Prefer CLOUDFLARE_API_TOKEN for provider authentication."
  type        = string
  sensitive   = true

  validation {
    condition     = var.account_id == "" || can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be empty or a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "worker_name" {
  description = "Stable Worker name for this environment."
  type        = string

  validation {
    condition     = length(var.worker_name) >= 1 && length(var.worker_name) <= 63 && can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.worker_name))
    error_message = "worker_name must be 1-63 lowercase alphanumeric/dash characters and cannot start or end with a dash."
  }
}

variable "workers_dev" {
  description = "Expose the Worker on workers.dev."
  type        = bool
  default     = false
}

variable "preview_urls" {
  description = "Enable Cloudflare preview URLs."
  type        = bool
  default     = false
}

variable "observability_head_sampling_rate" {
  description = "Workers observability head sampling rate."
  type        = number
  default     = 1

  validation {
    condition     = var.observability_head_sampling_rate >= 0 && var.observability_head_sampling_rate <= 1
    error_message = "observability_head_sampling_rate must be between 0 and 1."
  }
}

variable "tags" {
  description = "Tags attached to the Worker shell."
  type        = set(string)
  default     = []
}

resource "cloudflare_worker" "this" {
  count = var.enabled ? 1 : 0

  account_id = var.account_id
  name       = var.worker_name
  tags       = var.tags

  observability = {
    enabled            = true
    head_sampling_rate = var.observability_head_sampling_rate
  }

  subdomain = {
    enabled          = var.workers_dev
    previews_enabled = var.preview_urls
  }

  lifecycle {
    precondition {
      condition     = var.account_id != ""
      error_message = "account_id must be set when enabled=true."
    }
  }
}

output "worker_id" {
  description = "Cloudflare Worker ID when enabled."
  value       = try(cloudflare_worker.this[0].id, null)
}

output "worker_name" {
  description = "Cloudflare Worker name when enabled."
  value       = try(cloudflare_worker.this[0].name, null)
}
