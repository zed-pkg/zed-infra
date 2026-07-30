#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/resolve-zed-images.sh"
bash -n "$script"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zed-image-contract.XXXXXX")"
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

fake_bin="$work/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'login ghcr.io'*) cat >/dev/null ;;
  *'pull ghcr.io/zed-pkg/zed-api-server:api-ref'*) ;;
  *'pull ghcr.io/zed-pkg/zed-web-server:web-ref'*) ;;
  *'image inspect ghcr.io/zed-pkg/zed-api-server:api-ref'*)
    cat <<JSON
[{"Architecture":"amd64","Os":"linux","RepoDigests":["ghcr.io/zed-pkg/zed-api-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"Config":{"Labels":{"org.opencontainers.image.revision":"${FAKE_API_LABEL:-api-ref}","io.zpkg.interfaces.revision":"interfaces-ref"}}}]
JSON
    ;;
  *'image inspect ghcr.io/zed-pkg/zed-web-server:web-ref'*)
    cat <<JSON
[{"Architecture":"amd64","Os":"linux","RepoDigests":["ghcr.io/zed-pkg/zed-web-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"Config":{"Labels":{"org.opencontainers.image.revision":"web-ref","io.zpkg.interfaces.revision":"interfaces-ref"}}}]
JSON
    ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 90 ;;
esac
SH
chmod +x "$fake_bin/docker"

export PATH="$fake_bin:$PATH"
export ZED_API_REF=api-ref
export ZED_WEB_REF=web-ref
export ZED_INTERFACES_REF=interfaces-ref
export ZED_GHCR_USERNAME=contract-user
export ZED_GHCR_TOKEN=contract-token-must-not-leak
export ZED_IMAGE_EVIDENCE="$work/evidence.txt"
export GITHUB_ENV="$work/github.env"
unset GITHUB_ACTIONS || true

bash "$script" > "$work/stdout.txt"
grep -q '^api_source_revision=api-ref$' "$ZED_IMAGE_EVIDENCE"
grep -q '^web_source_revision=web-ref$' "$ZED_IMAGE_EVIDENCE"
grep -q '^interfaces_revision=interfaces-ref$' "$ZED_IMAGE_EVIDENCE"
grep -q '^ZED_API_IMAGE=ghcr.io/zed-pkg/zed-api-server@sha256:a' "$GITHUB_ENV"
grep -q '^ZED_WEB_IMAGE=ghcr.io/zed-pkg/zed-web-server@sha256:b' "$GITHUB_ENV"
! grep -R -Fq "$ZED_GHCR_TOKEN" "$work"

export FAKE_API_LABEL=wrong-ref
if bash "$script" >"$work/mismatch.out" 2>"$work/mismatch.err"; then
  echo 'resolver unexpectedly accepted a source-label mismatch' >&2
  exit 1
fi
grep -q 'api image revision label mismatch' "$work/mismatch.err"

printf 'immutable image resolver contract passed\n'
