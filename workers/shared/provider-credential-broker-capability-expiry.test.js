import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialBrokerError,
  requestProviderCredential,
} from "./provider-credential-broker.js";

const NOW = 2_000_000_000;

const plan = {
  provider: "github",
  operation: "read",
  package: "acme/private-lib",
  resource: "acme/private-lib",
  credentialRef: "github-app:zed-pkg:installation-42",
};

const context = {
  principal: "user:test",
  sessionLineage: "session:abc-123",
  parentJti: "parent-token-0001",
  capabilityId: "capability-0001",
  capabilityExpiresAt: NOW + 5,
  requestedTtlSeconds: 300,
  nowEpochSeconds: NOW,
};

function response(expiresAt) {
  return new Response(JSON.stringify({
    version: 1,
    provider: "github",
    kind: "github-app-installation",
    resource: "acme/private-lib",
    credential_ref: "github-app:zed-pkg:installation-42",
    capability_id: "capability-0001",
    access_token: "ghs_test_token_1234567890",
    issued_at: NOW,
    expires_at: expiresAt,
    permissions: { contents: "read", metadata: "read" },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
}

test("broker timestamp skew cannot extend authorization beyond capability expiry", async () => {
  let requestedTtl;
  await assert.rejects(
    requestProviderCredential({
      async fetch(request) {
        requestedTtl = (await request.json()).requested_ttl_seconds;
        // This is within the old requested-TTL + 30s skew check, but it is
        // six seconds beyond the authorizing capability and must fail closed.
        return response(NOW + 11);
      },
    }, plan, context),
    (error) => error instanceof CredentialBrokerError && error.code === "ttl_widened",
  );
  assert.equal(requestedTtl, 5);
});

test("credential ending exactly with capability remains admissible", async () => {
  const credential = await requestProviderCredential({
    async fetch() {
      return response(context.capabilityExpiresAt);
    },
  }, plan, context);
  assert.equal(credential.expiresAt, context.capabilityExpiresAt);
});
