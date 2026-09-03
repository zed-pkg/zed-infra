#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: promote-oci-image.sh SOURCE@sha256:DIGEST DESTINATION:TAG portable
       promote-oci-image.sh SOURCE@sha256:DIGEST DESTINATION:TAG lambda ARCH

ARCH must be amd64 or arm64. Authentication must already be configured with
OIDC/workload identity or a credential helper. This script never accepts secrets.
Set PROMOTE_OCI_DRY_RUN=1 to print the copy command without touching a registry.
USAGE
  exit 64
}

[[ $# -ge 3 && $# -le 4 ]] || usage
source_ref=$1
destination_ref=$2
mode=$3
arch=${4:-}

if [[ ! $source_ref =~ @sha256:([0-9a-f]{64})$ ]]; then
  printf 'error: source must be pinned to @sha256:<64 lowercase hex>\n' >&2
  exit 65
fi
source_digest="sha256:${BASH_REMATCH[1]}"

if [[ $destination_ref == *@* || ${destination_ref##*/} != *:* ]]; then
  printf 'error: destination must be an explicit tag, not a digest or implicit latest\n' >&2
  exit 65
fi

copy_args=(copy --preserve-digests)
case $mode in
  portable)
    [[ -z $arch ]] || usage
    copy_args+=(--all)
    ;;
  lambda)
    [[ $arch == amd64 || $arch == arm64 ]] || {
      printf 'error: Lambda architecture must be amd64 or arm64\n' >&2
      exit 65
    }
    copy_args+=(--override-os linux --override-arch "$arch")
    ;;
  *)
    usage
    ;;
esac
copy_args+=("docker://$source_ref" "docker://$destination_ref")

printf 'source=%q mode=%q destination=%q\n' "$source_ref" "$mode" "$destination_ref"
if [[ ${PROMOTE_OCI_DRY_RUN:-0} == 1 ]]; then
  printf 'dry-run:'
  printf ' %q' skopeo "${copy_args[@]}"
  printf '\n'
  exit 0
fi

command -v skopeo >/dev/null 2>&1 || {
  printf 'error: skopeo is required\n' >&2
  exit 69
}
command -v python3 >/dev/null 2>&1 || {
  printf 'error: python3 is required for manifest verification\n' >&2
  exit 69
}

skopeo "${copy_args[@]}"

destination_digest=$(skopeo inspect --format '{{.Digest}}' "docker://$destination_ref")
[[ $destination_digest =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'error: destination did not return a canonical sha256 digest\n' >&2
  exit 70
}

if [[ $mode == portable ]]; then
  [[ $destination_digest == "$source_digest" ]] || {
    printf 'error: digest drift: source=%s destination=%s\n' "$source_digest" "$destination_digest" >&2
    exit 70
  }
else
  read -r destination_os destination_arch < <(
    skopeo inspect --format '{{.Os}} {{.Architecture}}' "docker://$destination_ref"
  )
  [[ $destination_os == linux && $destination_arch == "$arch" ]] || {
    printf 'error: Lambda destination is %s/%s, expected linux/%s\n' \
      "$destination_os" "$destination_arch" "$arch" >&2
    exit 70
  }

  skopeo inspect --raw "docker://$destination_ref" | python3 -c '
import json, sys
manifest = json.load(sys.stdin)
if "manifests" in manifest:
    raise SystemExit("error: Lambda destination is still a multi-architecture index")
'
fi

printf 'verified_destination=%s@%s\n' "${destination_ref%:*}" "$destination_digest"
