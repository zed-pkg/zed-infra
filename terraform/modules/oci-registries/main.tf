terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.62.0" }
    google = { source = "hashicorp/google", version = "7.45.0" }
    azurerm = { source = "hashicorp/azurerm", version = "5.2.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "5.24.0" }
  }
}

resource "aws_ecr_repository" "this" {
  count = var.enable_aws_ecr ? 1 : 0
  name = var.repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete = false
  encryption_configuration { encryption_type = "AES256" }
  image_scanning_configuration { scan_on_push = true }
  tags = var.tags
}

resource "google_artifact_registry_repository" "this" {
  count = var.enable_gcp_artifact_registry ? 1 : 0
  project = var.gcp_project_id
  location = var.gcp_location
  repository_id = var.repository_name
  description = var.description
  format = "DOCKER"
  mode = "STANDARD_REPOSITORY"
  deletion_policy = "PREVENT"
  docker_config { immutable_tags = true }
}

resource "azurerm_container_registry" "this" {
  count = var.enable_azure_acr ? 1 : 0
  name = var.azure_registry_name
  resource_group_name = var.azure_resource_group_name
  location = var.azure_location
  sku = "Basic"
  admin_enabled = false
  tags = var.tags
}

resource "cloudflare_r2_bucket" "oci_archive" {
  count = var.enable_cloudflare_r2_archive ? 1 : 0
  account_id = var.cloudflare_account_id
  name = var.r2_bucket_name
  location = var.r2_location
  jurisdiction = var.r2_jurisdiction
  storage_class = var.r2_storage_class
}
