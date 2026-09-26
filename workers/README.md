# zpkg.net edge workers

Seven Cloudflare Workers, one hostname each. A proxied (orange-cloud) DNS
record already gives WAF and DDoS; these Workers add *logic* the DNS record
cannot: GitHub and *public* native registries as a read-only backup when
`registry.zpkg.net` / R2 is down.

| Worker | Hostname | Role |
| --- | --- | --- |
| `api-proxy` | `api.zpkg.net` | Full stateful API pass-through. Authentication, authorization, and writes remain origin-owned. Transport and Cloudflare origin failures become typed, cache-disabled 503s; this hostname never substitutes GitHub content for the API. |
| `registry-proxy` | `registry.zpkg.net` | A total `(method, path) -> action` state machine exposes only the current machine-registry routes from `zed-api-server.rs`; `/v1/account/*`, auth, admin, and unknown paths fail before origin I/O. On an origin outage, package/version reads may use public R2 metadata or anonymously proven public npm, crates.io, or GitHub data. Writes stay origin-only except for the explicitly enabled operator public-publication path below. |
| `cdn-proxy` | `cdn.zpkg.net` | A zone Worker Route is the hostname's public byte boundary. Its private R2 binding exposes only content-addressed artifacts and signed metadata. Coordinate paths never read R2; they require an anonymously successful npm/crates.io or GitHub Release read. |
| `web-proxy` | `web.zpkg.net` | Alias of `user.zpkg.net`. |
| `app-proxy` | `app.zpkg.net` | Alias of `user.zpkg.net`; origin failures plus exact `/`, `/login`, and `/signup` origin 404s become a cache-disabled maintenance response while the app routes are unavailable. |
| `user-proxy` | `user.zpkg.net` | Origin proxy for `zed-web-server.rs` on k8s. |
| `org-proxy` | `org.zpkg.net` | Originless Custom Domain for organization login. `/zed-pkg`, `/orgs/zed-pkg`, and `/login?org=zed-pkg` redirect only to the fixed app sign-in origin with a validated local return path. Unknown paths and untrusted redirect input fail before I/O. |

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

## Public publication and private-package boundary

During an origin outage, version publication can run at the edge only when
`EDGE_PUBLISH_ENABLED` is exactly `true`, `EDGE_PUBLISH_TOKEN` is configured,
and the request supplies that operator credential. This existing exception is
for **public publication only**. The operator token does not prove user
identity or ownership of a package namespace.

Publication rejects explicit non-public, unknown, or malformed `visibility`
values in either the publish metadata or `manifest.package` before writing
R2 or attempting a GHCR mirror. An omitted visibility retains the legacy
public-only contract; an explicit value must be exactly `public`. Newly
published artifact and version objects carry R2 custom metadata
`visibility=public`. This storage marker is not a user-authentication proof.

The CDN rejects objects with an explicit non-public/invalid visibility marker
before copying their headers or handling GET, HEAD, Range, or conditional
requests. Registry R2 metadata reads and version listings likewise reject
marked non-public objects, and parsed version documents reject explicit
non-public visibility. A restriction is a terminal, non-enumerating,
`no-store` 404; it never triggers a guessed public mirror lookup.

**This is not mixed public/private bucket support.** Unmarked legacy objects
remain public under the existing storage contract, and direct CDN metadata
reads rely on the R2 marker rather than interpreting the JSON body. All
writers must be brought under a reviewed visibility/ownership contract before
private content enters this bucket. Existing cached content also requires an
explicit cache-remediation plan; changing an object marker cannot retract
bytes already downloaded or cached elsewhere. Full private registry and
artifact ownership work remains tracked in
[zed-api-server.rs#101](https://github.com/zed-pkg/zed-api-server.rs/issues/101).

The follow-up authenticated fallback work must consume Shared Auth's shared
verification/proof-policy boundary, enforce expiration and revocation
freshness during outages, and bind delegated credentials to one upstream and
resource scope. This patch does not forward user tokens or SSH keys, grant
private downloads, change Worker bindings, or deploy production resources.

The resource capability itself remains **Zed-issued** after both Shared Auth
proof admission and Zed package ACL authorization. It is not a Shared Auth
identity token. The offline verifier/provider planner lives in
`shared/edge-capability.js`; its security contract is documented in
[`shared-auth/edge-fallback-capability-v1.md`](../shared-auth/edge-fallback-capability-v1.md).
The canonical payload shape is owned by `zed-pkg/zed-interfaces`
`EdgeFallbackCapabilityV1`.

`org.zpkg.net` is deliberately different from the origin-backed hostnames:
`org-proxy` is the origin, so its Wrangler Custom Domain creates the DNS record
and certificate. It never accepts an arbitrary `next`, `return_to`, or target
origin. `api`, `registry`, `app`, `user`, and `web` remain Worker Routes in
front of existing proxied DNS records.

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
deployments, and verifies the API, registry/GitHub fallback, organization
login, app, and CDN boundaries after promotion. Arm it with the
`CLOUDFLARE_WORKERS_DEPLOY_TOKEN` repository secret (Cloudflare's scoped
"Edit Cloudflare Workers" token) and `CLOUDFLARE_ACCOUNT_ID` repository
variable. The token also needs access to the dedicated deployment-lease KV
namespace and Workers Routes for `zpkg.net`. DNS for the origin-backed hosts
is in Terraform; Worker Routes require those records to be proxied.

The web and full-API route Workers fetch the original public URL. On a Worker Route,
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

The test suite covers the registry transition table, API outage normalization,
organization-login open-redirect resistance, fail-before-I/O rejects,
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
