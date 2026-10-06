import assert from "node:assert/strict";
import { before, test } from "node:test";

import {
  EdgeCapabilityError,
  brokerContextFromCapability,
  planProviderRequest,
  verifyEdgeCapability,
} from "./edge-capability.js";

const NOW = 2_000_000_000;
const ISSUER = "https://auth.zpkg.net";

let privateKey;
let publicJwk;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "test-key-0001";
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
});

function baseClaims(overrides = {}) {
  return {
    zed_edge_capability: 1,
    iss: ISSUER,
    aud: "zed-edge-fallback",
    sub: "user:test",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 120,
    jti: "capability-0001",
    grants: [
      {
        provider: "github",
        operation: "read",
        package: "acme/private-lib",
        resource: "acme/private-lib",
        credential_ref: "github-app:zed-pkg:installation-42",
      },
    ],
    ...overrides,
  };
}

async function sign(claims, headerOverrides = {}) {
  const header = {
    typ: "JWT",
    alg: "ES256",
    kid: "test-key-0001",
    ...headerOverrides,
  };
  const head = base64url(JSON.stringify(header));
  const body = base64url(JSON.stringify(claims));
  const bytes = new TextEncoder().encode(`${head}.${body}`);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes);
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

function base64url(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jwks() {
  return { keys: [publicJwk] };
}

async function verify(claims = baseClaims()) {
  return verifyEdgeCapability(await sign(claims), {
    issuer: ISSUER,
    jwks: jwks(),
    nowEpochSeconds: NOW,
  });
}

function v3Claims(overrides = {}) {
  return baseClaims({
    zed_edge_capability: 3,
    sid: "session:abc-123",
    parent_jti: "parent-token-0001",
    assurance: 2,
    session_epoch: 7,
    policy_epoch: 4,
    revocation_checked_at: NOW - 20,
    ...overrides,
  });
}

function outage(overrides = {}) {
  return {
    startedAtEpochSeconds: NOW - 30,
    jwksRefreshedAtEpochSeconds: NOW - 25,
    minimumAssurance: 2,
    minimumSessionEpoch: 7,
    minimumPolicyEpoch: 4,
    maxCapabilityAgeSeconds: 60,
    maxRevocationAgeSeconds: 60,
    maxJwksAgeSeconds: 60,
    maxOutageSeconds: 60,
    ...overrides,
  };
}

async function verifyV3(claims = v3Claims(), outagePolicy = outage()) {
  return verifyEdgeCapability(await sign(claims), {
    issuer: ISSUER,
    jwks: jwks(),
    nowEpochSeconds: NOW,
    outage: outagePolicy,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EdgeCapabilityError);
    assert.equal(error.code, code);
    return true;
  });
}

test("verifies a short-lived ES256 capability from a pinned JWKS snapshot", async () => {
  const claims = await verify();
  assert.equal(claims.sub, "user:test");
  assert.equal(claims.grants.length, 1);
  assert.equal(claims.grants[0].credential_ref, "github-app:zed-pkg:installation-42");
});

test("rejects wrong audience, expiry, unknown kid, and unsupported algorithms", async () => {
  await expectCode(verify(baseClaims({ aud: "zed-api" })), "invalid_audience");
  await expectCode(
    verify(baseClaims({ iat: NOW - 200, nbf: NOW - 200, exp: NOW - 100 })),
    "expired",
  );

  await expectCode(
    verifyEdgeCapability(await sign(baseClaims(), { kid: "unknown-key-1" }), {
      issuer: ISSUER,
      jwks: jwks(),
      nowEpochSeconds: NOW,
    }),
    "unknown_kid",
  );

  await expectCode(
    verifyEdgeCapability(await sign(baseClaims(), { alg: "RS256" }), {
      issuer: ISSUER,
      jwks: jwks(),
      nowEpochSeconds: NOW,
    }),
    "unsupported_algorithm",
  );
});

test("rejects overlong lifetimes and any write grant", async () => {
  await expectCode(
    verify(baseClaims({ iat: NOW - 10, exp: NOW + 600 })),
    "invalid_lifetime",
  );
  await expectCode(
    verify(
      baseClaims({
        grants: [
          {
            provider: "github",
            operation: "write",
            package: "acme/private-lib",
            resource: "acme/private-lib",
            credential_ref: "github-app:zed-pkg:installation-42",
          },
        ],
      }),
    ),
    "invalid_operation",
  );
});

