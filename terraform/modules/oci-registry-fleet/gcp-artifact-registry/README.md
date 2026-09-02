# Google Artifact Registry module

Creates an immutable Docker-format repository for Cloud Run/GCP workloads. Cleanup starts in dry-run mode and keeps a rollback window. The caller owns provider authentication and grants the minimum Artifact Registry writer/reader roles through separate reviewed IAM code.
