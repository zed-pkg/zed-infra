# Production 19-package R2 release

The `production-package-r2.yml` workflow is the protected, manual release lane
for DEN-2788. It is intentionally separate from `deploy-zed-cloud.yml`, whose
three Opto Sync fixtures and process-memory artifact store are smoke tests, not
proof of the requested production package batch.

## Immutable inputs

The workflow pins one `zed-pkg-test/zed-pkg-e2e` certification commit, one
`zed-cli` commit, and the registry API contract recorded by the certification
ledger. The ledger contains 19 dependency-closed package coordinates across
`zed-pkg`, `shared-auth`, and `ORESoftware`, including `zed-lib-core` and every
in-set transitive dependency.

## Fail-closed live preconditions

A dispatch selects the existing protected `aws` or `hetzner` environment. The
job refuses to publish unless the live `dd-zed-api-server` Deployment:

- is rolled out in namespace `zed`;
- uses `STORAGE_BACKEND=s3`;
- names bucket `zed-pkg-artifacts` and the reviewed Cloudflare R2 endpoint;
- uses region `auto` and path-style addressing;
- references a non-empty `zed-r2-creds` Secret without exporting its values.

The environment kubeconfig is decoded only into the runner's temporary
filesystem and scrubbed at the end. Signed R2 query strings are never written to
release evidence.

## Required proof

Using the exact pinned `zed` binary, the workflow claims the required package
organizations, fetches every exact repository commit, verifies release tags and
manifests, publishes all 19 packages, retries every publication idempotently,
installs the complete graph, uninstalls it, and restores it with `--frozen`.

For each published package, the R2 verifier requires the registry download route
to return a presigned redirect into the configured bucket. It then downloads the
object directly from R2 and verifies its SHA-256 and byte length against registry
metadata. Success requires 19 unique package coordinates and 19 unique R2 object
paths.

The retained artifact contains the exact source ledger, registry metadata,
artifact hashes, install/frozen-reinstall results, sanitized deployment
contract, and direct R2 object verification.
