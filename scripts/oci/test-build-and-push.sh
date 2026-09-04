#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
publisher="$script_dir/build-and-push.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/oci-build-test.XXXXXX")
cleanup() {
  find "$tmp" -depth -delete
}
trap cleanup EXIT

fake_bin="$tmp/bin"
context="$tmp/context"
log="$tmp/docker.log"
aws_log="$tmp/aws.log"
mkdir -p "$fake_bin" "$context"
printf 'FROM scratch\n' >"$context/Dockerfile"
# The single-quoted generators intentionally defer expansion to each fake CLI.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%%s\\n" "$*" >>"$DOCKER_LOG"\n' >"$fake_bin/docker"
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nset -euo pipefail\ndestination="${!#}"\narchive="${destination#oci-archive:}"\narchive="${archive%%:*}"\nprintf "fake OCI archive\\n" >"$archive"\n' >"$fake_bin/skopeo"
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%%s\\n" "$*" >>"$AWS_LOG"\nif [[ "$*" == *"s3api head-object"* ]]; then\n  case "${AWS_HEAD_MODE:-missing}" in\n    missing) printf "An error occurred (404) when calling HeadObject\\n" >&2; exit 255 ;;\n    existing) exit 0 ;;\n    error) printf "An error occurred (AccessDenied) when calling HeadObject\\n" >&2; exit 255 ;;\n    *) printf "unsupported AWS_HEAD_MODE\\n" >&2; exit 64 ;;\n  esac\nfi\n' >"$fake_bin/aws"
chmod +x "$fake_bin/docker"
chmod +x "$fake_bin/skopeo"
chmod +x "$fake_bin/aws"
export PATH="$fake_bin:$PATH"
export DOCKER_LOG="$log"
export AWS_LOG="$aws_log"

action_env=(
  REGISTRY_PROVIDER=none
  REGISTRY_HOST=registry.example
  IMAGE_NAME=example/service
  IMAGE_TAG=sha-0123456789ab
  DOCKERFILE="$context/Dockerfile"
  CONTEXT="$context"
)

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$tmp/${label}.out" 2>"$tmp/${label}.err"; then
    printf 'expected failure: %s\n' "$label" >&2
    exit 1
  fi
}

: >"$log"
expect_failure lambda-multiarch \
  env "${action_env[@]}" IMAGE_KIND=lambda "$publisher"
[[ ! -s "$log" ]] || {
  printf 'lambda multi-architecture rejection happened after docker side effects\n' >&2
  exit 1
}
grep -F 'Lambda images must target exactly one platform' "$tmp/lambda-multiarch.err" >/dev/null

: >"$log"
env "${action_env[@]}" IMAGE_KIND=lambda PLATFORMS=linux/arm64 PUSH=false \
  "$publisher" >"$tmp/lambda-local.out"
grep -F -- '--platform linux/arm64' "$log" >/dev/null
grep -F -- '--load' "$log" >/dev/null
if grep -F -- '--push' "$log" >/dev/null; then
  printf 'local Lambda build unexpectedly pushed\n' >&2
  exit 1
fi
grep -F 'built local image:' "$tmp/lambda-local.out" >/dev/null

: >"$log"
env "${action_env[@]}" IMAGE_KIND=portable PUSH=true "$publisher" \
  >"$tmp/portable-push.out"
grep -F -- '--platform linux/amd64,linux/arm64' "$log" >/dev/null
grep -F -- '--push' "$log" >/dev/null
grep -F 'published image:' "$tmp/portable-push.out" >/dev/null

: >"$log"
expect_failure r2-without-push \
  env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=false \
  R2_ARCHIVE_BUCKET=archive "$publisher"
[[ ! -s "$log" ]] || {
  printf 'R2/PUSH validation happened after docker side effects\n' >&2
  exit 1
}

: >"$log"
expect_failure invalid-build-arg \
  env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=false \
  BUILD_ARG_NAMES='not-valid' "$publisher"
[[ ! -s "$log" ]] || {
  printf 'build-arg validation happened after docker side effects\n' >&2
  exit 1
}

: >"$log"
env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=false \
  BUILD_ARG_NAMES=SERVICE_BIN SERVICE_BIN=example-service "$publisher" \
  >"$tmp/build-arg.out"
grep -F -- '--build-arg SERVICE_BIN=example-service' "$log" >/dev/null

: >"$aws_log"
expect_failure r2-existing \
  env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=true \
  R2_ARCHIVE_BUCKET=archive R2_ENDPOINT=https://example.r2.cloudflarestorage.com \
  AWS_HEAD_MODE=existing "$publisher"
if ! grep -F 'R2 archive object already exists' "$tmp/r2-existing.err" >/dev/null; then
  printf 'R2 existing-object test failed for the wrong reason:\n' >&2
  cat "$tmp/r2-existing.err" >&2
  exit 1
fi
if grep -F ' s3 cp ' "$aws_log" >/dev/null; then
  printf 'existing R2 archive was overwritten\n' >&2
  exit 1
fi

: >"$aws_log"
expect_failure r2-head-error \
  env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=true \
  R2_ARCHIVE_BUCKET=archive R2_ENDPOINT=https://example.r2.cloudflarestorage.com \
  AWS_HEAD_MODE=error "$publisher"
if ! grep -F 'unable to prove R2 archive object is absent' "$tmp/r2-head-error.err" >/dev/null; then
  printf 'R2 inconclusive-check test failed for the wrong reason:\n' >&2
  cat "$tmp/r2-head-error.err" >&2
  exit 1
fi
if grep -F ' s3 cp ' "$aws_log" >/dev/null; then
  printf 'R2 archive uploaded after an inconclusive absence check\n' >&2
  exit 1
fi

: >"$aws_log"
env "${action_env[@]}" PLATFORMS=linux/amd64 PUSH=true \
  R2_ARCHIVE_BUCKET=archive R2_ENDPOINT=https://example.r2.cloudflarestorage.com \
  AWS_HEAD_MODE=missing "$publisher" >"$tmp/r2-archive.out"
[[ "$(grep -c 's3api head-object' "$aws_log")" -eq 2 ]]
[[ "$(grep -c ' s3 cp ' "$aws_log")" -eq 2 ]]
grep -F 'archived OCI image to R2:' "$tmp/r2-archive.out" >/dev/null

printf 'OCI build-and-push contract tests passed\n'
