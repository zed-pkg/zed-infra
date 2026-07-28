#!/usr/bin/env bash
set -euo pipefail

cloud="${1:-${ZED_CLOUD:-}}"
case "$cloud" in
  aws|hetzner) ;;
  *)
    echo "usage: $0 <aws|hetzner>" >&2
    exit 64
    ;;
esac

required=(KUBECONFIG_B64 ZED_GHCR_USERNAME ZED_GHCR_TOKEN)
missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if ((${#missing[@]})); then
  printf 'missing required GitHub Environment secret(s) for %s: %s\n' \
    "$cloud" "${missing[*]}" >&2
  exit 2
fi

kubeconfig="${KUBECONFIG:-${RUNNER_TEMP:-/tmp}/zed-${cloud}.kubeconfig}"
mkdir -p "$(dirname "$kubeconfig")"
temporary_kubeconfig="${kubeconfig}.tmp.$$"
docker_config=''
cleanup() {
  rm -f "$temporary_kubeconfig"
  if [[ -n "$docker_config" ]]; then
    rm -rf "$docker_config"
  fi
}
trap cleanup EXIT

if ! printf '%s' "$KUBECONFIG_B64" | base64 --decode > "$temporary_kubeconfig" 2>/dev/null; then
  echo "KUBECONFIG_B64 for $cloud is not valid base64" >&2
  exit 3
fi
if [[ ! -s "$temporary_kubeconfig" ]]; then
  echo "decoded kubeconfig for $cloud is empty" >&2
  exit 3
fi
chmod 600 "$temporary_kubeconfig"
mv "$temporary_kubeconfig" "$kubeconfig"
export KUBECONFIG="$kubeconfig"

context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ -z "$context" ]]; then
  echo "kubeconfig for $cloud has no current context" >&2
  exit 4
fi
server="$(kubectl --kubeconfig "$kubeconfig" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$server" != https://* ]]; then
  echo "kubeconfig for $cloud does not target an HTTPS Kubernetes API" >&2
  exit 4
fi

kubectl --kubeconfig "$kubeconfig" --request-timeout=20s get --raw=/readyz >/dev/null
nodes="$(kubectl --kubeconfig "$kubeconfig" --request-timeout=20s get nodes -o name)"
if [[ -z "$nodes" ]]; then
  echo "cluster $cloud is reachable but returned no nodes" >&2
  exit 5
fi
node_count="$(printf '%s\n' "$nodes" | sed '/^$/d' | wc -l | tr -d ' ')"

kubectl --kubeconfig "$kubeconfig" -n zed create secret docker-registry zed-ghcr \
  --docker-server=ghcr.io \
  --docker-username="$ZED_GHCR_USERNAME" \
  --docker-password="$ZED_GHCR_TOKEN" \
  --docker-email=zed-cloud@users.noreply.github.com \
  --dry-run=client -o name >/dev/null

registry_status='syntax-only'
if [[ "${ZED_PREFLIGHT_SKIP_GHCR_LOGIN:-0}" != 1 ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo 'docker is required to verify the GHCR credential' >&2
    exit 6
  }
  docker_config="$(mktemp -d)"
  if ! printf '%s' "$ZED_GHCR_TOKEN" | \
    DOCKER_CONFIG="$docker_config" docker login ghcr.io \
      --username "$ZED_GHCR_USERNAME" --password-stdin >/dev/null 2>&1; then
    echo "GHCR login failed for the $cloud environment credential" >&2
    exit 6
  fi
  registry_status='authenticated'
fi

summary="${GITHUB_STEP_SUMMARY:-}"
if [[ -n "$summary" ]]; then
  {
    echo "### Zed cloud preflight: $cloud"
    echo
    echo "- Kubernetes context: \`$context\`"
    echo "- Kubernetes API: HTTPS and ready"
    echo "- Reachable nodes: $node_count"
    echo "- GHCR credential: $registry_status"
  } >> "$summary"
fi

printf 'zed cloud preflight passed: cloud=%s context=%s nodes=%s ghcr=%s\n' \
  "$cloud" "$context" "$node_count" "$registry_status"
