output "repository_name" {
  value       = google_artifact_registry_repository.this.name
  description = "Fully qualified Artifact Registry repository resource name."
}

output "docker_repository" {
  value       = "${var.location}-docker.pkg.dev/${var.project_id}/${var.repository_id}"
  description = "Docker repository prefix used as the promotion destination."
}
