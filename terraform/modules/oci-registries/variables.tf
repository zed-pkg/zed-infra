variable "repository_name" { type = string }
variable "description" { type = string, default = "OCI images managed by the product infrastructure repository" }
variable "tags" { type = map(string), default = {} }
variable "enable_aws_ecr" { type = bool, default = false }
variable "enable_gcp_artifact_registry" { type = bool, default = false }
variable "enable_azure_acr" { type = bool, default = false }
variable "enable_cloudflare_r2_archive" {
  description = "Create an R2 archive bucket. R2 is not a direct runtime OCI registry."
  type = bool
  default = false
}
variable "gcp_project_id" { type = string, default = null, nullable = true }
variable "gcp_location" { type = string, default = "us-central1" }
variable "azure_registry_name" {
  type = string
  default = null
  nullable = true
  validation {
    condition = var.azure_registry_name == null || can(regex("^[A-Za-z0-9]{5,50}$", var.azure_registry_name))
    error_message = "azure_registry_name must be 5-50 alphanumeric characters."
  }
}
variable "azure_resource_group_name" { type = string, default = null, nullable = true }
variable "azure_location" { type = string, default = "eastus" }
variable "cloudflare_account_id" { type = string, default = null, nullable = true, sensitive = true }
variable "r2_bucket_name" { type = string, default = null, nullable = true }
variable "r2_location" { type = string, default = "enam" }
variable "r2_jurisdiction" { type = string, default = "default" }
variable "r2_storage_class" { type = string, default = "InfrequentAccess" }
