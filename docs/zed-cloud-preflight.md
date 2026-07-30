# Zed cloud environment preflight

Run the **zed cloud preflight** workflow before rerunning **deploy zed cloud**.
The preflight is intentionally non-mutating: it validates credentials and access,
but it does not apply Kubernetes resources or publish packages.

For each protected GitHub Environment (`aws` and `hetzner`), it verifies:

- `KUBECONFIG_B64` exists, decodes successfully, selects a current context, and
  points to an HTTPS Kubernetes API;
- the Kubernetes readiness endpoint responds and at least one node is visible;
- the identity has every capability class used by deployment and certification,
  including namespace/apply operations, Deployments, Services, Ingresses,
  NetworkPolicies, Secrets, temporary Pods, exec, port-forward, and the Argo CD
  `AppProject`;
- `ZED_GHCR_USERNAME` and `ZED_GHCR_TOKEN` can form the namespace-local pull
  secret used by the deployment;
- the supplied GHCR credential can authenticate in an isolated Docker config;
  and
- that credential can read the manifests for both the API and web images, rather
  than merely authenticating to GHCR without package access.

The workflow runs the two cloud checks independently and writes only redacted
status information to the Actions job summary. Its temporary kubeconfig and
Docker credential directory are deleted on every exit path and are never
uploaded as artifacts.

## Operator sequence

1. In `zed-pkg/zed-infra`, open **Settings → Environments**.
2. Populate the three required secrets in both `aws` and `hetzner`.
3. Manually run **zed cloud preflight**.
4. Resolve any failed cloud independently. A passing cloud does not prove the
   other environment is configured.
5. Treat an RBAC failure as a least-privilege policy gap; add only the reported
   capability rather than replacing the kubeconfig with unrestricted credentials.
6. After both preflight jobs pass, rerun **deploy zed cloud** and require the
   `zed-cloud/aws` and `zed-cloud/hetzner` commit statuses to become green.

A preflight failure is an environment, access, or image-availability failure—not
an application-runtime failure. Package publication and frozen-install
certification remain the responsibility of the deployment workflow.
