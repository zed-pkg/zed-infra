# Authenticated edge fallback capability v1

Status: implementation slice for zed-infra issue #74. This document defines the
Cloudflare-side trust boundary. The canonical cross-service wire contract should
be promoted into `zed-interfaces` before production issuance is enabled.

## Problem

The existing zpkg.net edge fallback is intentionally anonymous and public-only.
That is safe during an origin outage, but it cannot serve a package that the
authenticated user is allowed to read from a private GitHub repository, private
npm scope, or private Cargo registry.

The edge must not solve that problem by forwarding a user's browser
`Authorization` header, SSH private key, GitHub PAT, npm token, or other
long-lived credential to third-party hosts.

## Capability shape

Shared Auth / zed-api-server will issue a compact RS256 JWT with:

- `zed_edge_capability = 1`
- exact issuer
- audience `zed-edge-fallback`
- authenticated subject
- `iat`, optional-equivalent `nbf`, `exp`
- unique `jti`
- one or more exact read grants

A v1 capability lives for at most five minutes. The Cloudflare verifier receives
a pinned/cached JWKS snapshot from deployment configuration and performs no
network I/O while verifying the JWT. An already-issued token can therefore be
verified while both zed-api-server and Shared Auth are unavailable.

Example payload:

```json
{
  "zed_edge_capability": 1,
  "iss": "https://auth.zpkg.net",
  "aud": "zed-edge-fallback",
  "sub": "user:123",
  "iat": 1780000000,
  "nbf": 1780000000,
  "exp": 1780000300,
  "jti": "fallback-01K...",
  "grants": [
    {
      "provider": "github",
      "operation": "read",
      "package": "acme/private-lib",
      "resource": "acme/private-lib",
      "credential_ref": "github-app:zed-pkg:installation-42"
    }
  ]
}
```

`credential_ref` is an opaque broker lookup identity, **not a credential**.
The v1 grant schema rejects extra fields, which prevents a token, password,
authorization header, SSH key, or other unversioned secret from being smuggled
inside a grant.

## Provider boundaries

### GitHub

The grant resource is one exact `owner/repo`. The request planner permits only:

- `https://api.github.com/repos/<owner>/<repo>/...`
- `https://github.com/<owner>/<repo>/...`
- `https://raw.githubusercontent.com/<owner>/<repo>/...`

The broker should normally exchange a GitHub App installation identity for a
short-lived installation token. A human PAT is not the target design.

### npm

Private npm fallback requires one exact scoped package such as
`@acme/private-js`. The planner permits only `registry.npmjs.org` paths below
that exact package.

The broker may obtain a scoped read credential. It must never reuse an incoming
browser bearer token as the npm credential.

### private Cargo registry

crates.io is public-only and is not modeled as a private-registry authority.
A private Cargo grant contains one crate name plus one exact credential-free
HTTPS registry origin. The request planner refuses every other origin.

Authenticated private Git sources belong to the GitHub/Git provider family,
not to the crates.io public fallback path.

## Cache policy

Every authenticated provider plan returns `private-no-store`. Production
wiring must preserve that property on metadata, redirects, errors, and bytes.
Authenticated fallback may not populate Cloudflare shared cache.

## Deliberately not enabled yet

The code in `workers/shared/edge-capability.js` is not imported by the live
registry Worker yet. Before enabling it:

1. promote the canonical capability schema into `zed-interfaces`;
2. implement the issuer endpoint in Shared Auth / zed-api-server;
3. implement provider credential brokers;
4. add revocation/key-rotation operational policy;
5. add the full outage matrix to `zed-e2e`;
6. prove private responses are never shared-cacheable;
7. deploy behind an explicit feature flag and negative-control canary.

This ordering keeps the existing anonymous public fallback behavior unchanged
while the authenticated trust path is being built.
