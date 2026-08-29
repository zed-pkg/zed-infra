# zpkg.net edge workers

Five Cloudflare Workers, one hostname each. A proxied (orange-cloud) DNS
record already gives WAF and DDoS; these Workers add *logic* the DNS record
cannot: GitHub and *public* native registries as a read-only backup when
`registry.zpkg.net` / R2 is down.

| Worker | Hostname | Role |
| --- | --- | --- |
| `registry-proxy` | `registry.zpkg.net` | A total `(method, path) -> action` state machine exposes only the current machine-registry routes from `zed-api-server.rs`; `/v1/account/*`, auth, admin, and unknown paths fail before origin I/O. On an origin outage, package/version reads may use anonymously proven public npm, crates.io, or GitHub data. Writes stay origin-only. |
| `cdn-proxy` | `cdn.zpkg.net` | The Worker is the hostname's origin. Its private R2 binding exposes only content-addressed artifacts and signed metadata. Coordinate paths never read R2; they require an anonymously successful npm/crates.io read or a GitHub repository explicitly reported as public. |
| `web-proxy` | `web.zpkg.net` | Alias of `user.zpkg.net`. |
| `app-proxy` | `app.zpkg.net` | Alias of `user.zpkg.net`. |
| `user-proxy` | `user.zpkg.net` | Origin proxy for `zed-web-server.rs` on k8s. |

`cdn.zpkg.net` is a Worker **Custom Domain**, declared in
`cdn-proxy/wrangler.toml`. The R2 bucket remains private and has neither an R2
custom domain nor public `r2.dev` access, because either would bypass the
Worker's key-space confinement. Do not also create a DNS record or CNAME this
hostname to k8s; Cloudflare creates the record and certificate for the Worker.

When Cloudflare R2 *and* the registry origin are both unreachable, the
remaining public backups are:

1. **npm or crates.io**, only through fixed HTTPS hosts and paths, with no
   credentials, bounded metadata/artifact sizes, and redirect allowlists.
2. **GitHub REST/Releases** only after an anonymous repository lookup reports
   `private: false` and `visibility: public`. No GitHub token is attached to
   this public edge. Private GitHub Packages/GHCR are never proxied.

The GitHub path is proven by `zed-pkg-test/zed-pkg-e2e`
`scripts/github_api_fallback.py`.

## Deploy

```bash
cd workers
npm test
npx wrangler deploy --config registry-proxy/wrangler.toml
npx wrangler deploy --config cdn-proxy/wrangler.toml
npx wrangler deploy --config web-proxy/wrangler.toml
npx wrangler deploy --config app-proxy/wrangler.toml
npx wrangler deploy --config user-proxy/wrangler.toml
```

CI does **not** deploy. DNS for `app.zpkg.net` / `user.zpkg.net` is in
terraform; Worker routes require those records to be proxied.

The three web route Workers fetch the original public URL. On a Worker Route,
that reaches the underlying Terraform DNS origin while preserving the public
Host used by Kubernetes Ingress. An optional `ORIGIN_RESOLVE_OVERRIDE` may
select another hostname in the same Cloudflare zone during a controlled
cutover; normal operation leaves it unset.

## Tests

The test suite proves the registry transition table, fail-before-I/O rejects,
request-body preservation, public-only fallback checks, redirect/size bounds,
and R2 key-space confinement without needing Cloudflare credentials.
CI additionally checks the transition table against the current
`zed-api-server.rs` machine-registry OpenAPI, so a new API route cannot become
silently unreachable (or be replaced with a broad `/v1/*` escape hatch).

```bash
cd workers && npm test
```
