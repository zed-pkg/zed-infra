# zed-infra

Infrastructure-as-code for [zed-pkg](https://zpkg.tech): Cloudflare (R2 + DNS),
AWS (S3 alternative), GCP (planned), and the Kubernetes Argo CD app-of-apps
that runs the backend.

```
terraform/
  cloudflare/   R2 artifact buckets + zpkg.tech DNS   (primary)
  aws/          S3 artifact bucket + least-priv IAM    (alternative)
  gcp/          planned (GCS + GKE)
k8s/
  bootstrap/zed.yaml         root Application (app-of-apps entrypoint)
  apps/                      child Applications (one per service)
  manifests/
    zed-api-server/          kustomize base + overlays/{dev,prod}
    zed-web-server/          kustomize base + overlays/{dev,prod}
    postgres/                production guidance + dev StatefulSet
docs/wiring-k8s-cluster.md   how to attach this to ~/codes/ores/k8s-cluster
```

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

## Kubernetes runbook

```sh
# preview what the overlays render
kubectl kustomize k8s/manifests/zed-api-server/overlays/prod
kubectl kustomize k8s/manifests/zed-web-server/overlays/prod

# bootstrap via Argo CD (once the cluster is wired — see docs/)
kubectl apply -f k8s/bootstrap/zed.yaml
```

See [docs/wiring-k8s-cluster.md](docs/wiring-k8s-cluster.md) for attaching
this to the `~/codes/ores/k8s-cluster` app-of-apps root via the
`zed-monorepo` submodule, building images (parent-dir build context), and
creating secrets.

## License

MIT
