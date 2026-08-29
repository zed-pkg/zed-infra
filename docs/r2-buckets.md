# R2 buckets for zpkg.net

Published artifacts are public. The API must not sit on the install
critical path: `zed install --frozen` reads `https://cdn.zpkg.net/…`
(or GitHub Releases) when `registry.zpkg.net` is 502.

Do **not** enable the Cloudflare-managed `r2.dev` hostname on the
production bucket. It is rate-limited and not a production CDN. Use the
`cdn.zpkg.net` custom domain (and the `cdn-proxy` Worker, which confines
keys and falls back to GitHub).

## Live inventory (account `62b833940607839add74bd2379cac303`)

Verified via the Cloudflare R2 API on 2026-08-29. Location hint on the
live buckets is **ENAM**.

| Bucket | Role | Public hostname |
| --- | --- | --- |
| `zed-pkg-artifacts` | Production tarballs (`packages/`, `github/`, `artifacts/<sha256>`) | `cdn.zpkg.net` (custom domain — **not attached yet**; hostname NXDOMAIN) |
| `zed-pkg-artifacts-dev` | Non-prod publishes | none (terraform-declared; create if missing) |
| `zed-pkg-artifacts-e2e` | zed-pkg-test canaries | none |
| `zed-pkg-static-registry-e2e` | Static registry fixture for e2e | none |

S3-compatible endpoint (writes from `zed-api-server`, never from the
browser):

```
https://62b833940607839add74bd2379cac303.r2.cloudflarestorage.com
region = auto
```

## Attach `cdn.zpkg.net` (one-time)

The zone is already on this Cloudflare account. Connecting the custom
domain creates the proxied CNAME; do not also hand-edit `cdn.zpkg.net`.

Dashboard (production bucket → Settings → Custom Domains → Add):

<https://dash.cloudflare.com/62b833940607839add74bd2379cac303/r2/default/buckets/zed-pkg-artifacts>

Or, with a Zone:DNS:Edit + R2 token:

```sh
# CLOUDFLARE_API_TOKEN in the environment; do not print it
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/62b833940607839add74bd2379cac303/r2/buckets/zed-pkg-artifacts/domains/custom" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"domain":"cdn.zpkg.net","enabled":true,"zoneId":"b559136046dcffc550ee8b3ed49cdf09","minTLS":"1.2"}'
```

Terraform equivalent: `cloudflare_r2_custom_domain.cdn` in
`terraform/cloudflare/main.tf`.

Proof after attach (404 on a missing key is success; NXDOMAIN is not):

```sh
dig +short cdn.zpkg.net
curl -sI https://cdn.zpkg.net/ | head -8
```

## Worker binding

`workers/cdn-proxy/wrangler.toml` binds `ARTIFACTS` → `zed-pkg-artifacts`.
Deploy that Worker *before* relying on GitHub fallback for unknown keys;
the custom domain alone serves R2 hits and 404s misses.
