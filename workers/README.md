# zpkg.net edge workers

Five Cloudflare Workers, one hostname each. A proxied (orange-cloud) DNS
record already gives WAF and DDoS; these Workers add *logic* the DNS record
cannot: GitHub and *public* native registries as a read-only backup when
`registry.zpkg.net` / R2 is down.

| Worker | Hostname | Role |
| --- | --- | --- |
| `registry-proxy` | `registry.zpkg.net` | A total `(method, path) -> action` state machine exposes only the current machine-registry routes from `zed-api-server.rs`; `/v1/account/*`, auth, admin, and unknown paths fail before origin I/O. On an origin outage, package/version reads may use anonymously proven public npm, crates.io, or GitHub data. Writes stay origin-only. |
| `cdn-proxy` | `cdn.zpkg.net` | A zone Worker Route is the hostname's public byte boundary. Its private R2 binding exposes only content-addressed artifacts and signed metadata. Coordinate paths never read R2; they require an anonymously successful npm/crates.io or GitHub Release read. |
| `web-proxy` | `web.zpkg.net` | Alias of `user.zpkg.net`. |
| `app-proxy` | `app.zpkg.net` | Alias of `user.zpkg.net`; origin failures plus exact `/`, `/login`, and `/signup` origin 404s become a cache-disabled maintenance response while the app routes are unavailable. |
| `user-proxy` | `user.zpkg.net` | Origin proxy for `zed-web-server.rs` on k8s. |

`cdn.zpkg.net` uses its existing proxied DNS record plus the exact
`cdn.zpkg.net/*` Worker Route declared in `cdn-proxy/wrangler.toml`. The R2
bucket remains private and has neither an R2 custom domain nor public `r2.dev`
access, because either would bypass the Worker's key-space confinement. The
DNS target is only a fail-closed fallback origin; successful CDN requests are
intercepted by the Worker before origin I/O.

When Cloudflare R2 *and* the registry origin are both unreachable, the
remaining public backups are:

1. **npm or crates.io**, only through fixed HTTPS hosts and paths, with no
   credentials, bounded metadata/artifact sizes, and redirect allowlists.
2. **GitHub REST/Releases** with no GitHub token attached to this public edge.
   Registry metadata uses anonymous REST responses; CDN bytes are public only
   when the allowlisted release URL itself succeeds anonymously. Private
   GitHub Packages/GHCR are never proxied.

The GitHub path is proven by `zed-pkg-test/zed-pkg-e2e`
`scripts/github_api_fallback.py`.

## Deploy

Do **not** run raw `wrangler deploy` against a live script. Read the remote
Worker first, take a KV lease, then deploy. See `docs/cf-deploy-leases.md`.
`zpkg-cdn` already serves GitHub-fallback (`workers/live-snapshots/zpkg-cdn.json`);
overwriting it without `--if-match` of that `modified_on` is forbidden.

```bash
cd workers
npm ci --ignore-scripts
npm test
just cf-snapshot zpkg-cdn
just cf-deploy cdn-proxy <modified_on from snapshot>
```

`.github/workflows/deploy-cloudflare-workers.yml` deploys every canonical
Worker after a tested Worker change lands on `main`. It uses the same live
snapshot and KV lease as the manual path, pins Wrangler, serializes production
deployments, and verifies `app.zpkg.net` after promotion. Arm it with the
`CLOUDFLARE_WORKERS_DEPLOY_TOKEN` repository secret (Cloudflare's scoped
"Edit Cloudflare Workers" token) and `CLOUDFLARE_ACCOUNT_ID` repository
variable. DNS for `app.zpkg.net` / `user.zpkg.net` is in Terraform; Worker
routes require those records to be proxied.

The three web route Workers fetch the original public URL. On a Worker Route,
that reaches the underlying Terraform DNS origin while preserving the public
Host used by Kubernetes Ingress. An optional `ORIGIN_RESOLVE_OVERRIDE` may
select another hostname in the same Cloudflare zone during a controlled
cutover; normal operation leaves it unset.

For browser navigation, the app Worker renders a small static HTML 503 at the
edge when `/`, `/login`, or `/signup` is unavailable, including transport and
Cloudflare origin failures. It sends `Retry-After: 7200` and tells users to
return in about two hours. Non-browser clients retain the typed JSON 503.
Ordinary origin 404s are preserved so the Worker cannot mask a misspelled or
unknown route.

## Tests

The test suite covers the registry transition table, fail-before-I/O rejects,
request-body preservation, public-only fallback checks, redirect/size bounds,
and R2 key-space confinement without needing Cloudflare credentials.
CI additionally checks the transition table against the current
`zed-api-server.rs` machine-registry OpenAPI, so a new API route cannot become
silently unreachable (or be replaced with a broad `/v1/*` escape hatch).

```bash
cd workers && npm ci --ignore-scripts && npm test
```

Use Node 24.19.0. The locked suite includes strict TypeScript checking of the
shared origin decision table, all 276 finite handler scenarios, and real
workerd/TCP/WebSocket tests through the app, user, and web modules. A WebSocket
upgrade retains its handshake and end-to-end identity headers; the origin
remains the authentication authority. The setup deadline is disarmed after
the handshake, and successful 101 responses keep the original runtime socket.

The repository-owned [fmctl model and replay gate](../formal/README.md) verifies
the corresponding finite protocol boundary with positive witnesses and
negative controls. Model/fixture evidence is not proof of a live deployment.
