# OCI registry fleet contract

This repository owns the reusable infrastructure and promotion contract for OCI images. It does **not** build application images and it never performs an unattended cloud apply.

## Ownership split

1. Application and `*-lambda` repositories build a minimal, non-root image with a multi-stage Dockerfile. Portable workloads publish an OCI index for `linux/amd64` and `linux/arm64`; AWS Lambda publishes one architecture per image reference.
2. `*-infra` repositories instantiate one or more registry modules and keep environment-specific provider configuration, budgets, and repository names reviewable.
3. `scripts/promote-oci-image.sh` copies an already-built image from an immutable source digest to provider registries. Authentication is established outside the script with workload identity/OIDC or a local credential helper.
4. Deployment repositories pin the resulting digest. Tags are discovery metadata only and are never the production authority.

## Provider roles

| Provider | Intended role | Guardrails |
| --- | --- | --- |
| AWS ECR private | Same-region source for Lambda and AWS workloads | Immutable tags, scan on push, bounded untagged retention, repository destruction blocked |
| Google Artifact Registry | Cloud Run and GCP workloads | Docker format, immutable tags, cleanup policy starts in dry-run, repository destruction blocked |
| Docker Hub | Public mirror or the limited private-repository lane | Promotion only; no credentials in Terraform or repository files |
| Azure Container Registry | Azure workloads and optional mirror | Basic SKU by default, admin account disabled, no Premium-only retention settings |
| Cloudflare R2 | Low-cost object storage for an OCI Distribution-compatible registry backend or cache | R2 is not itself a registry API; deploy and secure a registry service in front of the bucket |

## Promotion invariants

- Source references must include `@sha256:<64 hex characters>`.
- Portable promotion uses `skopeo copy --all --preserve-digests` and fails when the destination digest differs.
- Lambda promotion requires `amd64` or `arm64`, copies exactly one Linux image, and rejects a destination that is still an image index.
- The script never accepts passwords, tokens, access keys, or cloud credentials as arguments.
- A destination tag is immutable metadata. Production consumers use the emitted digest.
- Pull-back inspection is mandatory after every non-dry-run copy.

## R2 deployment boundary

R2 exposes an S3-compatible object API, not the OCI Distribution API expected by Docker, Cloud Run, or Lambda. Use the R2 Terraform module only for the blob bucket. A separately reviewed Distribution-compatible service (for example CNCF Distribution or Zot) must provide authentication, authorization, garbage collection, TLS, and `/v2/` semantics. Cloud Run should consume Artifact Registry and Lambda should consume same-region ECR even when R2 is used as a secondary cache.

## Operator sequence

```sh
terraform init -backend=false
terraform fmt -recursive -check
terraform validate

# Authenticate each target with OIDC/workload identity or a credential helper.
./scripts/promote-oci-image.sh \
  ghcr.io/example/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  123456789012.dkr.ecr.us-east-1.amazonaws.com/service:sha-0123456789ab \
  lambda arm64
```

Terraform and Crossplane in this directory are provisioning inputs only. Review a plan/diff, cost impact, region, retention, and rollback before apply or sync.
