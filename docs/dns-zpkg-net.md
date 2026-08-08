# zpkg.net DNS cutover runbook

The public domain is **zpkg.net**. `zpkg.tech` is parked for a future purpose
and must not accumulate app records. Both zones are on Cloudflare
(`maya`/`memphis` nameservers); zone ids (per the 2026-08-07 audit backup doc
in Linear): zpkg.net `b559136046dcffc550ee8b3ed49cdf09`, zpkg.tech
`4fbe6fea03ef155acfaabb906fe7489c`, account `62b833940607839add74bd2379cac303`.

State inherited from the 2026-08-07 Cloudflare audit/hardening pass (Linear
docs "Cloudflare — 2026-08-07 audit…" and "…DNS backup — pre-change
snapshot"): both zpkg zones already run `ssl: strict`, `min_tls_version: 1.2`,
`always_use_https: on`; zpkg.net carries SPF/DMARC/null-MX anti-spoofing
records (now declared in this module — import them) plus the live registry
tunnel CNAME; zpkg.tech carries only its three anti-spoofing records, which
deliberately stay dashboard-managed.

## Hostname map

| Hostname | Serves | Backed by |
| --- | --- | --- |
| `zpkg.net` (+ `www`) | Marketing site | GitHub Pages (`zed-pkg/zed-pkg.github.io`) |
| `api.zpkg.net` | API server root | `zed-api-server` on k8s (port 8080) |
| `registry.zpkg.net` | Registry REST API | Same root as `api.zpkg.net` today; later a sub-path of the API server (ingress path route or edge rewrite — DNS unchanged) |
| `web.zpkg.net` | Read-only registry UI | `zed-web-server` on k8s (port 8081) |
| `api./registry./web.<cloud>.zpkg.net` | Per-cloud canary/debug | `k8s/overlays/{aws,hetzner}` in the app repos |
| `origin-hetzner.zpkg.net`, `origin-aws.zpkg.net` | Origin A records, never proxied | Cluster edge nodes (ORESoftware/k8s-cluster) |

Defaults that already point here: `zed-cli` ships with
`registry.zpkg.net`, and `zed-interfaces` `DEFAULT_REGISTRY_URL` is
`https://registry.zpkg.net`.

## One-time apply

1. **Token.** Create a Cloudflare API token scoped to Zone:DNS:Edit on
   `zpkg.net` (plus account R2 write if you want terraform to manage the
   buckets in the same apply). Export it as `CLOUDFLARE_API_TOKEN` — it is
   deliberately not a terraform variable. The athleto/fiducia/sonus tokens on
   disk are zone-scoped elsewhere; a broader DNS-edit token was granted
   temporarily during the 2026-08-07 audit (see the audit doc) — if it is
   still live, prefer minting the narrow zone token anyway.
2. **tfvars.** `cp terraform.tfvars.example terraform.tfvars` — the example
   already carries the real `account_id` and `zpkg.net` `zone_id`.
3. **Import the existing registry record — it is LIVE, not stray.** The
   manually created, proxied `registry.zpkg.net` record is a CNAME to the
   `zpkg-registry-local` Cloudflare tunnel, which serves the real registry
   (with published packages) off a laptop's `localhost:8080` (DEN-2760;
   zed-cli's shipped default resolves through it). Applying with defaults
   repoints it at the cluster, which serves nothing until DEN-534/DEN-535
   promote the public API — so either accept that gap, or set
   `registry_origin` in tfvars to the tunnel hostname
   (`<tunnel-id>.cfargotunnel.com`, visible in the record you import) to
   keep the tunnel serving through the transition, and clear it at
   promotion. While the override is set, the drift check reports the
   registry record as DIFFERS — that is the expected transitional state.
   Import so the first plan is an update rather than a create conflict:

   ```sh
   # list records to get <record_id>
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/<zone_id>/dns_records?name=registry.zpkg.net" | jq '.result[] | {id, type, content, proxied}'
   terraform import cloudflare_dns_record.registry <zone_id>/<record_id>
   ```

   Import the R2 buckets too if they already exist
   (`terraform import cloudflare_r2_bucket.artifacts <account_id>/zed-pkg-artifacts`).
4. **Plan/apply** with `proxy_app_records = false` (the default). Review the
   plan: expect creates for apex/www/web/origins/per-cloud and an update for
   the imported registry record (proxied → false).
5. **GitHub Pages custom domain.** After the apex record resolves:

   ```sh
   gh api -X PUT repos/zed-pkg/zed-pkg.github.io/pages \
     -f "cname=zpkg.net" -F "https_enforced=false"
   # wait for GitHub to issue the cert (Settings → Pages shows progress), then:
   gh api -X PUT repos/zed-pkg/zed-pkg.github.io/pages -F "https_enforced=true"
   ```

   The repo also carries `public/CNAME` so a settings wipe self-heals on the
   next deploy. Optionally verify the domain org-wide (Org → Settings →
   Verified domains) to protect against takeover.
6. **Cluster certs.** With DNS-only records resolving to the Hetzner edge,
   cert-manager (`letsencrypt-prod`, HTTP-01) issues `zed-api-server-tls` /
   `zed-web-server-tls` once the app Ingresses are synced. Note: the API
   Ingress is deliberately excluded while bootstrap bypasses
   (`ZED_AUTH_DISABLED`, `ZED_RATE_LIMIT_DISABLED`) are active — public API
   promotion is DEN-534/DEN-535. `web.zpkg.net` can go live first.
7. **Flip the proxy** (optional, after certs exist): set
   `proxy_app_records = true` and re-apply. Origin and per-cloud records stay
   DNS-only forever.

## Keeping the zone synced with the repo

CI runs `scripts/check-cloudflare-drift.sh` (workflow `cloudflare drift`) on
terraform PRs, weekly, and on dispatch — it compares the live zone against
the records declared in `terraform/cloudflare/main.tf` and fails on missing,
divergent, or unmanaged records. To arm it, add:

- repo secret `CLOUDFLARE_DNS_READ_TOKEN` — a second, read-only token
  (Zone:DNS:Read on zpkg.net only), never the edit token;
- repo variable `ZPKG_NET_ZONE_ID`.

Until both exist the job succeeds with a "not configured" notice. When the
edit token gains a second operator or CI applies, enable the commented R2
`backend "s3"` block in `main.tf` first — two concurrent local states against
one zone will silently fight.

## Verification

```sh
dig +short zpkg.net            # GitHub Pages IPs (185.199.108-111.153)
dig +short web.zpkg.net        # origin-hetzner (or CF proxy IPs once flipped)
curl -sI https://zpkg.net | head -3
curl -s https://web.zpkg.net/healthz
curl -s https://api.zpkg.net/healthz        # only after DEN-534/535 promotion
curl -s https://registry.zpkg.net/healthz   # same root as api.zpkg.net today
```

As of 2026-08-07 the Hetzner edge (95.217.171.250) did not answer on 80/443
from the public internet — check the node and `hcloud firewall` rules before
debugging DNS.
