# terraform/gcp (planned)

GCP support is planned but not yet implemented. The intended shape:

- **GCS** bucket for artifacts (zed-api-server speaks S3; use the GCS
  XML/S3-compatible endpoint, or add a GCS `ArtifactStore` backend).
- **GKE** cluster to run the Argo CD app-of-apps from `../../k8s`.
- Workload Identity for the API server's bucket access.

No resources are defined here yet. Use `terraform/cloudflare` (R2) or
`terraform/aws` (S3) today.
