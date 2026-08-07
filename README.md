# zed-infra

Infrastructure-as-code for [zed-pkg](https://zpkg.net): Cloudflare (R2 + DNS),
AWS (S3 alternative), GCP (planned), and the Kubernetes Argo CD app-of-apps
that runs the backend.

```
terraform/
  cloudflare/   R2 artifact buckets + zpkg.tech DNS   (primary)
  aws/          S3 artifact bucket + least-priv IAM    (alternative)
  gcp/          planned (GCS + GKE)
k8s/
  bootstrap/zed.yaml         root Application (standalone app-of-apps entrypoint)
  apps/                      child Applications (one per service)
  manifests/
    zed-api-server/          kustomize base + overlays/{dev,prod}
    zed-web-server/          kustomize base + overlays/{dev,prod}
    postgres/                production guidance + dev StatefulSet
docs/wiring-k8s-cluster.md   attach to ~/codes/ores/k8s-cluster (canonical prod)
```

## Two deployment paths

1. **Canonical / production — the ORES k8s-cluster app-of-apps.** The
   namespace-scoped manifests are owned by each **app repo**
   (`zed-api-server.rs/k8s`, `zed-web-server.rs/k8s`); `k8s-cluster` owns the
   `zed` tenant + `AppProject` + `Application` pointers. This is the source of
   truth for the running backend. See
   [docs/wiring-k8s-cluster.md](docs/wiring-k8s-cluster.md).
2. **Standalone / dev self-host — this repo's `k8s/`.** A self-contained
   Argo CD app-of-apps (`k8s/bootstrap/zed.yaml`) for a personal or air-gapped
   cluster with no dependency on the ORES platform. Its `overlays/dev` adds an
   in-cluster Postgres and local artifact storage that have no place in the
   contract-bound app-repo manifests.

The Terraform (DNS/edge/buckets) is shared by both paths.

## Prerequisites

- `terraform` >= 1.6
- `kubectl` + `kustomize` (or `kubectl kustomize`)
- An Argo CD install on the target cluster
- A container registry (`ghcr.io/zed-pkg/*`)

## Terraform runbooks

```sh
# Cloudflare R2 + DNS (primary artifact storage)
cd terraform/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in token/account/zone
terraform init && terraform plan && terraform apply

# AWS S3 alternative
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform plan && terraform apply
```

R2 vs S3: R2 is the default (no egress fees, `region = auto`, S3-compatible
API). Use AWS S3 when you are AWS-native or want lifecycle/replication
features. The API server speaks the S3 API to either; only
`S3_ENDPOINT_URL`/credentials differ.

## Standalone Kubernetes runbook

Use this only for a self-hosted cluster with no ORES `k8s-cluster`. For the
production deploy, follow [docs/wiring-k8s-cluster.md](docs/wiring-k8s-cluster.md)
instead — there the manifests are owned by the app repos, not these overlays.

```sh
# preview what the overlays render
kubectl kustomize k8s/manifests/zed-api-server/overlays/prod
kubectl kustomize k8s/manifests/zed-web-server/overlays/prod

# bootstrap a standalone Argo CD app-of-apps
kubectl apply -f k8s/bootstrap/zed.yaml
```

Building images uses a parent-dir build context (the services path-depend on
`../zed-interfaces`); see the wiring doc for the exact commands.

## License

MIT
