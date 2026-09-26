import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  authorizeFallback,
  authorizePrivateArtifact,
  EDGE_FALLBACK_CAPABILITY,
  privateFallbackHeaders,
  verifyEdgeCapability,
} from "./edge-capability.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function fixture(overrides = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const now = 1_800_000_000;
  const claims = {
    iss: "https://api.zpkg.net",
    aud: "zed-edge-fallback",
    sub: "user:123",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 295,
    jti: "capability-123",
    proof: {
      sessionId: "session-123",
      authEpoch: 7,
      policyEpoch: 11,
      reconciliation: "reconciled",
      revocationCheckedAt: now - 10,
    },
    capabilities: [EDGE_FALLBACK_CAPABILITY],
    package: { org: "acme", name: "private-lib" },
    source: { provider: "github", owner: "acme", repo: "private-lib" },
    ...overrides,
  };
  const header = { alg: "RS256", kid: "test-key", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(claims));
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, signed);
  return {
    now,
    token: `${encodedHeader}.${encodedPayload}.${b64url(signature)}`,
    policy: {
      issuer: "https://api.zpkg.net",
      audience: "zed-edge-fallback",
      now,
      keys: [publicJwk],
    },
  };
}

test("a signed capability verifies and binds exact package + GitHub source", async () => {
  const { token, policy } = await fixture();
  const capability = await verifyEdgeCapability(token, policy);
  assert.equal(
    authorizeFallback(capability, {
      capability: EDGE_FALLBACK_CAPABILITY,
      package: { org: "acme", name: "private-lib" },
      source: { provider: "github", owner: "acme", repo: "private-lib" },
    }),
    true,
  );
  assert.equal(
    authorizeFallback(capability, {
      capability: EDGE_FALLBACK_CAPABILITY,
      package: { org: "acme", name: "other-lib" },
      source: { provider: "github", owner: "acme", repo: "private-lib" },
    }),
    false,
  );
});

test("wrong audience, expired, and wrong capability fail closed", async () => {
  {
    const { token, policy } = await fixture({ aud: "something-else" });
    await assert.rejects(() => verifyEdgeCapability(token, policy), /audience mismatch/);
  }
  {
    const { token, policy, now } = await fixture({ exp: 1_799_999_000 });
    policy.now = now;
    await assert.rejects(() => verifyEdgeCapability(token, policy), /token expired/);
  }
  {
    const { token, policy } = await fixture({ capabilities: ["registry:read"] });
    await assert.rejects(() => verifyEdgeCapability(token, policy), /missing fallback capability/);
  }
});

test("private fallback requires reconciled and fresh revocation proof", async () => {
  {
    const { token, policy } = await fixture({
      proof: {
        sessionId: "session-123",
        authEpoch: 7,
        policyEpoch: 11,
        reconciliation: "optimistic",
        revocationCheckedAt: 1_799_999_990,
      },
    });
    await assert.rejects(() => verifyEdgeCapability(token, policy), /not reconciled/);
  }
  {
    const { token, policy } = await fixture({
      proof: {
        sessionId: "session-123",
        authEpoch: 7,
        policyEpoch: 11,
        reconciliation: "reconciled",
        revocationCheckedAt: 1_799_999_000,
      },
    });
    policy.maxRevocationAgeSeconds = 120;
    await assert.rejects(() => verifyEdgeCapability(token, policy), /revocation state is stale/);
  }
});

test("fallback capability lifetime is bounded independently of its signature", async () => {
  const { token, policy } = await fixture({ exp: 1_800_001_000 });
  policy.maxTtlSeconds = 300;
  await assert.rejects(() => verifyEdgeCapability(token, policy), /lifetime exceeds policy/);
});

test("a changed payload cannot reuse the original signature", async () => {
  const { token, policy } = await fixture();
  const parts = token.split(".");
  const changed = {
    iss: "https://api.zpkg.net",
    aud: "zed-edge-fallback",
    sub: "user:123",
    exp: policy.now + 300,
    jti: "forged",
    proof: {
      sessionId: "session-123",
      authEpoch: 7,
      policyEpoch: 11,
      reconciliation: "reconciled",
      revocationCheckedAt: policy.now - 10,
    },
    capabilities: [EDGE_FALLBACK_CAPABILITY],
    package: { org: "acme", name: "admin-lib" },
    source: { provider: "github", owner: "acme", repo: "admin-lib" },
  };
  const forged = `${parts[0]}.${b64url(JSON.stringify(changed))}.${parts[2]}`;
  await assert.rejects(() => verifyEdgeCapability(forged, policy), /invalid signature/);
});

test("provider and source identity cannot be widened after verification", async () => {
  const { token, policy } = await fixture();
  const capability = await verifyEdgeCapability(token, policy);
  assert.equal(
    authorizeFallback(capability, {
      capability: EDGE_FALLBACK_CAPABILITY,
      package: { org: "acme", name: "private-lib" },
      source: { provider: "npm", scope: "@acme", package: "private-lib" },
    }),
    false,
  );
  assert.equal(
    authorizeFallback(capability, {
      capability: EDGE_FALLBACK_CAPABILITY,
      package: { org: "acme", name: "private-lib" },
      source: { provider: "github", owner: "other", repo: "private-lib" },
    }),
    false,
  );
});

test("private artifact authorization is bound to one exact digest", async () => {
  const sha = "a".repeat(64);
  const other = "b".repeat(64);
  const { token, policy } = await fixture({ artifact: { sha256: sha } });
  const capability = await verifyEdgeCapability(token, policy);
  assert.equal(authorizePrivateArtifact(capability, sha), true);
  assert.equal(authorizePrivateArtifact(capability, other), false);
  assert.equal(authorizePrivateArtifact(capability, "not-a-digest"), false);

  const withoutArtifact = await fixture();
  const packageOnly = await verifyEdgeCapability(withoutArtifact.token, withoutArtifact.policy);
  assert.equal(authorizePrivateArtifact(packageOnly, sha), false);
});

test("malformed artifact bindings fail during capability verification", async () => {
  const { token, policy } = await fixture({ artifact: { sha256: "ABC" } });
  await assert.rejects(() => verifyEdgeCapability(token, policy), /invalid artifact\.sha256/);
});

test("provider credentials are explicit and responses are marked private/no-store", () => {
  const headers = privateFallbackHeaders({ provider: "github", token: "example-token" });
  assert.equal(headers.get("authorization"), "Bearer example-token");
  assert.equal(headers.get("cache-control"), "private, no-store");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(privateFallbackHeaders({ provider: "unknown", token: "x" }), null);
  assert.equal(privateFallbackHeaders({ provider: "github", token: "" }), null);
});
