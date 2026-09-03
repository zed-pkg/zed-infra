# OCI image build, registry and Lambda contract

Policy source: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>.

Deployable images must live in an actual OCI Distribution endpoint: AWS ECR for Lambda/ECS/EKS, Google Artifact Registry for Cloud Run/GKE, Azure Container Registry for Container Apps/AKS, or Docker Hub where its plan fits. Cloudflare R2 is deliberately an immutable OCI archive and disaster-recovery copy, not a direct runtime registry.

## Provisioning authority

Provision each provider independently so an AWS-only stack does not require Google, Azure, or Cloudflare provider credentials:

- `terraform/modules/oci-registry-fleet/aws-ecr`
- `terraform/modules/oci-registry-fleet/gcp-artifact-registry`
- `terraform/modules/oci-registry-fleet/azure-acr`
- `terraform/modules/oci-registry-fleet/cloudflare-r2`

The provider-native Crossplane examples are under `crossplane/oci-registries/provider-resources.example.yaml`. Keep them unapplied until provider packages/configs, names, projects, accounts, retention, and regions are reviewed. Terraform and Crossplane provision repositories; they do not build application images.

Docker Hub account, billing, organization, and repository visibility remain account-managed. Do not put Docker Hub tokens in Terraform state.

## Build and publish

`scripts/oci/build-and-push.sh` uses an environment-only interface so credentials never appear in command arguments. It supports `aws-ecr`, `dockerhub`, `gcp-artifact-registry`, `azure-acr`, and an already-authenticated custom registry (`none`). Prefer OIDC/workload identity and standard credential helpers.

Portable Rust service, two architectures:

```bash
REGISTRY_PROVIDER=aws-ecr \
REGISTRY_HOST=123456789012.dkr.ecr.us-east-1.amazonaws.com \
AWS_REGION=us-east-1 \
IMAGE_KIND=portable \
IMAGE_NAME=example/service \
IMAGE_TAG="sha-$(git rev-parse --short=12 HEAD)" \
DOCKERFILE=docker/Dockerfile.rust-service \
BUILD_ARG_NAMES=SERVICE_BIN \
SERVICE_BIN=example-service \
scripts/oci/build-and-push.sh
```

Portable images default to `linux/amd64,linux/arm64`. `PUSH=false` is a local validation mode and supports exactly one platform because `buildx --load` cannot load an image index.

## Lambda images are single-architecture

AWS Lambda function images must use one architecture per image reference. Set `IMAGE_KIND=lambda` and exactly one of `PLATFORMS=linux/amd64` or `PLATFORMS=linux/arm64`. The publisher rejects a multi-platform Lambda request before registry authentication or Docker side effects.

Rust Lambda from a `*-lambda` repository or a binary whose entrypoint is under `src/lambda`:

```bash
REGISTRY_PROVIDER=aws-ecr \
REGISTRY_HOST=123456789012.dkr.ecr.us-east-1.amazonaws.com \
AWS_REGION=us-east-1 \
IMAGE_KIND=lambda \
PLATFORMS=linux/arm64 \
IMAGE_NAME=example/lambda-worker \
IMAGE_TAG="sha-$(git rev-parse --short=12 HEAD)-arm64" \
DOCKERFILE=docker/Dockerfile.rust-lambda \
BUILD_ARG_NAMES=LAMBDA_BIN \
LAMBDA_BIN=lambda-worker \
scripts/oci/build-and-push.sh
```

For Node.js, use `docker/Dockerfile.node-lambda`; it copies `src/lambda` by default and can be redirected with `LAMBDA_SOURCE`. Repository-owned Bun, Deno, Go, or single-executable Dockerfiles can use the same publisher after defining an equally narrow multi-stage runtime image.

## Promotion and digest authority

Build publication and environment promotion are separate operations. `scripts/promote-oci-image.sh` accepts only a source pinned to `@sha256:...`, copies with `skopeo`, and performs pull-back verification. Portable promotion preserves the complete image index. Lambda promotion selects exactly one Linux architecture and rejects a destination that is still an image index.

Production deployment repositories pin the emitted digest. Tags are discovery and rollback metadata, not deployment authority.

## R2 archive boundary

After a successful real-registry push, setting `R2_ARCHIVE_BUCKET`, `R2_ENDPOINT`, and optional `R2_ARCHIVE_PREFIX` exports the complete image as an OCI archive with `skopeo`, writes a portable SHA-256 sidecar, and uploads both through the R2 S3-compatible endpoint. R2 archival is rejected when `PUSH=false` because no complete published image exists to export.

Do not configure Lambda, Cloud Run, Kubernetes, Docker, or containerd to pull directly from R2. A separately reviewed Distribution-compatible registry service would be required to expose authenticated `/v2/` semantics in front of R2.

## Validation

```bash
bash -n scripts/oci/build-and-push.sh scripts/oci/test-build-and-push.sh
bash scripts/oci/test-build-and-push.sh
terraform fmt -recursive -check terraform/modules/oci-registry-fleet
```

The contract tests prove that invalid Lambda indexes, invalid build arguments, and R2/local-build contradictions fail before Docker side effects. Live registry publication remains a protected environment operation and must use workload identity or an approved secret-delivery path.
