# Provider credential broker v1

This contract is the private-source credential boundary for authenticated Zed
edge fallback. It is intentionally separate from the capability verifier.

## Trust sequence

1. Shared Auth proves the principal/session lineage.
2. Zed authorizes the exact package and source and issues a short-lived edge
   capability.
3. The Worker verifies that capability offline and derives a secret-free
   provider request plan.
4. Only then may the Worker call the internal credential broker with:
   provider, exact resource, package coordinate, credential_ref, canonical
   principal/session lineage, capability id, and a bounded TTL.
5. The broker returns one provider-typed short-lived credential with
   `Cache-Control: no-store`.

The broker request never accepts or forwards the caller's Authorization header,
SSH private key, GitHub PAT, npm token, Cargo token, password, or cookie.

## GitHub v1

The first enabled provider is GitHub App installation credentials.

The response must bind:
- `provider = github`;
- `kind = github-app-installation`;
- the exact `owner/repo`;
- the exact `credential_ref`;
- the exact capability id that authorized the broker request;
- a fresh issuance timestamp and a lifetime no longer than the request/capability lifetime;
- read-only `contents` and optional read-only `metadata` permissions.

Unknown response fields fail closed so a future secret-bearing field cannot be
silently accepted.

npm and alternate Cargo-registry implementations should use the same broker
request envelope but require distinct provider-specific response validators.
They are deliberately not enabled by the GitHub implementation.

## Integration gate

This module is not wired into the public fallback state machine yet. Live
private fallback still requires the edge capability verifier, Zed ACL/issuer
integration, service binding configuration, outage/revocation/key-rotation E2E
coverage, and provider-specific destination confinement.


## Replay and destination hardening

The edge rejects broker credentials issued outside a 30-second freshness window,
responses bound to another capability id, inverted lifetimes, alternate ports
for fixed GitHub/npm origins, and encoded dot/path-separator segments that
could be normalized outside the authorized repository. JWT headers are
closed-world: only `alg`, `typ`, and `kid` are accepted.


## Capability v2 lineage gate

Live broker-backed private fallback requires `EdgeFallbackCapabilityV2`.
The Worker derives broker identity only from the verified capability:

- `sub` -> canonical principal;
- `sid` -> Shared Auth session lineage;
- `parent_jti` -> delegated parent-token lineage;
- `jti` -> edge capability id;
- `exp` -> absolute credential lifetime ceiling.

V1 remains readable for compatibility but cannot enter the credential-broker
path because it lacks `sid` and `parent_jti`. These identifiers are distinct
and must never be substituted for one another.


## V3 capability downgrade fence

Broker protocol v1 does not carry the v3 assurance, session epoch, policy epoch,
or revocation-checkpoint provenance. The client therefore rejects a v3 broker
context before any broker I/O instead of silently stripping those fields and
requesting a v1 credential.

Enabling broker-backed v3 fallback requires a separately versioned broker
protocol whose request and response both bind the complete v3 provenance and
whose broker-side authorization enforces the same local epoch/freshness policy.
Until that protocol exists, v2 remains the newest capability admitted to the
v1 credential-broker path.
