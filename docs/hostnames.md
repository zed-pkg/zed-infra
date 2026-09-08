# zpkg.net public hostnames

| Hostname | Process on the cluster | What it serves |
| --- | --- | --- |
| `user.zpkg.net` | `zed-web-server.rs` | Signed-in / per-user UI |
| `api.zpkg.net` | `zed-api-server.rs` | Full API (auth, org claim, registry, graphs, …); edge-normalized 503 on origin outage, with no content fallback. |
| `registry.zpkg.net` | same `zed-api-server.rs` | Only the explicit machine-registry method/path table. Account/auth/admin routes are rejected even when they are compatibility routes below `/v1`. |
| `cdn.zpkg.net` | none (Worker + private R2) | Public content-addressed bytes and signed metadata; anonymously public npm/crates.io/GitHub coordinate fallback. |
| `org.zpkg.net` | none (`org-proxy` Worker) | Bounded organization-login redirects into `app.zpkg.net`; Cloudflare Custom Domain owns DNS and TLS. |

`web.zpkg.net` and `app.zpkg.net` are aliases of `user.zpkg.net` so existing bookmarks and certs keep working.

Organization login accepts `/ORG`, `/orgs/ORG`, or `/login?org=ORG` and sends
the browser to `https://app.zpkg.net/auth/sign-in?return_to=/orgs/ORG`. Only a
bounded lowercase slug is accepted; caller-controlled origins and return URLs
are never forwarded.

DNS for the cluster hosts lives in `terraform/cloudflare`. Ingress lives in
`k8s/overlays/k8s-cluster/ingress.yaml`. `api-proxy` and `registry-proxy` are
edge routes in front of their API hostnames; `cdn-proxy` is an exact Worker
Route on the existing proxied CDN record and never forwards accepted artifact
paths to that DNS origin. The API also enforces the registry Host boundary so
a direct-origin request cannot bypass the edge state machine. `org-proxy` is
an originless Custom Domain and therefore has no Terraform DNS row.

## Promotion order

1. Merge `zed-api-server.rs` PR #46 and publish an immutable API image digest.
2. Promote that digest with authentication/rate limiting enabled, then prove
   `api.zpkg.net` and direct `Host: registry.zpkg.net` behavior at the origin.
3. Deploy `api-proxy` so full-API origin failures are typed and fail closed.
4. Deploy `registry-proxy`; only then rely on public fallback behavior.
5. Deploy `cdn-proxy`, which attaches the exact `cdn.zpkg.net/*` zone route.
6. Deploy `org-proxy`; its Custom Domain creates `org.zpkg.net` DNS and TLS.
7. Prove `zed-web-server.rs` at the underlying DNS origin, then deploy the
   `user`, `web`, and `app` route Workers. They fetch the original URL so the
   public Host reaches the correct Kubernetes Ingress rule.

Do not skip step 1: removing the registry Worker is a normal edge rollback,
and the API Host guard must keep that rollback from widening the hostname.
Rollback never makes an R2 bucket public; `zpkg-cdn.alexander-d-mills.workers.dev`
remains the zone-independent CDN address.
