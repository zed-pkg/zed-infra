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
- a lifetime no longer than the request/capability lifetime;
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
