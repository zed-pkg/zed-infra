# zpkg.net public hostnames

| Hostname | Process on the cluster | What it serves |
| --- | --- | --- |
| `user.zpkg.net` | `zed-web-server.rs` | Signed-in / per-user UI |
| `api.zpkg.net` | `zed-api-server.rs` | Full API (auth, org claim, registry, graphs, …) |
| `registry.zpkg.net` | same `zed-api-server.rs` | Only the explicit machine-registry method/path table. Account/auth/admin routes are rejected even when they are compatibility routes below `/v1`. |
| `cdn.zpkg.net` | none (Worker + private R2) | Public content-addressed bytes and signed metadata; anonymously public npm/crates.io/GitHub coordinate fallback. |

`web.zpkg.net` and `app.zpkg.net` are aliases of `user.zpkg.net` so existing bookmarks and certs keep working.

DNS for the cluster hosts lives in `terraform/cloudflare`. Ingress lives in
`k8s/overlays/k8s-cluster/ingress.yaml`. `registry-proxy` is an edge route in
front of the API hostname; `cdn-proxy` is itself the origin for a Worker Custom
Domain. The API also enforces the registry Host boundary so a direct-origin
request cannot bypass the edge state machine.

## Promotion order

1. Merge `zed-api-server.rs` PR #46 and publish an immutable API image digest.
2. Promote that digest with authentication/rate limiting enabled, then prove
   `api.zpkg.net` and direct `Host: registry.zpkg.net` behavior at the origin.
3. Deploy `registry-proxy`; only then rely on public fallback behavior.
4. Deploy `cdn-proxy`, which creates `cdn.zpkg.net` as a Worker Custom Domain.
5. Prove `zed-web-server.rs` at the underlying DNS origin, then deploy the
   `user`, `web`, and `app` route Workers. They fetch the original URL so the
   public Host reaches the correct Kubernetes Ingress rule.

Do not skip step 1: removing the registry Worker is a normal edge rollback,
and the API Host guard must keep that rollback from widening the hostname.
Rollback never makes an R2 bucket public; `zpkg-cdn.zed-pkg.workers.dev`
remains the zone-independent CDN address.
