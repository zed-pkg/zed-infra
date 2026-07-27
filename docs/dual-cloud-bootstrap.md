# Dual-cloud Zed registry bootstrap

`deploy zed cloud` deploys and certifies the same temporary registry profile on
two independent Kubernetes clusters through protected GitHub Environments named
`aws` and `hetzner`.

Each environment must provide:

- `KUBECONFIG_B64`: base64-encoded kubeconfig for that cluster;
- `ZED_GHCR_USERNAME`: account permitted to pull the Zed server packages;
- `ZED_GHCR_TOKEN`: read-only GHCR token for those packages.

The workflow creates only the namespace-local `zed-ghcr` pull secret. It does
not persist kubeconfig or registry credentials in Git.

## Bootstrap storage contract

This profile is intentionally disposable but complete enough for real
`zed publish` and `zed install` transactions:

- one API replica owns a 512 MiB memory-backed `emptyDir` artifact store;
- one `pgvector/pgvector:0.8.5-pg16` replica owns a 512 MiB memory-backed
  `emptyDir` metadata store;
- two read-only web replicas share that metadata service;
- automatic migrations, authentication bypass, tag-verification bypass, and
  rate-limit bypass are enabled only for this bootstrap phase.

The pgvector image is load-bearing: registry migration
`m20260726_000007_embeddings_and_tags` creates the PostgreSQL `vector`
extension. Plain PostgreSQL 16 cannot satisfy the complete schema. The deploy
workflow verifies that the migration installed a `0.8.x` vector extension
before testing the registry.

Metadata and artifact bytes must be reset together. Restarting only the API
would erase its pod-local artifacts while leaving version rows in Postgres. The
certification therefore restarts the volatile Postgres deployment first, then
restarts the API and web workloads, yielding a consistent empty registry.

The API must remain at one replica while storage is pod-local. Scaling it before
moving artifacts to R2/S3 would make downloads intermittently miss depending on
which replica receives the request.

## Package interdependency certification

Each cloud job builds a pinned Zed CLI and checks out the exact release-source
revisions for:

1. `opto-sync/syncer@0.2.1`;
2. `opto-sync/opto-sync-clients@0.2.0`;
3. `opto-sync/opto-sync-e2e@0.1.0`.

After the cluster rollouts become healthy, the GitHub runner opens a
`kubectl port-forward` to the live `dd-zed-api-server` Service. It publishes the
three packages in dependency order, verifies their live metadata, and creates a
blank consumer that declares only `opto-sync/opto-sync-e2e`.

A passing normal install must materialize all three packages under
`zed_modules/opto-sync/`. The job then removes both `zed_modules` and the entire
Zed download store and repeats with `zed install --frozen`. The first and frozen
lockfiles must be byte-identical. Metadata JSON, port-forward diagnostics, and
both lockfiles are retained as 30-day workflow artifacts for each cloud.

The CLI deliberately rewrites ordinary `/v1/artifacts/<sha>` download URLs
through the configured registry base, so port-forward certification exercises
the real cluster Service without changing the server's canonical public URL.

## Public endpoints

The intended public names are:

| Cloud | Registry API | Web UI |
| --- | --- | --- |
| AWS | `https://registry.aws.zpkg.tech` | `https://aws.zpkg.tech` |
| Hetzner | `https://registry.hetzner.zpkg.tech` | `https://hetzner.zpkg.tech` |

These custom records are a separate edge/DNS concern. Cluster certification is
blocking; unresolved public DNS is emitted as an Actions warning rather than
being confused with a failed Kubernetes deployment or failed package store.
AWS also uses the existing hostPort gateway rather than nginx Ingress, whereas
Hetzner has ingress-nginx and cert-manager. Public edge integration should
preserve that cloud-specific split.

## Production transition

Before accepting untrusted public publishers:

1. move metadata to durable PostgreSQL/Supabase with pgvector enabled;
2. move artifacts to R2/S3 and raise the API replica count;
3. restore authentication, tag verification, and rate limiting;
4. pin images by digest instead of the bootstrap `main` tag;
5. add the AWS gateway route and Cloudflare DNS records, while keeping Hetzner
   on its nginx/cert-manager ingress path;
6. replace direct deployment with matching Argo applications once the
   `ORESoftware/k8s-cluster` installation can accept the GitOps branch.
