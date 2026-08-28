# cdn.zpkg.net — the public artifact mirror

## What problem this solves

Every artifact read currently goes through the registry API:

```
zed install → GET registry.zpkg.net/v1/artifacts/<sha256>
            → 302
            → 600-second presigned R2 URL
            → bytes
```

The API is therefore on the critical path of every install, including installs
that already know exactly which bytes they want. As of 2026-08-08 all three
app hostnames resolve to a Cloudflare tunnel terminating in a Docker container
on an operator's laptop (see `dns-zpkg-net.md`, DEN-2881), so "the API is
unreachable" is not hypothetical, and today it means every `zed install`
everywhere fails.

Artifacts are keyed by their own sha256, and every `.zpkg.lock` pins that
digest. A client with a lockfile does not need the API to tell it anything — it
needs bytes, and it can check them itself. This is the path that gives it those
bytes.

## Why it is safe to make public

Three independent reasons, and the first one alone is sufficient:

1. **The key is the hash of the correct answer.** A client requests
   `artifacts/<sha256>.tar.gz` and verifies what comes back against that same
   digest before it is written into the store. A hostile CDN cannot substitute
   an artifact; it can only fail to produce one.
2. **Published artifacts are already public.** They are served today to anyone
   who asks the API. Presigning them was never confidentiality, only rate
   control.
3. **The Worker confines the key space.** Only `artifacts/<sha256>.<ext>` and
   the signed metadata tree are reachable. No listing, no writes, no
   caller-supplied key.

What is *not* safe, and is not done here: making the bucket itself public.
That would expose its whole key space, and the bucket holds more than the
public artifact set.

## Two hostnames, and why the ugly one matters

```
https://cdn.zpkg.net                        friendly, in the zpkg.net zone
https://zpkg-cdn.<subdomain>.workers.dev    zone-independent
```

`cdn.zpkg.net` and `registry.zpkg.net` live in the same Cloudflare zone. An
expired registration, a mistaken DNS change, a zone suspension, or a
compromised registrar account takes both down at the same instant — so a
fallback that only exists at `cdn.zpkg.net` does not cover the failure mode
people actually lose sleep over.

The `workers.dev` hostname resolves through a zone zed does not own and cannot
misconfigure, in front of the same bucket. It is the route that survives losing
`zpkg.net` entirely. That is why `workers_dev = true` is set deliberately in
`wrangler.toml`, why it is in `zed-cli`'s built-in mirror list as
`alternate_urls`, and why turning it off to tidy the dashboard would silently
remove the property this whole thing exists for.

`zed` tries every base URL of a mirror before moving to the next mirror, so
both are attempted for every fetch.

## Key space

| Path | Cache | Notes |
| --- | --- | --- |
| `/artifacts/<sha256>.tar.gz` \| `.zip` | `immutable`, 1 year | Byte-identical to what the API serves. Digest-addressed. |
| `/metadata/<org>/<name>/index.json` | 60s + SWR | Publisher-signed version index. |
| `/metadata/<org>/<name>/versions/<version>.json` | 60s + SWR | Publisher-signed version metadata. |
| `/.well-known/zpkg-mirrors.json` | 60s + SWR | The mirror set. Static config, so it answers even if R2 is the broken thing. |
| `/healthz` | no-store | Liveness. |

Metadata gets a short cache rather than an immutable one because it changes;
staleness is bounded on the client by the signed index's monotonic `sequence`,
which is what makes a replayed old index a loud failure instead of a silent
rollback.

Anything else is a 404 **before** the bucket is read. That ordering is the
point: a shape check after the read would still be a working read oracle over
the bucket's key space.

## Deploying

Order matters. A proxied CNAME to a route with no Worker behind it serves
errors, so the Worker goes first.

```sh
# 1. The Worker, and the route it claims.
cd cloudflare/workers/zpkg-cdn
npm test                      # 13 tests, no network, no wrangler
npx wrangler deploy           # needs CLOUDFLARE_API_TOKEN with Workers + R2

# 2. Note the workers.dev hostname it prints. It belongs in
#    zed-interfaces DEFAULT_CDN_ALTERNATE_URL and in the MIRRORS binding.

# 3. DNS.
cd ../../../terraform/cloudflare
terraform apply -var enable_cdn=true
```

Verify before telling anyone it exists:

```sh
SHA=<a published artifact digest>
curl -fsS -o /dev/null -w '%{http_code}\n' "https://cdn.zpkg.net/artifacts/$SHA.tar.gz"
curl -fsS "https://cdn.zpkg.net/.well-known/zpkg-mirrors.json" | jq .
# The one that actually matters — the zone-independent route:
curl -fsS -o /dev/null -w '%{http_code}\n' \
  "https://zpkg-cdn.<subdomain>.workers.dev/artifacts/$SHA.tar.gz"
# And the refusals:
curl -s -o /dev/null -w '%{http_code}\n' https://cdn.zpkg.net/artifacts/../secrets   # 400/404
curl -s -X PUT -o /dev/null -w '%{http_code}\n' "https://cdn.zpkg.net/artifacts/$SHA.tar.gz"  # 405
```

## Populating the bucket

The API server already writes `artifacts/<sha256>.<ext>` on every publish
(`storage::artifact_key`), so the artifact space fills itself and needs no
backfill.

Metadata does not. `zed mirror publish-index` uploads the signed index, and
`zed publish` writes the signed per-version document. A package published
before signing existed has artifacts on the CDN but no metadata, which degrades
exactly as intended: frozen installs work from the CDN, range resolution still
needs the API.

## Not doing

* **Making the bucket public directly.** Exposes the whole key space.
* **`r2.dev`.** Rate-limited, and Cloudflare documents it as not for
  production.
* **Accepting writes.** A mirror that accepts writes is a second source of
  truth, and two sources of truth disagree eventually.
* **Listing.** Enumeration is how you inventory a supply chain.
