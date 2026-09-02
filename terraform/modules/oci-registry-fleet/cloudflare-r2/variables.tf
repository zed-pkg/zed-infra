variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket used only as an OCI registry blob backend/cache."
  type        = string
}

variable "jurisdiction" {
  description = "R2 data-jurisdiction setting."
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "eu", "fedramp", "us"], var.jurisdiction)
    error_message = "jurisdiction must be default, eu, fedramp, or us."
  }
}

variable "location" {
  description = "Best-effort R2 bucket location hint."
  type        = string
  default     = "enam"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.location)
    error_message = "location must be apac, eeur, enam, weur, wnam, or oc."
  }
}

variable "storage_class" {
  description = "Storage class for new objects. Standard avoids retrieval charges for active registries."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Standard", "InfrequentAccess"], var.storage_class)
    error_message = "storage_class must be Standard or InfrequentAccess."
  }
}
