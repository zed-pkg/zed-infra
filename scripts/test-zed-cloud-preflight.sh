#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/zed-cloud-preflight.sh"

bash -n "$script"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zed-preflight-contract.XXXXXX")"
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

fake_bin="$work/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'config current-context'*) echo 'zed-contract' ;;
  *'config view'*) echo 'https://kubernetes.example.invalid' ;;
  *'get --raw=/readyz'*) echo 'ok' ;;
  *'get nodes -o name'*) printf 'node/one\nnode/two\n' ;;
  *'auth can-i'*)
    if [[ -n "${FAKE_DENY:-}" && "$*" == *"$FAKE_DENY"* ]]; then
      echo 'no'
    else
      echo 'yes'
    fi
    ;;
  *'create secret docker-registry'*) echo 'secret/zed-ghcr' ;;
  *) echo "unexpected kubectl invocation: $*" >&2; exit 90 ;;
esac
SH
cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'login ghcr.io'*) cat >/dev/null ;;
  *'manifest inspect ghcr.io/zed-pkg/zed-api-server:main'*) ;;
  *'manifest inspect ghcr.io/zed-pkg/zed-web-server:main'*) ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 91 ;;
esac
SH
chmod +x "$fake_bin/kubectl" "$fake_bin/docker"

kubeconfig='apiVersion: v1'
export PATH="$fake_bin:$PATH"
export KUBECONFIG="$work/contract.kubeconfig"
export KUBECONFIG_B64="$(printf '%s' "$kubeconfig" | base64 -w0)"
export ZED_GHCR_USERNAME='contract-user'
export ZED_GHCR_TOKEN='contract-token-must-not-leak'
export GITHUB_STEP_SUMMARY="$work/summary.md"
export GITHUB_ACTIONS='true'

bash "$script" aws
grep -q 'Zed cloud preflight: aws' "$GITHUB_STEP_SUMMARY"
grep -q 'Reachable nodes: 2' "$GITHUB_STEP_SUMMARY"
grep -q 'Deployment RBAC checks: 35 passed' "$GITHUB_STEP_SUMMARY"
grep -q '2 image manifests readable' "$GITHUB_STEP_SUMMARY"
! grep -Fq "$ZED_GHCR_TOKEN" "$GITHUB_STEP_SUMMARY"
test ! -e "$KUBECONFIG"

export FAKE_DENY='patch deployments.apps'
if bash "$script" aws 2>"$work/rbac.err"; then
  echo 'preflight unexpectedly accepted denied deployment RBAC' >&2
  exit 1
fi
grep -q 'patch deployments.apps -n zed' "$work/rbac.err"
test ! -e "$KUBECONFIG"
unset FAKE_DENY

unset ZED_GHCR_TOKEN
if bash "$script" hetzner 2>"$work/missing.err"; then
  echo 'preflight unexpectedly accepted a missing secret' >&2
  exit 1
fi
grep -q 'ZED_GHCR_TOKEN' "$work/missing.err"

printf 'zed cloud preflight contract passed\n'
