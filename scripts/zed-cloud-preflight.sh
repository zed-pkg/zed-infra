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

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  printf '::add-mask::%s\n' "$ZED_GHCR_TOKEN"
fi

kubeconfig="${KUBECONFIG:-${RUNNER_TEMP:-/tmp}/zed-${cloud}.kubeconfig}"
if [[ -e "$kubeconfig" && "${ZED_PREFLIGHT_ALLOW_KUBECONFIG_OVERWRITE:-0}" != 1 ]]; then
  echo "refusing to overwrite existing kubeconfig: $kubeconfig" >&2
  exit 3
fi

mkdir -p "$(dirname "$kubeconfig")"
temporary_kubeconfig="${kubeconfig}.tmp.$$"
docker_config=''
cleanup() {
  rm -f "$temporary_kubeconfig"
  if [[ "${ZED_PREFLIGHT_KEEP_KUBECONFIG:-0}" != 1 ]]; then
    rm -f "$kubeconfig"
  fi
  if [[ -n "$docker_config" ]]; then
    rm -rf "$docker_config"
  fi
}
trap cleanup EXIT HUP INT TERM

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

kubectl_cmd=(kubectl --kubeconfig "$kubeconfig" --request-timeout=20s)
context="$("${kubectl_cmd[@]}" config current-context)"
if [[ -z "$context" ]]; then
  echo "kubeconfig for $cloud has no current context" >&2
  exit 4
fi
server="$("${kubectl_cmd[@]}" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$server" != https://* ]]; then
  echo "kubeconfig for $cloud does not target an HTTPS Kubernetes API" >&2
  exit 4
fi

"${kubectl_cmd[@]}" get --raw=/readyz >/dev/null
nodes="$("${kubectl_cmd[@]}" get nodes -o name)"
if [[ -z "$nodes" ]]; then
  echo "cluster $cloud is reachable but returned no nodes" >&2
  exit 5
fi
node_count="$(printf '%s\n' "$nodes" | sed '/^$/d' | wc -l | tr -d ' ')"

rbac_checks=(
  'get|nodes|'
  'get|namespaces|'
  'create|namespaces|'
  'patch|namespaces|'
  'get|resourcequotas|zed'
  'create|resourcequotas|zed'
  'patch|resourcequotas|zed'
  'get|limitranges|zed'
  'create|limitranges|zed'
  'patch|limitranges|zed'
  'get|secrets|zed'
  'create|secrets|zed'
  'patch|secrets|zed'
  'get|services|zed'
  'create|services|zed'
  'patch|services|zed'
  'get|deployments.apps|zed'
  'create|deployments.apps|zed'
  'patch|deployments.apps|zed'
  'get|networkpolicies.networking.k8s.io|zed'
  'create|networkpolicies.networking.k8s.io|zed'
  'patch|networkpolicies.networking.k8s.io|zed'
  'get|ingresses.networking.k8s.io|zed'
  'create|ingresses.networking.k8s.io|zed'
  'patch|ingresses.networking.k8s.io|zed'
  'get|pods|zed'
  'list|pods|zed'
  'watch|pods|zed'
  'create|pods|zed'
  'delete|pods|zed'
  'create|pods/exec|zed'
  'create|pods/portforward|zed'
  'get|appprojects.argoproj.io|argocd'
  'create|appprojects.argoproj.io|argocd'
  'patch|appprojects.argoproj.io|argocd'
)

denied=()
for check in "${rbac_checks[@]}"; do
  IFS='|' read -r verb resource namespace <<<"$check"
  args=(auth can-i "$verb" "$resource")
  if [[ -n "$namespace" ]]; then
    args+=(-n "$namespace")
  fi
  answer="$("${kubectl_cmd[@]}" "${args[@]}" 2>/dev/null || true)"
  if [[ "$answer" != yes ]]; then
    if [[ -n "$namespace" ]]; then
      denied+=("$verb $resource -n $namespace")
    else
      denied+=("$verb $resource")
    fi
  fi
done
if ((${#denied[@]})); then
  printf 'kubeconfig for %s lacks required deployment permission(s):\n' "$cloud" >&2
  printf '  - %s\n' "${denied[@]}" >&2
  exit 6
fi

"${kubectl_cmd[@]}" -n zed create secret docker-registry zed-ghcr \
  --docker-server=ghcr.io \
  --docker-username="$ZED_GHCR_USERNAME" \
  --docker-password="$ZED_GHCR_TOKEN" \
  --docker-email=zed-cloud@users.noreply.github.com \
  --dry-run=client -o name >/dev/null

registry_status='syntax-only'
verified_images=0
if [[ "${ZED_PREFLIGHT_SKIP_GHCR_LOGIN:-0}" != 1 ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo 'docker is required to verify the GHCR credential' >&2
    exit 7
  }
  docker_config="$(mktemp -d)"
  if ! printf '%s' "$ZED_GHCR_TOKEN" | \
    DOCKER_CONFIG="$docker_config" docker login ghcr.io \
      --username "$ZED_GHCR_USERNAME" --password-stdin >/dev/null 2>&1; then
    echo "GHCR login failed for the $cloud environment credential" >&2
    exit 7
  fi

  images=(
    "${ZED_API_IMAGE:-ghcr.io/zed-pkg/zed-api-server:main}"
    "${ZED_WEB_IMAGE:-ghcr.io/zed-pkg/zed-web-server:main}"
  )
  for image in "${images[@]}"; do
    if ! DOCKER_CONFIG="$docker_config" docker manifest inspect "$image" >/dev/null 2>&1; then
      echo "GHCR credential for $cloud cannot pull manifest: $image" >&2
      exit 7
    fi
    verified_images=$((verified_images + 1))
  done
  registry_status="authenticated; ${verified_images} image manifests readable"
fi

summary="${GITHUB_STEP_SUMMARY:-}"
if [[ -n "$summary" ]]; then
  {
    echo "### Zed cloud preflight: $cloud"
    echo
    echo "- Kubernetes context: \`$context\`"
    echo "- Kubernetes API: HTTPS and ready"
    echo "- Reachable nodes: $node_count"
    echo "- Deployment RBAC checks: ${#rbac_checks[@]} passed"
    echo "- GHCR credential: $registry_status"
  } >> "$summary"
fi

printf 'zed cloud preflight passed: cloud=%s context=%s nodes=%s rbac=%s ghcr=%s\n' \
  "$cloud" "$context" "$node_count" "${#rbac_checks[@]}" "$registry_status"
