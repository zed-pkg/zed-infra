# Wiring zed-pkg into the ORES k8s-cluster app-of-apps

This is the **canonical production path**: deploy the zed-pkg backend onto the
existing Argo CD app-of-apps at `~/codes/ores/k8s-cluster`
(`ORESoftware/k8s-cluster`), following that repo's
[`docs/app-deploy-contract.md`](https://github.com/ORESoftware/k8s-cluster).

For a self-contained deploy that has **no** dependency on the ORES cluster (a
personal dev cluster, an air-gapped install), use the standalone bootstrap in
[`../README.md`](../README.md) → "Standalone Kubernetes runbook" instead. The
two paths are deliberately different: this one sources manifests from each **app
repo**, the standalone one renders zed-infra's own `k8s/manifests` overlays.

## The ownership split (why manifests live in the app repos)

The cluster contract draws the boundary by *lifecycle owner*, not by repo:

- **Layer 1 — platform (`k8s-cluster`) owns:** the `zed` `Namespace`,
  `ResourceQuota`, `LimitRange`, a default-deny `NetworkPolicy`, the Argo
  `AppProject`, and the `Application` pointers. Plus everything cluster-scoped
  (ingress-nginx, cert-manager, External Secrets Operator + the
  `ClusterSecretStore`, observability).
- **Layer 2 — each app repo owns** a `k8s/` directory of *namespace-scoped*
  resources only: `Deployment`, `Service`, `NetworkPolicy`, `Ingress`,
  `ExternalSecret`, `kustomization.yaml`. These now live in
  [`zed-api-server.rs/k8s/`](https://github.com/zed-pkg/zed-api-server.rs) and
  [`zed-web-server.rs/k8s/`](https://github.com/zed-pkg/zed-web-server.rs) — not
  here in zed-infra.

## ⚠️ Submodules are inventory, NOT a render source

`k8s-cluster`'s repo-server runs with `reposerver.enable.git.submodule=false`.
It checks out the superproject **without** submodule contents, so an
`Application` whose `path` resolves inside a gitlink renders **empty**. The
chain `k8s-cluster → zed-monorepo → apps/*` is a **pin/inventory** vehicle: it
records which commit of each app is live and is how CI promotes. Argo must point
`repoURL` at the **app repo directly** with `path: k8s`.

```
k8s-cluster  (app-of-apps root, ORESoftware/k8s-cluster)
├── remote/deployments/zed-monorepo         (submodule — inventory/pin only)
│     └── apps/zed-api-server.rs, …          (gitlinks; zero manifest files tracked)
├── remote/argocd/projects/zed.tenant.yaml   (Layer-1: ns + quota + default-deny)
├── remote/argocd/projects/zed.appproject.yaml (the enforced boundary)
└── remote/argocd/apps/zed.applications.yaml (Applications → the APP repos' k8s/)
        ├── dd-zed-api-server  repoURL=…/zed-api-server.rs  path=k8s
        └── dd-zed-web-server  repoURL=…/zed-web-server.rs  path=k8s
```

## What is already wired (companion commit in k8s-cluster)

1. `zed-monorepo` added as a submodule at
   `remote/deployments/zed-monorepo` (inventory/pin; recorded in `SUBMODULES.md`).
2. `remote/argocd/projects/zed.tenant.yaml` — `zed` Namespace (baseline PSA),
   `ResourceQuota`, `LimitRange`, default-deny ingress `NetworkPolicy`.
3. `remote/argocd/projects/zed.appproject.yaml` — strict `AppProject`
   (`clusterResourceWhitelist: []`, `sourceRepos` = the two app repos).
4. `remote/argocd/apps/zed.applications.yaml` — `dd-zed-api-server` and
   `dd-zed-web-server`, each pointing at its app repo's `k8s/`.

These are **inert until applied**, matching the threefa/daedalus precedent.

## Bootstrap checklist (run once, in order)

```sh
cd ~/codes/ores/k8s-cluster

# 1. Layer-1 tenancy + the enforced boundary
kubectl apply -f remote/argocd/projects/zed.tenant.yaml
kubectl apply -f remote/argocd/projects/zed.appproject.yaml

# 2. Argo needs a repo credential for the app repos if they are private.

# 3. Register the Applications (app-of-apps root already scans remote/argocd/apps)
kubectl apply -f remote/argocd/apps/zed.applications.yaml
```

## Prerequisites the Applications assume

- **Images** published: `ghcr.io/zed-pkg/zed-api-server:main` and
  `…/zed-web-server:main` (+ an `imagePullSecret` in the `zed` namespace if the
  GHCR packages are private). Build context is the **parent** dir because the
  services path-depend on `../zed-interfaces`:
  ```sh
  cd ~/codes/zed-pkg/zed-monorepo/apps
  docker build -f zed-api-server.rs/Dockerfile -t ghcr.io/zed-pkg/zed-api-server:main .
  docker build -f zed-web-server.rs/Dockerfile -t ghcr.io/zed-pkg/zed-web-server:main .
  docker push ghcr.io/zed-pkg/zed-api-server:main
  docker push ghcr.io/zed-pkg/zed-web-server:main
  ```
- **Secrets** seeded in the store the `ClusterSecretStore/dd-cluster-secrets`
  reads (AWS Secrets Manager path `dd/remote-dev/zed-secrets`) with keys:
  `ZED_API_DATABASE_URL`, `ZED_WEB_DATABASE_URL`, `ZED_R2_ACCESS_KEY_ID`,
  `ZED_R2_SECRET_ACCESS_KEY`. The app `ExternalSecret`s materialize these.
- **R2 endpoint** account-id filled into
  `zed-api-server.rs/k8s/deployment.yaml` (`S3_ENDPOINT_URL`), from
  `terraform/cloudflare` outputs.
- **DB migrated** once — `AUTO_MIGRATE` is `false` in-cluster so two replicas
  don't race the migrator. Run the migration as a one-off Job or exec.
- **DNS** applied via `terraform/cloudflare` so `registry.zpkg.tech` /
  `www.zpkg.tech` resolve to the ingress. Keep records DNS-only until the
  cert-manager certificate is issued (ACME HTTP-01 ordering).

## Promotion

The contract's promotion knob is `targetRevision`. Pin prod to a tag/sha rather
than `main`: bump the gitlink under `remote/deployments/zed-monorepo` and the
Application's `targetRevision` together, in one PR.
