variable "registry_name" {
  description = "Globally unique ACR name containing only alphanumeric characters."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9]{5,50}$", var.registry_name))
    error_message = "registry_name must contain 5-50 alphanumeric characters."
  }
}

variable "resource_group_name" {
  description = "Existing Azure resource group name."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "sku" {
  description = "ACR SKU. Basic is the lowest-cost default; Standard/Premium require an explicit review."
  type        = string
  default     = "Basic"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.sku)
    error_message = "sku must be Basic, Standard, or Premium."
  }
}

variable "public_network_access_enabled" {
  description = "Whether ACR is reachable on its public endpoint. Private networking is configured separately."
  type        = bool
  default     = true
}

variable "oci_role" {
  description = "Human-readable workload role."
  type        = string
  default     = "azure-mirror"
}

variable "tags" {
  description = "Additional Azure tags."
  type        = map(string)
  default     = {}
}