test("rejects secret-bearing or otherwise unversioned grant fields", async () => {
  await expectCode(
    verify(
      baseClaims({
        grants: [
          {
            provider: "github",
            operation: "read",
            package: "acme/private-lib",
            resource: "acme/private-lib",
            credential_ref: "github-app:zed-pkg:installation-42",
            token: "must-never-be-in-the-capability",
          },
        ],
      }),
    ),
    "unknown_field",
  );
});

test("plans only an exact GitHub repository destination and never forwards user auth", async () => {
  const claims = await verify();
  const plan = planProviderRequest(claims, {
    provider: "github",
    package: "acme/private-lib",
    resource: "acme/private-lib",
    url: "https://api.github.com/repos/acme/private-lib/releases/tags/v1.0.0",
  });
  assert.deepEqual(plan, {
    provider: "github",
    operation: "read",
    package: "acme/private-lib",
    resource: "acme/private-lib",
    url: "https://api.github.com/repos/acme/private-lib/releases/tags/v1.0.0",
    credentialRef: "github-app:zed-pkg:installation-42",
    cachePolicy: "private-no-store",
    forwardUserAuthorization: false,
  });

  assert.throws(
    () =>
      planProviderRequest(claims, {
        provider: "github",
        package: "acme/private-lib",
        resource: "acme/private-lib",
        url: "https://api.github.com/repos/acme/other-private-lib/releases",
      }),
    (error) => error instanceof EdgeCapabilityError && error.code === "provider_destination_mismatch",
  );
  assert.throws(
    () =>
      planProviderRequest(claims, {
        provider: "github",
        package: "acme/private-lib",
        resource: "acme/private-lib",
        url: "https://evil.example/repos/acme/private-lib",
      }),
    (error) => error instanceof EdgeCapabilityError && error.code === "provider_destination_mismatch",
  );
});

test("npm grants are scoped to one private package on registry.npmjs.org", async () => {
  const claims = await verify(
    baseClaims({
      grants: [
        {
          provider: "npm",
          operation: "read",
          package: "acme/private-js",
          resource: "@acme/private-js",
          credential_ref: "npm:scope:acme",
        },
      ],
    }),
  );

  const plan = planProviderRequest(claims, {
    provider: "npm",
    package: "acme/private-js",
    resource: "@acme/private-js",
    url: "https://registry.npmjs.org/@acme%2Fprivate-js",
  });
  assert.equal(plan.credentialRef, "npm:scope:acme");
  assert.equal(plan.cachePolicy, "private-no-store");

  assert.throws(
    () =>
      planProviderRequest(claims, {
        provider: "npm",
        package: "acme/private-js",
        resource: "@acme/private-js",
        url: "https://registry.npmjs.org/@other/private-js",
      }),
    (error) => error instanceof EdgeCapabilityError && error.code === "provider_destination_mismatch",
  );
});

test("private Cargo grants require an exact credential-free HTTPS registry origin", async () => {
  const claims = await verify(
    baseClaims({
      grants: [
        {
          provider: "cargo-registry",
          operation: "read",
          package: "acme/private-rust",
          resource: "private_rust",
          origin: "https://cargo.acme.example",
          credential_ref: "cargo-registry:acme",
        },
      ],
    }),
  );

  const plan = planProviderRequest(claims, {
    provider: "cargo-registry",
    package: "acme/private-rust",
    resource: "private_rust",
    url: "https://cargo.acme.example/api/v1/crates/private_rust/1.2.3/download",
  });
  assert.equal(plan.credentialRef, "cargo-registry:acme");

  assert.throws(
    () =>
      planProviderRequest(claims, {
        provider: "cargo-registry",
        package: "acme/private-rust",
        resource: "private_rust",
        url: "https://mirror.evil.example/api/v1/crates/private_rust/1.2.3/download",
      }),
    (error) => error instanceof EdgeCapabilityError && error.code === "provider_destination_mismatch",
  );
});

