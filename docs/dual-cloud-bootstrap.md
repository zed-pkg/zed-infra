# Dual-cloud Zed registry bootstrap

`deploy zed cloud` deploys and certifies the same temporary registry profile on
two independent Kubernetes clusters through protected GitHub Environments named
`aws` and `hetzner`.

Each environment must provide:

- `KUBECONFIG_B64`: a current least-privilege kubeconfig for that cluster;
- `ZED_GHCR_USERNAME`: an account permitted to pull both Zed server packages;
- `ZED_GHCR_TOKEN`: a read-only GHCR token for those packages.

The workflow first runs the non-mutating cloud preflight. It rejects missing or
invalid credentials, non-HTTPS Kubernetes endpoints, missing deployment RBAC,
and GHCR credentials that can log in but cannot read both images. This happens
before the Zed CLI or any application repository is checked out and built.
Decoded kubeconfigs, Docker configs, and the Zed download store are removed on
every exit path.

## Immutable image promotion

The API and web source commits and the shared `zed-interfaces` commit are pinned
in the workflow. Each source repository publishes a commit-tagged image with OCI
labels recording both its own source revision and the interface revision.

Before touching the cluster, the deploy job:

1. pulls those exact commit tags with the protected GHCR credential;
2. validates the embedded source labels and `linux/amd64` platform;
3. resolves each tag to a registry digest;
4. saves the digest/source mapping as certification evidence; and
5. replaces the render-time `:main` placeholders with those digests.

Only the digest-pinned manifests are applied. The workflow then proves the
Deployment specs and running pod `imageID` values contain the expected digests.

## Bootstrap storage and network contract

This profile is intentionally disposable but complete enough for real
`zed publish` and `zed install` transactions:

- one API replica owns a 512 MiB memory-backed `emptyDir` artifact store;
- the API uses `strategy: Recreate`, so two unrelated RAM stores cannot overlap
  during promotion;
- one `pgvector/pgvector:0.8.5-pg16` replica owns a separate 512 MiB
  memory-backed `emptyDir` metadata store;
- two read-only web replicas share that metadata service;
- automatic migrations, authentication bypass, tag-verification bypass, and
  rate-limit bypass are enabled only for this bootstrap phase.

Because those controls are bypassed, the API is structurally cluster-local:

- no API Ingress is rendered or retained from an older deployment;
- the Service is `ClusterIP` only;
- ingress-nginx is not allowed by the API NetworkPolicy;
- ingress is limited to observability and labeled Zed workloads; and
- egress is limited to cluster DNS and namespace-local pgvector/Postgres.

The pgvector image is load-bearing: registry migration
`m20260726_000007_embeddings_and_tags` creates the PostgreSQL `vector`
extension. The workflow verifies that migration installed a `0.8.x` extension.

Metadata and artifact bytes are reset together. Postgres is restarted first;
then the Recreate API and web workloads are restarted, yielding a consistent
empty registry before package certification begins.

## Package interdependency certification

Each cloud job builds a pinned Zed CLI and checks out exact release-source
revisions for:

1. `opto-sync/syncer@0.2.1`;
2. `opto-sync/opto-sync-clients@0.2.0`;
3. `opto-sync/opto-sync-e2e@0.1.0`.

After the cluster is healthy, the runner opens a `kubectl port-forward` to the
live cluster-local API Service. It publishes the three packages in dependency
order, verifies registry metadata and SHA-256 identities, and creates a blank
consumer declaring only `opto-sync/opto-sync-e2e`.

A normal install must materialize all three packages under
`zed_modules/opto-sync/`. The job then removes both `zed_modules` and the entire
Zed download store and repeats with `zed install --frozen`. The first and frozen
lockfiles must be byte-identical.

The retained 30-day evidence includes:

- source-to-digest image identities;
- digest-pinned rendered manifests;
- running pod image IDs and deployment specs;
- the effective API NetworkPolicy;
- package metadata JSON;
- port-forward diagnostics; and
- both lockfiles.

Evidence is scanned for the kubeconfig payload and GHCR token before upload.

## Public endpoints

The intended public names remain:

| Cloud | Registry API | Web UI |
| --- | --- | --- |
| AWS | `https://registry.aws.zpkg.net` | `https://web.aws.zpkg.net` |
| Hetzner | `https://registry.hetzner.zpkg.net` | `https://web.hetzner.zpkg.net` |

The web UI may be promoted through each cloud's read-only edge. The registry API
must not be exposed while bootstrap bypasses are active. Public API promotion is
separate work under DEN-534 and DEN-535 and requires authentication, tag
verification, rate limiting, durable storage, and a replacement NetworkPolicy.
AWS uses the existing hostPort gateway; Hetzner uses ingress-nginx and
cert-manager. Those architectures must remain distinct.

## GitOps transition

The direct protected workflow is the current deployment controller. The AWS and
Hetzner Argo application catalogs do not yet instantiate the Zed bootstrap. The
GitOps transition must preserve all current invariants: pinned source revisions,
digest-only images, Recreate ownership, cluster-local API policy, simultaneous
volatile-tier reset, and package certification evidence. This is related to the
cross-cluster application-registry work in DEN-630.

## Production transition

Before accepting untrusted public publishers:

1. move metadata to durable PostgreSQL/Supabase with pgvector enabled;
2. move artifacts to R2/S3 and raise the API replica count;
3. restore authentication, tag verification, and rate limiting;
4. create authenticated cloud-specific API overlays and NetworkPolicies;
5. add AWS gateway and Hetzner ingress routes only after direct-origin tests;
6. add Cloudflare DNS and enforce the public readiness canary; and
7. replace direct deployment with pinned Argo applications without weakening
   the digest or certification contracts.
