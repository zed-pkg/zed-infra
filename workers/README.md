# zpkg.net edge workers

Five Cloudflare Workers, one hostname each. A proxied (orange-cloud) DNS
record already gives WAF and DDoS; these Workers add *logic* the DNS record
cannot: GitHub and *public* native registries as a read-only backup when
`registry.zpkg.net` / R2 is down.

| Worker | Hostname | Role |
| --- | --- | --- |
| `registry-proxy` | `registry.zpkg.net` | Proxy `zed-api-server`. On 5xx/timeout, reconstruct `GET /healthz`, `GET /v1/packages/{org}/{name}`, and `GET /v1/packages/{org}/{name}/versions/{version}` from (1) public native APIs when `org` is `npm` / `crates-io` / `pypi` / … and the package is public, then (2) the GitHub REST API (tags + Releases). Writes stay origin-only and return 503. Private packages (401/403/`private: true`/unpublished) are a miss. |
| `cdn-proxy` | `cdn.zpkg.net` | Read the `zed-pkg-artifacts` R2 binding first. On miss, fetch a public native tarball when the key is `packages/{native-org}/{name}/{version}/…`, else the matching GitHub Release asset. |
| `web-proxy` | `web.zpkg.net` | Alias of `user.zpkg.net`. |
| `app-proxy` | `app.zpkg.net` | Alias of `user.zpkg.net`. |
| `user-proxy` | `user.zpkg.net` | Origin proxy for `zed-web-server.rs` on k8s. |

`cdn.zpkg.net` is *also* declared as `cloudflare_r2_custom_domain` in
`terraform/cloudflare`. A Worker route on that hostname takes precedence and
uses the R2 **binding**, so the custom domain is the no-Worker fallback and
the Worker is the GitHub-aware path. Do not CNAME `cdn.zpkg.net` at k8s.

When Cloudflare R2 *and* the registry origin are both unreachable, the
remaining public backups are:

1. **Public native registries** when the zed org is a `NativeHost` token
   (`npm`, `crates-io`, `pypi`, `rubygems`, `hex`, `pub-dev`, `nuget`,
   `hackage`, `packagist`, `go-proxy`). No credentials are sent. Enterprise
   hosts (Artifactory, TestPyPI, private GitHub Packages) are not proxied.
2. **GitHub** (`api.github.com` / Releases / GHCR) for every other org, and
   as a second try after a native miss.

The GitHub path is proven by `zed-pkg-test/zed-pkg-e2e`
`scripts/github_api_fallback.py`.

## Deploy

```bash
cd workers
node --test shared/github-fallback.test.js shared/native-public.test.js
npx wrangler deploy --config registry-proxy/wrangler.toml
npx wrangler deploy --config cdn-proxy/wrangler.toml
npx wrangler deploy --config web-proxy/wrangler.toml
npx wrangler deploy --config app-proxy/wrangler.toml
npx wrangler deploy --config user-proxy/wrangler.toml
# optional, raises GitHub rate limits for the registry worker:
npx wrangler secret put GITHUB_TOKEN --config registry-proxy/wrangler.toml
```

CI does **not** deploy. DNS for `app.zpkg.net` / `user.zpkg.net` is in
terraform; Worker routes require those records to be proxied.

## Tests

`shared/github-fallback.js` is Cloudflare-binding-free so Node can import it.

```bash
cd workers && npm test
```
