#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
script="$script_dir/promote-oci-image.sh"
digest=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

tmp=$(mktemp -d "${TMPDIR:-/tmp}/promote-oci-test.XXXXXX")
portable_log="$tmp/portable.log"
lambda_log="$tmp/lambda.log"

PROMOTE_OCI_DRY_RUN=1 "$script" \
  "registry.example/source@sha256:$digest" \
  "registry.example/destination:sha-0123456789ab" \
  portable >"$portable_log"
grep -F -- '--all' "$portable_log" >/dev/null
grep -F -- '--preserve-digests' "$portable_log" >/dev/null

PROMOTE_OCI_DRY_RUN=1 "$script" \
  "registry.example/source@sha256:$digest" \
  "registry.example/lambda:sha-0123456789ab-arm64" \
  lambda arm64 >"$lambda_log"
grep -F -- '--override-os linux' "$lambda_log" >/dev/null
grep -F -- '--override-arch arm64' "$lambda_log" >/dev/null

if PROMOTE_OCI_DRY_RUN=1 "$script" \
  registry.example/source:latest \
  registry.example/destination:latest portable >/dev/null 2>&1; then
  printf 'expected an unpinned source to fail\n' >&2
  exit 1
fi

if PROMOTE_OCI_DRY_RUN=1 "$script" \
  "registry.example/source@sha256:$digest" \
  registry.example/destination:latest lambda multi >/dev/null 2>&1; then
  printf 'expected an unsupported Lambda architecture to fail\n' >&2
  exit 1
fi

printf 'promote-oci-image contract tests passed; logs=%s\n' "$tmp"
