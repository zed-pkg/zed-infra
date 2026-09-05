# Origin handshake assurance

This is the repository-owned fmctl model for the shared `app`, `user`, and
`web` Workers. It complements the registry/CDN boundary tests; it does not
replace them or prove the whole Zed platform is deployed.

## Production boundary

`workers/shared/origin-transition.js` uses checked finite request/response
variants. `origin-proxy.js` owns effects: one origin request, manual redirects,
bounded setup, and the exact runtime socket handoff. Unsupported upgrades and
non-GET WebSocket requests fail before origin I/O. Only a WebSocket request
with an origin 101 **and** a runtime socket can upgrade. Origin 401/403 and
redirects remain HTTP decisions; failures become cache-disabled unavailable
responses. The existing exact-path maintenance policy is preserved.

The upstream WebSocket handshake rebuilds `Upgrade` and `Connection` after
removing unrelated hop-by-hop headers. Origin, cookie, bearer, key, version,
and subprotocol fields remain for the origin to validate. Successful upgrade
responses are returned unchanged: reconstructing only body/status/headers
would discard the runtime WebSocket.

The WebSocket setup timeout is canceled after fetch settles. It must not
abort a successfully established connection later. Normal HTTP requests
retain their existing timeout policy.

## Run and inspect

Use Node 24.19.0, Java 21, and the pinned Quint 0.32.0 declared by `fm.toml`:

```sh
npm ci --ignore-scripts --prefix workers
npm test --prefix workers
node formal/check.mjs /absolute/path/to/fmctl
```

The Rust `fmctl` runner comes from `ORESoftware/formal-methods.rs`. This slice
was checked against freshly fetched standalone commit
`734a1c3`. CI uses the same public incubator export as the Zed web/API gates:
`opto-sync/opto-sync-clients@c2146ef9f054d24e1488c216547852aa148285cf`,
`tools/fmctl`. This avoids introducing a private-repository credential to PR
workflows. The Node files here are runtime test/adaptor glue for the JavaScript
Worker; orchestration supervision and protocol enforcement remain in Rust.

`formal/check.mjs` runs validation, typechecking, simulation, exhaustive TLC,
trace generation, actual-handler replay, and two negative controls. Generated
evidence stays under ignored `.formal-artifacts/`; CI uploads bounded reports,
traces, and counterexamples, never tool caches or environment files.

## Evidence and limits

- 276 finite initial scenarios, 736 reachable states, complete search depth 3.
- Seven witnessed behaviors: upgrade, pre-origin rejection, preserved denial,
  preserved redirect, transport failure, malformed 101, and entry-route 404.
- All 276 cases also execute the actual Worker handler with a synthetic origin.
- Sixteen generated ITF traces replay through that handler. The adapter checks
  canonical paths, UTF-8, size/count bounds, state shapes, input stability,
  phase progression, action metadata, and all terminal observables.
- A redirect-policy mutant must produce an actual TLC invariant counterexample.
  A mutated terminal observation must produce an actual production replay
  mismatch. Parse failures or timeouts do not count as successful controls.
- Independent real `workerd` tests use TCP clients and a loopback TCP origin
  through each of the three actual Worker modules: text/binary frames,
  subprotocol, Origin/cookie preservation, clean closure, post-deadline
  connection survival, 401/403, manual redirect, disconnect, and stalled setup.

The status set contains finite representatives, not every HTTP status or
RFC6455 input. The model does not prove origin authentication, cryptography,
DNS/edge deployment, frame limits in the Rust services, distributed reconnect,
or multi-connection backpressure. Runtime tests provide concrete evidence for
setup timing and framing; those are not timing theorems from the Quint model.

The test runtime pins Miniflare `5.20260828.0-alpha`, the exact dependency of
the existing Wrangler `4.127.1` deployment pin. Its exported v4-option converter
and explicit source-module inventory are used; outdated single-Worker examples
and implicit module discovery did not work at this revision. No test dependency
is bundled into the production Worker. The locked npm audit is clean at the
time of this change. Separately, the Quint/Apalache JVM toolchain still emits
the upstream protobuf warning tracked by DEN-565; do not suppress it or claim
that the entire verification toolchain is vulnerability-free.

## Production promotion remains separate

Read `docs/cf-deploy-leases.md` before any upload. Preserve the live snapshot,
If-Match, KV lease, route scope, and normal review gates.

Read-only checks on 2026-09-05 found that Cloudflare deployment run
`33580875927` failed for a missing `CLOUDFLARE_WORKERS_DEPLOY_TOKEN`; the current
repository secret-name inventory was empty. Local Wrangler could read the
August 30 app deployment, but reported missing KV and route scopes needed by
the lease path. The `dd-codex` AWS profile returned `ExpiredToken`.

No credentials were changed and no production upload, DNS mutation, or cluster
apply was performed. These facts do not prove the deployed origin's root cause.
Reconcile runtime origin/image/routing with valid approved credentials, then
verify actual Shared Auth return paths and auth/API/DB onboarding before
enabling marketing's hosted-account flag. Track this with DEN-3970 and
`zed-pkg/.github#61`; source merge and successful deployment are different
acceptance conditions.
