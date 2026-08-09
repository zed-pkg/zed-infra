# zed-pkg account and registry runtime

This Kustomize base deploys the zed-pkg account API and Maud/HTMX web console. It is deliberately not production-ready until a cluster overlay pins immutable image digests and supplies the referenced Secrets.

## Ordering

Argo CD runs `zed-pkg-registry-migrate` as a `PreSync` hook at wave `-10`. The Job uses the same API image digest as the long-running API Deployment and invokes:

```text
zed-api-server migrate
```

That command applies the legacy registry expansion first and then the advisory-locked `zed_orm::migrate()` batch. API replicas run with `AUTO_MIGRATE=false`. The API rolls at wave `0`; the web console follows at wave `10`.

A release must not sync when the Job and API images differ. Pin images by digest in the cluster overlay; branch names, `latest`, PR numbers, and mutable tags are not acceptable production references.

## Secret ownership

No Secret manifests or credential values live in this repository.

| Secret | Required keys | Owner |
| --- | --- | --- |
| `zed-pkg-registry-db` | `DATABASE_URL` | registry application RDS/PostgreSQL |
| `zed-pkg-shared-auth` | `SHARED_AUTH_URL`, `SHARED_AUTH_PUBLIC_URL`, `SHARED_AUTH_SERVICE_CREDENTIAL` | Shared Auth service boundary |
| `zed-pkg-artifact-storage` | storage backend credentials and bucket configuration | registry artifact storage |
| `zed-pkg-web-auth` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | browser-safe Supabase project configuration |
| `zed-pkg-web-runtime` | `PUBLIC_BASE_URL` and optional cookie/domain overrides | web ingress/runtime configuration |

`SUPABASE_PUBLISHABLE_KEY` is intentionally browser-safe configuration. A Supabase service-role key must never be mounted into the web pod. Shared Auth sessions and credentials remain in the dedicated customer-auth database; the registry database contains only the local user projection and product authorization data.

## Required release gates

1. `zed-pkg/zed-lib` is green at the exact revision consumed by both servers.
2. API and web images are built from reviewed commits and pinned by digest.
3. the target PostgreSQL version has `pgcrypto` and `vector` available;
4. the migration Job succeeds and records the expected newest `zed_schema_migrations.version`;
5. API readiness verifies database connectivity after migration;
6. Shared Auth contract/e2e tests prove 401, 403, 503, token exchange, revocation, and audience binding;
7. registry tests prove exact 10-day/50-download boundaries and serialization with the 51st download;
8. the web console certifies signup, login, cookie protection, CSRF/origin checks, membership isolation, and package settings flows.

## Local validation

```bash
kustomize build k8s/zed-pkg-account >/tmp/zed-pkg-account.yaml
kubectl apply --dry-run=server -f /tmp/zed-pkg-account.yaml
```

The base intentionally contains `replace-with-git-sha` image tags. Production overlays must replace them with immutable digests before Argo CD sync is enabled.
