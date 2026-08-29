# R2 buckets for zpkg.net

Published artifacts must remain installable when the registry API is down.
`zed install --frozen` can read digest-pinned bytes from `cdn.zpkg.net` and
verify them locally.

All R2 buckets stay private. Do **not** enable an `r2.dev` hostname or attach
an R2 custom domain to the production bucket: either would bypass the audited
Worker key-space boundary. `cdn.zpkg.net` is intercepted by an exact Worker
Route on its existing proxied DNS record, and the Worker reads R2 only through
its binding.

## Live inventory

Verified in the Cloudflare dashboard on 2026-08-29. All four buckets use the
Eastern North America (`ENAM`) location and have public access disabled.

| Bucket | Role | Edge binding |
| --- | --- | --- |
| `zed-pkg-artifacts` | Production artifacts and metadata | `zpkg-cdn` → `ARTIFACTS` |
| `zed-pkg-artifacts-dev` | Non-production publishes | `zpkg-cdn-dev` → `ARTIFACTS` |
| `zed-pkg-artifacts-e2e` | `zed-pkg-test` canaries | E2E credentials only |
| `zed-pkg-static-registry-e2e` | Static registry fixtures | E2E credentials only |

`zed-pkg-artifacts-dev` was created in the dashboard during this audit after
the inventory found it missing. Import all four existing buckets into
Terraform state before the first apply; never plan them as new resources.

The S3-compatible write endpoint used by `zed-api-server.rs` is:

```text
https://62b833940607839add74bd2379cac303.r2.cloudflarestorage.com
region = auto
```

Access/secret keys remain outside Terraform and Git. Browser clients never get
R2 credentials.

## Attach cdn.zpkg.net

Keep the existing proxied `cdn.zpkg.net` DNS record and deploy the audited
Worker Route. Do not use R2 bucket Settings → Custom Domains: that would bypass
the Worker. Wrangler must report the exact `cdn.zpkg.net/*` zone route.

```sh
cd workers
npm test
npx wrangler deploy --config cdn-proxy/wrangler.toml
```

The production worker keeps `workers_dev = true` deliberately. The resulting
`zpkg-cdn.alexander-d-mills.workers.dev` endpoint has a different DNS failure
domain from `zpkg.net` and appears in the mirror bootstrap document.

## Public boundary

The Worker may read R2 only for:

- `artifacts/<sha256>.tar.gz` or `artifacts/<sha256>.zip`;
- signed `metadata/<org>/<package>/index.json` and version metadata.

Coordinate paths (`packages/...` and `github/...`) never read R2, because the
bucket may later contain private aliases. Those paths require an anonymous,
bounded, allowlisted npm/crates.io response or a credential-free GitHub Release
response whose successful bytes are their own public proof. Writes and listing
are impossible through the Worker.

Verification after deployment:

```sh
dig +short cdn.zpkg.net
curl -fsS https://cdn.zpkg.net/healthz | jq .
curl -fsS https://cdn.zpkg.net/.well-known/zpkg-mirrors.json | jq .
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://cdn.zpkg.net/artifacts/$(printf '0%.0s' {1..64}).tar.gz" # 404
```
