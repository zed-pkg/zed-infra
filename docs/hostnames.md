# zpkg.net public hostnames

| Hostname | Process on the cluster | What it serves |
| --- | --- | --- |
| `user.zpkg.net` | `zed-web-server.rs` | Signed-in / per-user UI |
| `api.zpkg.net` | `zed-api-server.rs` | Full API (auth, org claim, registry, graphs, …) |
| `registry.zpkg.net` | same `zed-api-server.rs` | **Only** `/healthz` and `/v1/*` (packages, versions, artifacts, search). Not `/auth`, not `/shared-auth` |
| `cdn.zpkg.net` | none (R2) | Public package bytes. Worker reads `zed-pkg-artifacts`, then GitHub/npm |

`web.zpkg.net` and `app.zpkg.net` are aliases of `user.zpkg.net` so existing bookmarks and certs keep working.

DNS lives in `terraform/cloudflare`. Ingress lives in `k8s/overlays/k8s-cluster/ingress.yaml`. Edge Workers add WAF + fallback; they do not change which k8s Service owns the hostname.
