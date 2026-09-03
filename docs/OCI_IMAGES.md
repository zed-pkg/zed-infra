# OCI image build, registry and Lambda contract

Policy source: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>.

Deployable images must live in an actual OCI/Docker Registry API endpoint: AWS ECR for Lambda/ECS/EKS, Google Artifact Registry for Cloud Run/GKE, Azure Container Registry for Container Apps/AKS, or Docker Hub where its plan fits. Cloudflare R2 is deliberately an immutable OCI archive/DR copy, not a direct runtime registry.

`scripts/oci/build-and-push.sh` uses environment variables so credentials never appear in argv. It supports `aws-ecr`, `dockerhub`, `gcp-artifact-registry`, `azure-acr`, and an already-authenticated custom registry (`none`). Prefer OIDC/workload identity and standard credential helpers.

```bash
REGISTRY_PROVIDER=aws-ecr \
REGISTRY_HOST=123456789012.dkr.ecr.us-east-1.amazonaws.com \
AWS_REGION=us-east-1 \
IMAGE_NAME=example/service \
IMAGE_TAG="$(git rev-parse --short=12 HEAD)" \
DOCKERFILE=docker/Dockerfile.rust-service \
BUILD_ARG_NAMES=SERVICE_BIN SERVICE_BIN=example-service \
scripts/oci/build-and-push.sh
```

For a Rust Lambda from a `*-lambda` repo or `src/lambda`, use `docker/Dockerfile.rust-lambda` and `BUILD_ARG_NAMES=LAMBDA_BIN`. For Node use `docker/Dockerfile.node-lambda`; it copies `src/lambda` by default. Repository-owned Bun/Deno/single-executable Dockerfiles can use the same publisher.

Default publication is `linux/amd64,linux/arm64`. `PUSH=false` intentionally allows one platform only. Set `R2_ARCHIVE_BUCKET`, `R2_ENDPOINT`, and optional `R2_ARCHIVE_PREFIX` after a real-registry push to export a complete `oci-archive` with `skopeo` and upload it plus SHA-256 sidecar to R2.

`terraform/modules/oci-registries` can create any subset of ECR, GAR, ACR and an R2 archive bucket. Docker Hub account/billing policy remains account-managed. `crossplane/oci-registries.example.yaml` provides direct AWS/GCP/Azure managed-resource examples; keep it unapplied until provider configs, names, projects and regions are reviewed. Provider versions were checked against the official Terraform Registry on 2026-09-02.
