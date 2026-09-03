output "aws_ecr_repository_url" { value = try(aws_ecr_repository.this[0].repository_url, null) }
output "gcp_artifact_registry_host" { value = var.enable_gcp_artifact_registry ? "${var.gcp_location}-docker.pkg.dev" : null }
output "gcp_artifact_registry_repository" { value = var.enable_gcp_artifact_registry ? "${var.gcp_location}-docker.pkg.dev/${var.gcp_project_id}/${var.repository_name}" : null }
output "azure_acr_login_server" { value = try(azurerm_container_registry.this[0].login_server, null) }
output "cloudflare_r2_archive_bucket" { value = try(cloudflare_r2_bucket.oci_archive[0].name, null) }