test("provider, package, and resource must all match one grant", async () => {
  const claims = await verify();
  assert.throws(
    () =>
      planProviderRequest(claims, {
        provider: "github",
        package: "acme/other-package",
        resource: "acme/private-lib",
        url: "https://api.github.com/repos/acme/private-lib",
      }),
    (error) => error instanceof EdgeCapabilityError && error.code === "grant_mismatch",
  );
});

test("rejects unversioned JWT header fields and inconsistent temporal ordering", async () => {
  await expectCode(
    verifyEdgeCapability(await sign(baseClaims(), { crit: ["future-extension"] }), {
      issuer: ISSUER,
      jwks: jwks(),
      nowEpochSeconds: NOW,
    }),
    "unknown_field",
  );

  await expectCode(
    verify(baseClaims({ iat: NOW - 10, nbf: NOW + 20, exp: NOW + 10 })),
    "invalid_lifetime",
  );
  await expectCode(
    verify(baseClaims({ iat: NOW - 10, nbf: NOW - 20, exp: NOW + 20 })),
    "invalid_lifetime",
  );
});

test("fixed provider destinations reject alternate ports and path-escape encodings", async () => {
  const githubClaims = await verify();
  for (const url of [
    "https://api.github.com:444/repos/acme/private-lib/releases",
    "https://api.github.com/repos/acme/private-lib/%2e%2e/other",
    "https://api.github.com/repos/acme/private-lib/foo%2f..%2fother",
  ]) {
    assert.throws(
      () =>
        planProviderRequest(githubClaims, {
          provider: "github",
          package: "acme/private-lib",
          resource: "acme/private-lib",
          url,
        }),
      (error) =>
        error instanceof EdgeCapabilityError &&
        error.code === "provider_destination_mismatch",
    );
  }

  const npmClaims = await verify(
    baseClaims({
      grants: [
        {
          provider: "npm",
          operation: "read",
          package: "acme/private-js",
          resource: "@acme/private-js",
          credential_ref: "npm:scope:acme",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      planProviderRequest(npmClaims, {
        provider: "npm",
        package: "acme/private-js",
        resource: "@acme/private-js",
        url: "https://registry.npmjs.org:444/@acme%2Fprivate-js",
      }),
    (error) =>
      error instanceof EdgeCapabilityError &&
      error.code === "provider_destination_mismatch",
  );
});

test("v2 preserves signed Shared Auth lineage and derives broker context", async () => {
  const claims = await verify(
    baseClaims({
      zed_edge_capability: 2,
      sid: "session:abc-123",
      parent_jti: "parent-token-0001",
    }),
  );
  assert.equal(claims.zed_edge_capability, 2);
  assert.equal(claims.sid, "session:abc-123");
  assert.equal(claims.parent_jti, "parent-token-0001");
  assert.deepEqual(brokerContextFromCapability(claims), {
    principal: "user:test",
    sessionLineage: "session:abc-123",
    parentJti: "parent-token-0001",
    capabilityId: "capability-0001",
    capabilityExpiresAt: NOW + 120,
  });
});

test("broker context fails closed for v1 or malformed v2 lineage", async () => {
  const v1 = await verify();
  assert.throws(
    () => brokerContextFromCapability(v1),
    (error) => error instanceof EdgeCapabilityError && error.code === "lineage_required",
  );

  await expectCode(
    verify(
      baseClaims({
        zed_edge_capability: 2,
        sid: "session:abc-123",
      }),
    ),
    "invalid_lineage",
  );
  await expectCode(
    verify(
      baseClaims({
        zed_edge_capability: 2,
        sid: "session:abc-123",
        parent_jti: "parent token with spaces",
      }),
    ),
    "invalid_lineage",
  );
});

test("v1 remains closed-world and cannot smuggle v2 lineage fields", async () => {
  await expectCode(
    verify(
      baseClaims({
        sid: "session:abc-123",
        parent_jti: "parent-token-0001",
      }),
    ),
    "unknown_field",
  );
});


test("v3 requires bounded verifier-local outage admission and preserves signed provenance", async () => {
  const claims = await verifyV3();
  assert.equal(claims.zed_edge_capability, 3);
  assert.equal(claims.assurance, 2);
  assert.equal(claims.session_epoch, 7);
  assert.equal(claims.policy_epoch, 4);
  assert.equal(claims.revocation_checked_at, NOW - 20);
  assert.deepEqual(brokerContextFromCapability(claims), {
    principal: "user:test",
    sessionLineage: "session:abc-123",
    parentJti: "parent-token-0001",
    capabilityId: "capability-0001",
    capabilityExpiresAt: NOW + 120,
    assurance: 2,
    sessionEpoch: 7,
    policyEpoch: 4,
    revocationCheckedAt: NOW - 20,
  });

  const plan = planProviderRequest(claims, {
    provider: "github",
    package: "acme/private-lib",
    resource: "acme/private-lib",
    url: "https://api.github.com/repos/acme/private-lib/releases",
  });
  assert.equal(plan.credentialRef, "github-app:zed-pkg:installation-42");
});

test("v3 is inert without trusted outage context", async () => {
  await expectCode(
    verifyEdgeCapability(await sign(v3Claims()), {
      issuer: ISSUER,
      jwks: jwks(),
      nowEpochSeconds: NOW,
    }),
    "outage_context_required",
  );
});

test("v3 fails closed on assurance, epochs, nbf, revocation, JWKS, capability, and outage staleness", async () => {
  const cases = [
    [v3Claims({ assurance: 1 }), outage(), "outage_policy_rejected"],
    [v3Claims({ session_epoch: 6 }), outage(), "outage_policy_rejected"],
    [v3Claims({ policy_epoch: 3 }), outage(), "outage_policy_rejected"],
    [v3Claims({ nbf: NOW + 1 }), outage(), "outage_policy_rejected"],
    [v3Claims({ revocation_checked_at: NOW - 120 }), outage(), "outage_policy_rejected"],
    [v3Claims(), outage({ jwksRefreshedAtEpochSeconds: NOW - 120 }), "outage_policy_rejected"],
    [
      v3Claims({ iat: NOW - 120, nbf: NOW - 120, revocation_checked_at: NOW - 125 }),
      outage({ maxCapabilityAgeSeconds: 60, maxRevocationAgeSeconds: 180 }),
      "outage_policy_rejected",
    ],
    [v3Claims(), outage({ startedAtEpochSeconds: NOW - 120 }), "outage_policy_rejected"],
  ];

  for (const [claims, policy, code] of cases) {
    await expectCode(verifyV3(claims, policy), code);
  }
});

test("v3 rejects invalid local outage policy instead of silently widening it", async () => {
  for (const policy of [
    outage({ minimumAssurance: 0 }),
    outage({ minimumSessionEpoch: -1 }),
    outage({ minimumPolicyEpoch: -1 }),
    outage({ maxCapabilityAgeSeconds: 301 }),
    outage({ maxRevocationAgeSeconds: 301 }),
    outage({ maxJwksAgeSeconds: 301 }),
    outage({ maxOutageSeconds: 301 }),
    outage({ startedAtEpochSeconds: NOW + 1 }),
    outage({ jwksRefreshedAtEpochSeconds: NOW + 1 }),
  ]) {
    await assert.rejects(
      verifyV3(v3Claims(), policy),
      (error) =>
        error instanceof EdgeCapabilityError &&
        ["invalid_outage_policy", "outage_policy_rejected"].includes(error.code),
    );
  }
});

test("v3 revocation checkpoint is signed provenance and cannot postdate issuance", async () => {
  await expectCode(
    verifyV3(v3Claims({ revocation_checked_at: NOW })),
    "invalid_revocation_checkpoint",
  );
});

test("v3 cannot self-assert verifier-local JWKS or outage freshness", async () => {
  for (const field of [
    { jwks_refreshed_at: NOW },
    { outage_started_at: NOW },
    { max_outage_seconds: 300 },
  ]) {
    await expectCode(
      verifyV3(v3Claims(field)),
      "unknown_field",
    );
  }
});

test("v1 and v2 remain verifiable without outage context", async () => {
  assert.equal((await verify()).zed_edge_capability, 1);
  const v2 = await verify(baseClaims({
    zed_edge_capability: 2,
    sid: "session:abc-123",
    parent_jti: "parent-token-0001",
  }));
  assert.equal(v2.zed_edge_capability, 2);
});
