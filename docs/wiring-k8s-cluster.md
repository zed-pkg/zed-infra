# Wiring zed-pkg into your app-of-apps cluster

This connects zed-pkg to your existing Argo CD app-of-apps root at
`~/codes/ores/k8s-cluster`. The chain is:

```
k8s-cluster (app-of-apps root)
  └── zed-monorepo            (git submodule)
        └── apps/zed-infra    (git submodule)
              └── k8s/bootstrap/zed.yaml   (root Application -> k8s/apps)
                    ├── zed-api-server  (Application -> kustomize overlay)
                    └── zed-web-server  (Application -> kustomize overlay)
```

## 1. Add zed-monorepo as a submodule of the cluster repo

```sh
cd ~/codes/ores/k8s-cluster
git submodule add https://github.com/zed-pkg/zed-monorepo.git vendor/zed-monorepo
git submodule update --init --recursive   # pulls zed-infra + siblings under apps/
git commit -am "vendor zed-monorepo"
```

## 2. Register zed's root Application

Drop an Application into whatever directory your cluster root scans. Two
options — prefer the repo-URL form (Argo pulls zed-infra straight from
GitHub; no submodule contents needed at apply time):

```yaml
# k8s-cluster/apps/zed.yaml  (repo-URL form, recommended)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: zed
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/zed-pkg/zed-infra.git
    targetRevision: main
    path: k8s/bootstrap        # -> the root Application in this repo
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

Submodule-path alternative (if your cluster renders vendored paths instead):
set `path: vendor/zed-monorepo/apps/zed-infra/k8s/bootstrap` and
`repoURL` to your cluster repo. Either way it lands on
`zed-infra/k8s/bootstrap/zed.yaml`, which fans out to `k8s/apps`.

## 3. Build and push images

The Rust services path-depend on `../zed-interfaces`, so the Docker build
context is the **parent** directory:

```sh
# from the zed-monorepo/apps directory (siblings side by side)
docker build -f zed-api-server.rs/Dockerfile -t ghcr.io/zed-pkg/zed-api-server:v0.1.0 .
docker build -f zed-web-server.rs/Dockerfile -t ghcr.io/zed-pkg/zed-web-server:v0.1.0 .
docker push ghcr.io/zed-pkg/zed-api-server:v0.1.0
docker push ghcr.io/zed-pkg/zed-web-server:v0.1.0
```

Image tags are referenced in `k8s/manifests/*/base/deployment.yaml`.

## 4. Create secrets (never committed)

```sh
kubectl create namespace zed --dry-run=client -o yaml | kubectl apply -f -

kubectl -n zed create secret generic zed-api-server-secrets \
  --from-literal=DATABASE_URL='postgres://zed:PASSWORD@postgres:5432/zed' \
  --from-literal=AWS_ACCESS_KEY_ID='R2_ACCESS_KEY_ID' \
  --from-literal=AWS_SECRET_ACCESS_KEY='R2_SECRET_ACCESS_KEY'

kubectl -n zed create secret generic zed-web-server-secrets \
  --from-literal=DATABASE_URL='postgres://zed:PASSWORD@postgres:5432/zed'
```

For GitOps-managed secrets use SOPS or External Secrets Operator; commit only
encrypted material. Plain `*.secret.yaml` files are gitignored.

## 5. Point DNS

Apply `terraform/cloudflare` so `registry.zpkg.tech` and `www.zpkg.tech`
resolve to your ingress. Fill the R2 endpoint into
`k8s/manifests/zed-api-server/base/configmap.yaml` (`S3_ENDPOINT_URL`).

## Dev vs prod

The child Applications point at `overlays/prod`. For a dev cluster, edit
`k8s/apps/*.yaml` to `overlays/dev` — fewer replicas, local artifact storage,
tag verification off, and an in-cluster dev Postgres.
