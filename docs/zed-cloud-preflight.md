# Zed cloud environment preflight

Run the **zed cloud preflight** workflow before rerunning **deploy zed cloud**.
The preflight is intentionally non-mutating: it validates credentials and access,
but it does not apply Kubernetes resources or publish packages.

For each protected GitHub Environment (`aws` and `hetzner`), it verifies:

- `KUBECONFIG_B64` exists, decodes successfully, selects a current context, and
  points to an HTTPS Kubernetes API;
- the Kubernetes readiness endpoint responds and at least one node is visible;
- `ZED_GHCR_USERNAME` and `ZED_GHCR_TOKEN` can form the namespace-local pull
  secret used by the deployment; and
- the supplied GHCR credential can authenticate without persisting Docker state.

The workflow runs the two cloud checks independently and writes only redacted
status information to the Actions job summary. Kubeconfigs, registry tokens, and
Docker credential files are not uploaded as artifacts.

## Operator sequence

1. In `zed-pkg/zed-infra`, open **Settings → Environments**.
2. Populate the three required secrets in both `aws` and `hetzner`.
3. Manually run **zed cloud preflight**.
4. Resolve any failed cloud independently; a passing cloud does not prove the
   other environment is configured.
5. After both preflight jobs pass, rerun **deploy zed cloud** and require the
   `zed-cloud/aws` and `zed-cloud/hetzner` commit statuses to become green.

A preflight failure is an environment or access failure, not an application
failure. Package publication and frozen-install certification remain the
responsibility of the deployment workflow.
