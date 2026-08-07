#!/usr/bin/env bash
# Compare the live zpkg.net Cloudflare zone against the records declared in
# terraform/cloudflare/main.tf. State-free on purpose: terraform state is
# local (see main.tf), so CI cannot `terraform plan` against reality. This
# script asserts the expected records exist with the expected content and
# reports any unexpected records in the zone, so the repo stays the source
# of truth even between applies.
#
# KEEP THE TABLE BELOW IN SYNC WITH terraform/cloudflare/main.tf.
#
# Env: CLOUDFLARE_API_TOKEN (Zone:DNS:Read is enough), ZPKG_NET_ZONE_ID.
# Exit: 0 in sync, 1 drift, 2 config/auth error.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required (Zone:DNS:Read)}"
: "${ZPKG_NET_ZONE_ID:?ZPKG_NET_ZONE_ID is required}"

# name|type|content|proxied — mirrors terraform/cloudflare/main.tf.
expected="$(cat <<'TABLE'
zpkg.net|CNAME|zed-pkg.github.io|false
www.zpkg.net|CNAME|zed-pkg.github.io|false
origin-hetzner.zpkg.net|A|95.217.171.250|false
origin-aws.zpkg.net|A|98.90.186.114|false
registry.zpkg.net|CNAME|origin-hetzner.zpkg.net|false
web.zpkg.net|CNAME|origin-hetzner.zpkg.net|false
registry.aws.zpkg.net|CNAME|origin-aws.zpkg.net|false
web.aws.zpkg.net|CNAME|origin-aws.zpkg.net|false
registry.hetzner.zpkg.net|CNAME|origin-hetzner.zpkg.net|false
web.hetzner.zpkg.net|CNAME|origin-hetzner.zpkg.net|false
TABLE
)"

live_json="$(curl -fsS --retry 3 \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones/${ZPKG_NET_ZONE_ID}/dns_records?per_page=200")" || {
  echo "ERROR: Cloudflare API call failed (token scope or zone id)" >&2
  exit 2
}
[ "$(jq -r '.success' <<<"$live_json")" = "true" ] || {
  jq -r '.errors' <<<"$live_json" >&2
  exit 2
}

live="$(jq -r '.result[] | "\(.name)|\(.type)|\(.content)|\(.proxied)"' <<<"$live_json" | sort)"
drift=0

while IFS='|' read -r name type content proxied; do
  match="$(awk -F'|' -v n="$name" -v t="$type" '$1==n && $2==t' <<<"$live")"
  if [ -z "$match" ]; then
    echo "MISSING  ${name} ${type} -> ${content}"
    drift=1
  elif [ "$match" != "${name}|${type}|${content}|${proxied}" ]; then
    # registry.zpkg.net/web.zpkg.net may legitimately be proxied after the
    # post-cert flip (proxy_app_records=true); only content counts for them.
    live_content="$(cut -d'|' -f3 <<<"$match")"
    case "$name" in
      registry.zpkg.net|web.zpkg.net)
        if [ "$live_content" != "$content" ]; then
          echo "DIFFERS  ${name}: live '${match}' want content '${content}'"
          drift=1
        fi
        ;;
      *)
        echo "DIFFERS  ${name}: live '${match}' want '${name}|${type}|${content}|${proxied}'"
        drift=1
        ;;
    esac
  fi
done <<<"$expected"

# Anything live that the repo does not declare (ignore NS/SOA-ish types CF
# does not return here, and ACME TXT records cert tooling may create).
while IFS='|' read -r name type content proxied; do
  [ -z "$name" ] && continue
  case "$type" in TXT) [[ "$name" == _acme-challenge.* ]] && continue ;; esac
  if ! grep -qF "${name}|${type}|" <<<"$expected"; then
    echo "UNMANAGED ${name} ${type} -> ${content} (not in terraform)"
    drift=1
  fi
done <<<"$live"

if [ "$drift" -eq 0 ]; then
  echo "zone matches terraform/cloudflare/main.tf ($(wc -l <<<"$expected" | tr -d ' ') records)"
fi
exit "$drift"
