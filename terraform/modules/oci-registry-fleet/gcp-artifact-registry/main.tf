terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
  }
}

resource "google_artifact_registry_repository" "this" {
  project       = var.project_id
  location      = var.location
  repository_id = var.repository_id
  description   = var.description
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"

  docker_config {
    immutable_tags = true
  }

  cleanup_policy_dry_run = var.cleanup_policy_dry_run
  deletion_policy        = "PREVENT"

  cleanup_policies {
    id     = "delete-untagged-after-review-window"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "${var.untagged_retention_days * 86400}s"
    }
  }

  cleanup_policies {
    id     = "keep-recent-rollback-images"
    action = "KEEP"

    most_recent_versions {
      keep_count = var.keep_recent_versions
    }
  }

  labels = merge(var.labels, {
    "managed-by" = "terraform"
    "oci-role"   = var.oci_role
  })

  lifecycle {
    prevent_destroy = true
  }
}
