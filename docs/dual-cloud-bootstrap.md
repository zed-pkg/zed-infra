# Dual-cloud Zed registry bootstrap

`deploy zed cloud` deploys the same temporary registry profile to two independent
Kubernetes clusters through protected GitHub Environments named `aws` and
`hetzner`.

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
- one Postgres replica owns a 512 MiB memory-backed `emptyDir` metadata store;
- two read-only web replicas share that metadata service;
- automatic migrations, authentication bypass, tag-verification bypass, and
  rate-limit bypass are enabled only for this bootstrap phase.

The API must remain at one replica while storage is pod-local. Scaling it before
moving artifacts to R2/S3 would make downloads intermittently miss depending on
which replica receives the request.

## Cloud endpoints

| Cloud | Registry API | Web UI |
| --- | --- | --- |
| AWS | `https://registry.aws.zpkg.tech` | `https://aws.zpkg.tech` |
| Hetzner | `https://registry.hetzner.zpkg.tech` | `https://hetzner.zpkg.tech` |

The deployment waits for Postgres, API, and web rollouts, verifies the rendered
memory-storage contract, checks both Services from a labeled in-cluster curl pod,
and finally probes both public TLS endpoints.

## Production transition

Before accepting untrusted public publishers:

1. move metadata to durable Postgres/Supabase;
2. move artifacts to R2/S3 and raise the API replica count;
3. restore authentication, tag verification, and rate limiting;
4. pin images by digest instead of the bootstrap `main` tag;
5. replace direct deployment with the matching Argo applications once the
   `ORESoftware/k8s-cluster` installation can accept the GitOps branch.
