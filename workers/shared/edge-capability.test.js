import assert from "node:assert/strict";
import { before, test } from "node:test";

import {
  EdgeCapabilityError,
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
