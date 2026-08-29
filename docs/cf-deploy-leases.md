# Cloudflare deploy leases

Workers and DNS on the shared Cloudflare account (`62b833940607839add74bd2379cac303`)
are not exclusive to zed-pkg. `sonusauris-app-proxy` and fiducia/memebank R2
buckets live here too. A `wrangler deploy` without a read + lock will overwrite
unread live code.

## Rules

1. **Read first.** `GET` the live Worker (or prove 404) before any upload.
2. **If-Match.** Acquire a lease only with `--if-match <live modified_on>`.
   If the remote moved, stop and re-read. Do not "just deploy".
3. **Lease.** Exclusive key in KV namespace `zed-pkg-deploy-leases`
   (`064c38e7ffbf406c94167542ede580e8`), key `lease:worker:<name>`, TTL 30m.
4. **Allowlist.** Only `zpkg-cdn`, `zpkg-cdn-dev`, `zpkg-registry-proxy`,
   `zpkg-user-proxy`, `zpkg-web-proxy`, `zpkg-app-proxy`. Refuse everything
   else (including `sonusauris-app-proxy`).
5. **Create is still a lock.** A Worker that does not exist yet requires
   `--create-missing` after a 404 snapshot. Attaching a route to an existing
   hostname (`registry.zpkg.net`) is a live traffic change; treat it like an
   overwrite of that hostname's behavior.
6. **Do not write prod R2** (`zed-pkg-artifacts`) as a side channel for locks.
   Leases live in the dedicated KV namespace only.

Recorded live snapshot for `zpkg-cdn` (read 2026-08-29, GitHub-fallback
already shipped): `workers/live-snapshots/zpkg-cdn.json`.
`modified_on=2026-08-29T19:10:25.251597Z`. That script is serving
`x-zed-source: github-release` for the public canary; do not replace it
unless the snapshot is re-read and the lease matches.

## Commands

```bash
# Read-only snapshot (needs a real CLOUDFLARE_API_TOKEN, not PLACEHOLDER)
node workers/scripts/cf-lease.mjs snapshot --worker zpkg-cdn

# Lock, then and only then wrangler. Release even if deploy fails.
node workers/scripts/cf-lease.mjs acquire --worker zpkg-cdn \
  --if-match 2026-08-29T19:10:25.251597Z
npx wrangler deploy --config workers/cdn-proxy/wrangler.toml
node workers/scripts/cf-lease.mjs release --worker zpkg-cdn
```

`just cf-deploy cdn-proxy` wraps acquire → deploy → release. It fails closed
when the sops token is still `PLACEHOLDER`.

KV has no compare-and-swap. The script re-reads the lease key immediately
before PUT and refuses a foreign unexpired holder. That is a short race, not
a reason to skip the lock.
